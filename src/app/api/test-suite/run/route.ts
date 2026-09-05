import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { getScopedUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSuiteForUser, recordSuiteRun, type TestRunToolCall } from '@/lib/testSuiteStore';
import { getMockToolCatalog, type MockToolDefinition } from '@/lib/mockToolCatalog';
import { getConfiguredOpenAIModels } from '@/lib/openaiModels';
import { getActiveOpenAIKey, getActiveOpenAIKeyMetadata, rotateOpenAIKey } from '@/lib/openaiKeys';
import { BudgetTracker, DEFAULT_BUDGETS, type BudgetConfig } from '@/lib/budgetValidator';
import { executeMockTool } from '@/lib/mockToolExecution';

const RunRequestSchema = z.object({
  temperature: z.number().min(0).max(1).optional(),
  maxIterations: z.number().int().min(1).max(8).optional(),
  model: z.string().min(1).optional(),
  budget: z.object({
    maxBudget: z.number().min(0.01).optional(),
    costPerMillionTokens: z.number().min(0.001).optional(),
  }).optional(),
});

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isRateLimitOrQuotaError(err: unknown): boolean {
  const status = (err as { status?: number; response?: { status?: number } } | undefined)?.status
    ?? (err as { response?: { status?: number } } | undefined)?.response?.status;
  if (status === 429) return true;

  const code = (err as { code?: string; error?: { code?: string } } | undefined)?.code
    ?? (err as { error?: { code?: string } } | undefined)?.error?.code;
  if (code === 'insufficient_quota' || code === 'rate_limit_exceeded') return true;

  const message = (err as Error | undefined)?.message ?? '';
  return /\b429\b/.test(message) || /insufficient_quota|rate.?limit/i.test(message);
}

type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

function buildParameterJsonSchema(param: MockToolDefinition['parameters'][number]) {
  const base: Record<string, unknown> = {
    description: param.description,
  };

  switch (param.type) {
    case 'number':
      base.type = 'number';
      break;
    default:
      base.type = 'string';
      if (param.type === 'date') {
        base.format = 'date';
      }
      break;
  }

  if (param.example) {
    base.examples = [param.example];
  }

  return base;
}

function buildToolJsonSchema(def: MockToolDefinition) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of def.parameters) {
    properties[param.name] = buildParameterJsonSchema(param);
    if (param.required) {
      required.push(param.name);
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

function mapToOpenAITool(def: MockToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: {
      name: def.id,
      description: def.description,
      parameters: buildToolJsonSchema(def),
    },
  };
}

function stringifyMessageContent(content: AIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if ('text' in part) return part.text;
        return JSON.stringify(part);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

const encoder = new TextEncoder();

async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  payload: Record<string, unknown>,
) {
  try {
    await writer.write(encoder.encode(`${JSON.stringify(payload)}\n`));
  } catch (err) {
    console.error('Failed to stream run event', err);
  }
}

async function closeWriter(writer: WritableStreamDefaultWriter<Uint8Array>) {
  try {
    await writer.close();
  } catch (err) {
    console.error('Failed to close run stream', err);
  }
}

export async function POST(req: Request) {
  const user = await getScopedUser('write');
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);

  let options: z.infer<typeof RunRequestSchema> = {};
  try {
    const rawBody = await req.text();
    if (rawBody) {
      const parsed = JSON.parse(rawBody);
      options = RunRequestSchema.parse(parsed);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request payload', issues: err.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Unable to parse request payload' }, { status: 400 });
  }

  let configuredModels: ReturnType<typeof getConfiguredOpenAIModels>;
  try {
    configuredModels = getConfiguredOpenAIModels();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const requestedModel = options.model?.trim();
  if (requestedModel && !configuredModels.models.includes(requestedModel)) {
    return NextResponse.json({ error: `Model "${requestedModel}" is not configured.` }, { status: 400 });
  }

  const selectedModel = requestedModel ?? configuredModels.defaultModel;

  const suite = getSuiteForUser(user.id);
  const toolDefs = getMockToolCatalog();
  const toolMap = new Map(toolDefs.map((def) => [def.id, def]));
  const openaiTools = toolDefs.map(mapToOpenAITool);

  function buildModelWithTools(apiKey: string) {
    const model = new ChatOpenAI({
      apiKey,
      model: selectedModel,
      temperature: options.temperature ?? 0.3,
      configuration: {
        baseURL: requireEnv('OPENAI_BASE_URL'),
      },
    });

    // ----------------------------------------------------------------------
    // FIX: We explicitly disable the eslint rule for 'any' just for this block
    // so we can satisfy the Compiler (which demands 'bind' exist) and the Linter.
    // ----------------------------------------------------------------------

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flexibleModel = model as any;

    return flexibleModel.bindTools
      ? flexibleModel.bindTools(openaiTools)
      : flexibleModel.bind({ tools: openaiTools });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let modelWithTools: any;
  try {
    modelWithTools = buildModelWithTools(getActiveOpenAIKey());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  let workspaceTools: { id: string; name: string; description: string | null }[] = [];
  try {
    const membership = await prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true },
    });
    if (membership) {
      workspaceTools = await prisma.tool.findMany({
        where: { workspaceId: membership.workspaceId },
        select: { id: true, name: true, description: true },
        orderBy: { createdAt: 'desc' },
      });
    }
  } catch (err) {
    console.error('Failed to load workspace tools', err);
  }

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  // Initialize budget tracker
  const budgetConfig: BudgetConfig = options.budget?.maxBudget 
    ? {
        maxBudget: options.budget.maxBudget,
        costPerMillionTokens: options.budget.costPerMillionTokens ?? 0.1,
      }
    : DEFAULT_BUDGETS.DAILY_RUN; // Default to $25 budget if not specified

  const budgetTracker = new BudgetTracker(budgetConfig);

  async function invokeModelWithRotation(messages: BaseMessage[], writer: WritableStreamDefaultWriter<Uint8Array>) {
    const totalKeys = getActiveOpenAIKeyMetadata().total;
    let lastError: unknown;

    for (let attempt = 0; attempt < totalKeys; attempt += 1) {
      try {
        return await modelWithTools.invoke(messages);
      } catch (err) {
        lastError = err;
        if (!isRateLimitOrQuotaError(err) || attempt === totalKeys - 1) {
          throw err;
        }

        const { metadata, rotated } = rotateOpenAIKey();
        if (!rotated) {
          throw err;
        }

        modelWithTools = buildModelWithTools(getActiveOpenAIKey());
        await writeEvent(writer, {
          type: 'key-rotated',
          activeKeyEnvVar: metadata.envVar,
          activeKeyIndex: metadata.index,
          totalApiKeys: metadata.total,
          reason: (err as Error).message ?? 'Rate limit or quota error.',
        });
      }
    }

    throw lastError;
  }

  const streamRun = async () => {
    const transcript: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[] = [];
    const toolLogs: TestRunToolCall[] = [];

    const messages: BaseMessage[] = [
      new SystemMessage(suite.systemPrompt), 
      new HumanMessage(suite.userPrompt)
    ];

    transcript.push({ role: 'system', content: suite.systemPrompt });
    transcript.push({ role: 'user', content: suite.userPrompt });

    const maxIterations = options?.maxIterations ?? 6;
    const runStartedAt = new Date();
    let lastAssistantMessage: AIMessage | null = null;
    let status: 'success' | 'partial' | 'failed' | 'error' = 'partial';
    let errorSummary: string | null = null;

    try {
      await writeEvent(writer, {
        type: 'run-start',
        suiteId: suite.id,
        startedAt: runStartedAt.toISOString(),
        tools: toolDefs,
        budget: {
          maxBudget: budgetConfig.maxBudget,
          costPerMillionTokens: budgetConfig.costPerMillionTokens,
        },
      });

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        // Validate budget before making model call
        try {
          budgetTracker.validateCall(messages, 500); // Estimate 500 tokens for response
        } catch (budgetError) {
          status = 'error';
          errorSummary = (budgetError as Error).message;
          transcript.push({ role: 'assistant', content: `Run aborted due to budget limit: ${errorSummary}` });
          await writeEvent(writer, {
            type: 'run-error',
            error: errorSummary,
            budgetExceeded: true,
            budgetUsage: budgetTracker.getUsage(),
          });
          break;
        }

        // Make the model call
        const aiMessage = await invokeModelWithRotation(messages, writer);
        lastAssistantMessage = aiMessage;
        const content = stringifyMessageContent(aiMessage.content);
        
        // Record token usage after the call
        budgetTracker.recordMessageUsage(messages, content);
        
        transcript.push({ role: 'assistant', content });
        messages.push(aiMessage);

        // Send budget update event
        await writeEvent(writer, {
          type: 'budget-update',
          usage: budgetTracker.getUsage(),
          summary: budgetTracker.getSummary(),
        });

        if (!aiMessage.tool_calls?.length) {
          status = 'success';
          break;
        }

        for (const call of aiMessage.tool_calls) {
          const toolDef = toolMap.get(call.name ?? '');
          const resolvedToolId = toolDef?.id ?? call.name ?? 'unknown';
          const resolvedToolName = toolDef?.name ?? call.name ?? 'Unknown Tool';
          const toolCallId = call.id ?? randomUUID();

          let callInput: Record<string, unknown> = {};
          try {
            if (typeof call.args === 'string') {
              callInput = JSON.parse(call.args);
            } else {
              callInput = (call.args ?? {}) as Record<string, unknown>;
            }
          } catch (err) {
            callInput = {};
            transcript.push({ role: 'tool', content: `Failed to parse arguments for ${call.name}: ${(err as Error).message}` });
          }

          const toolStartedAt = new Date();
          await writeEvent(writer, {
            type: 'tool-start',
            toolCallId,
            toolId: resolvedToolId,
            toolName: resolvedToolName,
            input: callInput,
            startedAt: toolStartedAt.toISOString(),
          });

          try {
            if (!toolDef) {
              throw new Error(`Tool ${call.name} is not available.`);
            }

            const { latency, data } = await executeMockTool(toolDef, url.origin, callInput);
            const toolCompletedAt = new Date();
            const duration = toolCompletedAt.getTime() - toolStartedAt.getTime();

            toolLogs.push({
              toolId: toolDef.id,
              toolName: toolDef.name,
              input: callInput,
              output: { latencyMs: latency, data },
              startedAt: toolStartedAt,
              completedAt: toolCompletedAt,
              durationMs: duration,
              success: true,
            });

            const toolMessageContent = JSON.stringify({ latencyMs: latency, data }, null, 2);
            transcript.push({ role: 'tool', content: `${toolDef.name}: ${toolMessageContent}` });
            messages.push(new ToolMessage(toolMessageContent, call.id ?? toolDef.id));

            await writeEvent(writer, {
              type: 'tool-end',
              toolCallId,
              toolId: resolvedToolId,
              toolName: resolvedToolName,
              status: 'success',
              output: { latencyMs: latency, data },
              durationMs: duration,
              completedAt: toolCompletedAt.toISOString(),
            });
          } catch (err) {
            const toolCompletedAt = new Date();
            const duration = toolCompletedAt.getTime() - toolStartedAt.getTime();
            const message = (err as Error).message ?? 'Tool execution failed.';

            toolLogs.push({
              toolId: resolvedToolId,
              toolName: resolvedToolName,
              input: callInput,
              output: null,
              startedAt: toolStartedAt,
              completedAt: toolCompletedAt,
              durationMs: duration,
              success: false,
              errorMessage: message,
            });

            transcript.push({ role: 'tool', content: `Error from ${resolvedToolName}: ${message}` });
            messages.push(new ToolMessage(`Error: ${message}`, call.id ?? call.name ?? 'tool-error'));

            await writeEvent(writer, {
              type: 'tool-end',
              toolCallId,
              toolId: resolvedToolId,
              toolName: resolvedToolName,
              status: 'error',
              errorMessage: message,
              durationMs: duration,
              completedAt: toolCompletedAt.toISOString(),
            });
          }
        }
      }
    } catch (err) {
      status = 'error';
      errorSummary = (err as Error).message ?? 'Unknown error during execution.';
      const isBudgetError = errorSummary.includes('Budget exceeded');
      
      transcript.push({ role: 'assistant', content: `Run aborted: ${errorSummary}` });
      await writeEvent(writer, {
        type: 'run-error',
        error: errorSummary,
        budgetExceeded: isBudgetError,
        budgetUsage: budgetTracker.getUsage(),
      });
    } finally {
      const runCompletedAt = new Date();
      const summaryContent =
        lastAssistantMessage ? stringifyMessageContent(lastAssistantMessage.content) : errorSummary ?? 'No response produced.';

      const budgetUsage = budgetTracker.getUsage();
      
      const runRecord = recordSuiteRun(user.id, {
        suiteId: suite.id,
        status,
        startedAt: runStartedAt,
        completedAt: runCompletedAt,
        summary: summaryContent,
        transcript,
        toolCalls: toolLogs,
        metrics: {
          toolCalls: toolLogs.length,
          durationMs: runCompletedAt.getTime() - runStartedAt.getTime(),
          totalTokens: budgetUsage.totalTokens,
          totalCost: budgetUsage.totalCost,
        },
        rawModelOutput: lastAssistantMessage,
      });

      await writeEvent(writer, {
        type: 'run-complete',
        run: {
          ...runRecord,
          startedAt: runRecord.startedAt.toISOString(),
          completedAt: runRecord.completedAt.toISOString(),
          toolCalls: runRecord.toolCalls.map((call) => ({
            ...call,
            startedAt: call.startedAt.toISOString(),
            completedAt: call.completedAt.toISOString(),
          })),
        },
        mockTools: toolDefs,
        workspaceTools,
        budgetUsage,
        budgetSummary: budgetTracker.getSummary(),
      });

      await closeWriter(writer);
    }
  };

  streamRun().catch(async (err) => {
    console.error('Test suite run failed', err);
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
