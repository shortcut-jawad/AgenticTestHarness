import "server-only";

import { prisma } from "@/lib/prisma";

export const DEFAULT_EVALUATOR_PROVIDER = "gemini";
export const DEFAULT_EVALUATOR_MODEL = "gemini-2.5-flash";
export const DEFAULT_JUDGE_PROVIDER = "groq";
export const DEFAULT_JUDGE_PRIMARY_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_JUDGE_VERIFIER_MODEL = "openai/gpt-oss-20b";
// Models a free Groq account can use today (Groq retired the Llama models from
// the free tier). Models that fail are skipped by the panel, so a workspace
// with access to more models can add them in its model settings.
export const DEFAULT_JUDGE_PANEL_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
] as const;

export type WorkspaceModelConfigValues = {
  evaluatorProvider: string;
  evaluatorModel: string;
  judgeProvider: string;
  judgePrimaryModel: string;
  judgeVerifierModel: string;
  judgePanelModels: string[];
};

export type EffectiveWorkspaceModelConfig = WorkspaceModelConfigValues & {
  source: "default" | "workspace";
  isCustomized: boolean;
};

export function getDefaultWorkspaceModelConfig(): WorkspaceModelConfigValues {
  return {
    evaluatorProvider: DEFAULT_EVALUATOR_PROVIDER,
    evaluatorModel: DEFAULT_EVALUATOR_MODEL,
    judgeProvider: DEFAULT_JUDGE_PROVIDER,
    judgePrimaryModel: DEFAULT_JUDGE_PRIMARY_MODEL,
    judgeVerifierModel: DEFAULT_JUDGE_VERIFIER_MODEL,
    judgePanelModels: [...DEFAULT_JUDGE_PANEL_MODELS],
  };
}

export async function resolveWorkspaceModelConfig(
  workspaceId?: string | null
): Promise<EffectiveWorkspaceModelConfig> {
  const defaults = getDefaultWorkspaceModelConfig();

  if (!workspaceId) {
    return {
      ...defaults,
      source: "default",
      isCustomized: false,
    };
  }

  const savedConfig = await prisma.workspaceModelConfig.findUnique({
    where: { workspaceId },
    select: {
      evaluatorProvider: true,
      evaluatorModel: true,
      judgeProvider: true,
      judgePrimaryModel: true,
      judgeVerifierModel: true,
      judgePanelModels: true,
    },
  });

  if (!savedConfig) {
    return {
      ...defaults,
      source: "default",
      isCustomized: false,
    };
  }

  const judgePanelModels = savedConfig.judgePanelModels.filter(
    (modelId) => modelId.trim().length > 0
  );

  return {
    evaluatorProvider: savedConfig.evaluatorProvider || defaults.evaluatorProvider,
    evaluatorModel: savedConfig.evaluatorModel || defaults.evaluatorModel,
    judgeProvider: savedConfig.judgeProvider || defaults.judgeProvider,
    judgePrimaryModel: savedConfig.judgePrimaryModel || defaults.judgePrimaryModel,
    judgeVerifierModel: savedConfig.judgeVerifierModel || defaults.judgeVerifierModel,
    judgePanelModels:
      judgePanelModels.length > 0 ? judgePanelModels : [...defaults.judgePanelModels],
    source: "workspace",
    isCustomized: true,
  };
}

export async function getWorkspaceIdForUser(userId: string): Promise<string | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  });

  return membership?.workspaceId ?? null;
}
