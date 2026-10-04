'use client';

import { useEffect, useMemo, useState } from 'react';

type ModelsResponse = {
  source: 'default' | 'workspace';
  isCustomized: boolean;
  evaluator: {
    provider: string;
    model: string;
  };
  judge: {
    provider: string;
    primaryModel: string;
    verifierModel: string;
    panelModels: string[];
  };
  defaults: {
    evaluatorProvider: string;
    evaluatorModel: string;
    judgeProvider: string;
    judgePrimaryModel: string;
    judgeVerifierModel: string;
    judgePanelModels: string[];
  };
};

type ApiError = { field?: string; error?: string };

export default function ModelSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [source, setSource] = useState<'default' | 'workspace'>('default');
  const [isCustomized, setIsCustomized] = useState(false);
  const [evaluatorProvider, setEvaluatorProvider] = useState('gemini');
  const [judgeProvider, setJudgeProvider] = useState('groq');
  const [evaluatorModel, setEvaluatorModel] = useState('');
  const [judgePrimaryModel, setJudgePrimaryModel] = useState('');
  const [judgeVerifierModel, setJudgeVerifierModel] = useState('');
  const [judgePanelModelsText, setJudgePanelModelsText] = useState('');
  const [defaults, setDefaults] = useState<ModelsResponse['defaults'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const normalizedPanelPreview = useMemo(
    () =>
      judgePanelModelsText
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    [judgePanelModelsText]
  );

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const res = await fetch('/api/account/models', {
          credentials: 'include',
          cache: 'no-store',
        });

        const data = (await res.json().catch(() => null)) as ModelsResponse | null;
        if (!alive) {
          return;
        }

        if (!res.ok || !data) {
          setError('Failed to load model settings.');
          return;
        }

        setSource(data.source);
        setIsCustomized(data.isCustomized);
        setEvaluatorProvider(data.evaluator.provider);
        setJudgeProvider(data.judge.provider);
        setEvaluatorModel(data.evaluator.model);
        setJudgePrimaryModel(data.judge.primaryModel);
        setJudgeVerifierModel(data.judge.verifierModel);
        setJudgePanelModelsText(data.judge.panelModels.join('\n'));
        setDefaults(data.defaults);
      } catch {
        if (alive) setError('Failed to load model settings.');
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const judgePanelModels = judgePanelModelsText
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);

      const res = await fetch('/api/account/models', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evaluatorModel,
          judgePrimaryModel,
          judgeVerifierModel,
          judgePanelModels,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as
        | (ModelsResponse & { message?: string })
        | ApiError;

      if (!res.ok) {
        const errorMessage = 'error' in data ? data.error : undefined;
        setError(errorMessage ?? 'Failed to save model settings.');
        return;
      }

      const savedData = data as ModelsResponse & { message?: string };
      setSource(savedData.source);
      setIsCustomized(savedData.isCustomized);
      setEvaluatorProvider(savedData.evaluator.provider);
      setJudgeProvider(savedData.judge.provider);
      setEvaluatorModel(savedData.evaluator.model);
      setJudgePrimaryModel(savedData.judge.primaryModel);
      setJudgeVerifierModel(savedData.judge.verifierModel);
      setJudgePanelModelsText(savedData.judge.panelModels.join('\n'));
      setDefaults(savedData.defaults);
      setSuccess(savedData.message ?? 'Model settings saved.');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function applyDefaults() {
    if (!defaults) return;
    setEvaluatorModel(defaults.evaluatorModel);
    setJudgePrimaryModel(defaults.judgePrimaryModel);
    setJudgeVerifierModel(defaults.judgeVerifierModel);
    setJudgePanelModelsText(defaults.judgePanelModels.join('\n'));
    setError(null);
    setSuccess(null);
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">Models</h3>
          <p className="mt-1 text-sm text-zinc-400">
            Review the evaluator and judge models used for this workspace and update them here.
          </p>
        </div>
        <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
          {loading ? 'Loading...' : source === 'workspace' ? 'Workspace override' : 'Default values'}
        </span>
      </div>

      <form onSubmit={onSubmit} className="space-y-8">
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-zinc-200">Evaluator</h4>
              <p className="text-xs text-zinc-500">Provider: {evaluatorProvider}</p>
            </div>
          </div>

          <div>
            <label htmlFor="evaluator-model" className="block text-sm text-zinc-400">
              Evaluator model
            </label>
            <input
              id="evaluator-model"
              type="text"
              value={evaluatorModel}
              onChange={(event) => {
                setEvaluatorModel(event.target.value);
                if (error) setError(null);
                if (success) setSuccess(null);
              }}
              placeholder="gemini-2.5-flash"
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
              disabled={loading || submitting}
            />
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-zinc-200">Judge</h4>
            <p className="text-xs text-zinc-500">Provider: {judgeProvider}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="judge-primary-model" className="block text-sm text-zinc-400">
                Primary judge model
              </label>
              <input
                id="judge-primary-model"
                type="text"
                value={judgePrimaryModel}
                onChange={(event) => {
                  setJudgePrimaryModel(event.target.value);
                  if (error) setError(null);
                  if (success) setSuccess(null);
                }}
                placeholder="openai/gpt-oss-120b"
                className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
                disabled={loading || submitting}
              />
            </div>

            <div>
              <label htmlFor="judge-verifier-model" className="block text-sm text-zinc-400">
                Verifier model
              </label>
              <input
                id="judge-verifier-model"
                type="text"
                value={judgeVerifierModel}
                onChange={(event) => {
                  setJudgeVerifierModel(event.target.value);
                  if (error) setError(null);
                  if (success) setSuccess(null);
                }}
                placeholder="openai/gpt-oss-20b"
                className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
                disabled={loading || submitting}
              />
            </div>
          </div>

          <div>
            <label htmlFor="judge-panel-models" className="block text-sm text-zinc-400">
              Judge panel models
            </label>
            <textarea
              id="judge-panel-models"
              value={judgePanelModelsText}
              onChange={(event) => {
                setJudgePanelModelsText(event.target.value);
                if (error) setError(null);
                if (success) setSuccess(null);
              }}
              placeholder="One model per line"
              rows={7}
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
              disabled={loading || submitting}
            />
            <p className="mt-2 text-xs text-zinc-500">
              One model ID per line. The panel runs in the order shown here.
            </p>
          </div>
        </section>

        {normalizedPanelPreview.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
              Active judge panel
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {normalizedPanelPreview.map((modelName) => (
                <span
                  key={modelName}
                  className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                >
                  {modelName}
                </span>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {success && <p className="text-sm text-emerald-400">{success}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading || submitting}
            className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-60"
          >
            {submitting ? 'Saving...' : 'Save models'}
          </button>
          <button
            type="button"
            onClick={applyDefaults}
            disabled={loading || submitting || !defaults}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800/70 disabled:opacity-60"
          >
            Reset form to defaults
          </button>
          {!loading && (
            <span className="text-xs text-zinc-500">
              {isCustomized ? 'Saved workspace-specific models are active.' : 'Using default model settings.'}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
