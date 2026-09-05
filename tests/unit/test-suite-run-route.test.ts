import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';

const invokeMock = vi.fn();

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    bindTools: vi.fn().mockReturnValue({
      invoke: (...args: unknown[]) => invokeMock(...args),
    }),
  })),
}));

vi.mock('@/lib/openaiModels', () => ({
  getConfiguredOpenAIModels: () => ({
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
  }),
}));

const openaiKeysMocks = vi.hoisted(() => ({
  getActiveOpenAIKey: vi.fn(() => 'sk-test'),
  getActiveOpenAIKeyMetadata: vi.fn(() => ({ envVar: 'OPENAI_API_KEY', index: 0, total: 1 })),
  rotateOpenAIKey: vi.fn(() => ({
    metadata: { envVar: 'OPENAI_API_KEY', index: 0, total: 1 },
    rotated: false,
  })),
}));

vi.mock('@/lib/openaiKeys', () => openaiKeysMocks);

vi.mock('@/lib/auth', () => ({
  getScopedUser: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  membershipFindFirst: vi.fn(),
  toolFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    membership: { findFirst: (...a: unknown[]) => prismaMocks.membershipFindFirst(...a) },
    tool: { findMany: (...a: unknown[]) => prismaMocks.toolFindMany(...a) },
  },
}));

import { getScopedUser } from '@/lib/auth';
import { POST } from '@/app/api/test-suite/run/route';

async function readNdjsonStream(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Record<string, unknown>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      events.push(JSON.parse(t) as Record<string, unknown>);
    }
  }
  const last = buffer.trim();
  if (last) events.push(JSON.parse(last) as Record<string, unknown>);
  return events;
}

describe('POST /api/test-suite/run (mocked model)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getScopedUser).mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Tester',
      status: 'ACTIVE',
    } as Awaited<ReturnType<typeof getScopedUser>>);
    prismaMocks.membershipFindFirst.mockResolvedValue({ workspaceId: 'ws-1' });
    prismaMocks.toolFindMany.mockResolvedValue([]);
    openaiKeysMocks.getActiveOpenAIKey.mockReturnValue('sk-test');
    openaiKeysMocks.getActiveOpenAIKeyMetadata.mockReturnValue({
      envVar: 'OPENAI_API_KEY',
      index: 0,
      total: 1,
    });
    openaiKeysMocks.rotateOpenAIKey.mockReturnValue({
      metadata: { envVar: 'OPENAI_API_KEY', index: 0, total: 1 },
      rotated: false,
    });
    invokeMock
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            name: 'mock-flight-search',
            args: { origin: 'SFO', destination: 'NRT', date: '2025-11-14' },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'Planned.', tool_calls: [] });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const u = typeof input === 'string' ? input : input.toString();
        if (u.includes('/api/mock/flights')) {
          return new Response(
            JSON.stringify({
              flights: [{ flightNumber: 'PH217' }],
              query: { origin: 'SFO', destination: 'NRT' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    invokeMock.mockReset();
  });

  it('streams run-start, tool-start, tool-end, and run-complete with success', async () => {
    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const events = await readNdjsonStream(res.body!);
    const types = events.map((e) => e.type as string);
    expect(types).toContain('run-start');
    expect(types).toContain('tool-start');
    expect(types).toContain('tool-end');
    expect(types).toContain('run-complete');

    const complete = events.find((e) => e.type === 'run-complete') as
      | { run?: { status?: string } }
      | undefined;
    expect(complete?.run?.status).toBe('success');
  });

  it('marks run partial when maxIterations exhausted with continued tool calls', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => ({
      content: '',
      tool_calls: [
        {
          id: 'c1',
          name: 'mock-flight-search',
          args: { origin: 'SFO', destination: 'NRT' },
        },
      ],
    }));

    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxIterations: 2 }),
    });

    const res = await POST(req);
    const events = await readNdjsonStream(res.body!);
    const complete = events.find((e) => e.type === 'run-complete') as
      | { run?: { status?: string } }
      | undefined;
    expect(complete?.run?.status).toBe('partial');
    expect(invokeMock).toHaveBeenCalled();
  });

  it('records tool error for unknown tool name then can finish', async () => {
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{ id: 'c1', name: 'not-a-catalog-tool', args: {} }],
      })
      .mockResolvedValueOnce({ content: 'Stopped.', tool_calls: [] });

    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    const events = await readNdjsonStream(res.body!);
    const toolEnds = events.filter((e) => e.type === 'tool-end') as { status?: string }[];
    expect(toolEnds.some((e) => e.status === 'error')).toBe(true);
  });

  it('emits run-error with budgetExceeded before model when budget is impossibly small', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ content: 'never', tool_calls: [] });

    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        budget: { maxBudget: 0.01, costPerMillionTokens: 1_000_000 },
      }),
    });

    const res = await POST(req);
    const events = await readNdjsonStream(res.body!);
    const err = events.find((e) => e.type === 'run-error') as
      | { budgetExceeded?: boolean }
      | undefined;
    expect(err?.budgetExceeded).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('auto-rotates to the next key and retries after a 429 quota error', async () => {
    invokeMock.mockReset();
    const quotaError = Object.assign(new Error('429 You have no credits remaining.'), { status: 429 });
    invokeMock
      .mockRejectedValueOnce(quotaError)
      .mockResolvedValueOnce({ content: 'Planned after rotation.', tool_calls: [] });

    openaiKeysMocks.getActiveOpenAIKeyMetadata.mockReturnValue({
      envVar: 'OPENAI_API_KEY',
      index: 0,
      total: 3,
    });
    openaiKeysMocks.rotateOpenAIKey.mockReturnValue({
      metadata: { envVar: 'OPENAI_API_KEY_1', index: 1, total: 3 },
      rotated: true,
    });

    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    const events = await readNdjsonStream(res.body!);
    const types = events.map((e) => e.type as string);

    expect(types).toContain('key-rotated');
    expect(types).not.toContain('run-error');
    expect(invokeMock).toHaveBeenCalledTimes(2);

    const rotated = events.find((e) => e.type === 'key-rotated') as
      | { activeKeyEnvVar?: string; activeKeyIndex?: number; totalApiKeys?: number }
      | undefined;
    expect(rotated?.activeKeyEnvVar).toBe('OPENAI_API_KEY_1');
    expect(rotated?.activeKeyIndex).toBe(1);
    expect(rotated?.totalApiKeys).toBe(3);

    const complete = events.find((e) => e.type === 'run-complete') as
      | { run?: { status?: string } }
      | undefined;
    expect(complete?.run?.status).toBe('success');
  });

  it('fails the run once all rotated keys are exhausted on repeated 429 errors', async () => {
    invokeMock.mockReset();
    const quotaError = Object.assign(new Error('429 You have no credits remaining.'), { status: 429 });
    invokeMock.mockRejectedValue(quotaError);

    openaiKeysMocks.getActiveOpenAIKeyMetadata.mockReturnValue({
      envVar: 'OPENAI_API_KEY',
      index: 0,
      total: 2,
    });
    openaiKeysMocks.rotateOpenAIKey.mockReturnValue({
      metadata: { envVar: 'OPENAI_API_KEY_1', index: 1, total: 2 },
      rotated: true,
    });

    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    const events = await readNdjsonStream(res.body!);
    const types = events.map((e) => e.type as string);

    expect(types).toContain('key-rotated');
    expect(types).toContain('run-error');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('parses string tool args invalid JSON without throwing', async () => {
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          {
            id: 'c1',
            name: 'mock-flight-search',
            args: 'not-valid-json{{{',
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'Done.', tool_calls: [] });

    const req = new Request('http://localhost:3000/api/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    const events = await readNdjsonStream(res.body!);
    expect(events.some((e) => e.type === 'run-complete')).toBe(true);
  });
});
