import {
  type DiscoveredModel,
  isModelInspection,
  isModelInspectionRequest,
  type ModelDefinition,
  type ModelInspection,
  type ModelInspectionRequest,
} from '@daban/protocol';
import { Check, Download, LoaderCircle, Plus, Search, WandSparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';

type Query = Pick<ModelInspectionRequest, 'connection' | 'revision' | 'apiKey'>;
function useInspection(query: Query, enabled: boolean, scope = '') {
  const runtime = useRuntime();
  const identity = JSON.stringify([query, scope]);
  const current = useRef(identity);
  current.current = identity;
  const active = useRef(enabled);
  active.current = enabled;
  const sequence = useRef(0);
  const inFlight = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [state, setState] = useState<{
    identity: string;
    busy?: string;
    error?: string;
    result?: ModelInspection;
  }>({ identity });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const live = state.identity === identity ? state : undefined;
  async function run(kind: ModelInspectionRequest['kind'], model?: string) {
    if (!enabled || inFlight.current === identity) return;
    const input: ModelInspectionRequest =
      kind === 'list' ? { ...query, kind } : { ...query, kind, model: model ?? '' };
    if (!isModelInspectionRequest(input)) {
      setState({ identity, error: t('models.enterValidApiUrlKeyModelId') });
      return;
    }
    const request = ++sequence.current;
    inFlight.current = identity;
    const valid = () =>
      mounted.current &&
      active.current &&
      current.current === identity &&
      sequence.current === request;
    setState({ identity, busy: kind });
    try {
      const result = await runtime.command<ModelInspection>({ type: 'model.inspect', input });
      if (
        !isModelInspection(result) ||
        result.kind !== kind ||
        result.revision !== input.revision ||
        (result.kind === 'test' && result.model !== model) ||
        (result.kind === 'limits' && result.model.id !== model)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      // Route, secret or row changes invalidate an in-flight result, even if its network request succeeds.
      if (!valid()) return;
      setState({ identity, result });
      return result;
    } catch (error) {
      if (valid()) setState({ identity, error: runtimeError(error) });
    } finally {
      if (sequence.current === request) {
        inFlight.current = undefined;
        if (mounted.current)
          setState((state) =>
            state.identity === identity && state.busy ? { ...state, busy: undefined } : state,
          );
      }
    }
  }
  return { identity, busy: live?.busy, error: live?.error, result: live?.result, run };
}
function Feedback({ error }: { error?: string }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}
export function ModelCatalog({
  query,
  disabled,
  selected,
  onAdd,
}: {
  query: Query;
  disabled: boolean;
  selected: string[];
  onAdd: (model: DiscoveredModel) => unknown;
}) {
  useLocale();
  const tool = useInspection(query, !disabled);
  const [catalog, setCatalog] = useState<{ identity: string; models: DiscoveredModel[] }>();
  const [text, setText] = useState('');
  const [added, setAdded] = useState<{ identity: string; model: DiscoveredModel }>();
  const models = catalog?.identity === tool.identity ? catalog.models : undefined;
  const filtered =
    models?.filter((model) =>
      `${model.id} ${model.name}`.toLowerCase().includes(text.toLowerCase().trim()),
    ) ?? [];
  async function load() {
    const result = await tool.run('list');
    if (result?.kind === 'list') {
      setCatalog({ identity: tool.identity, models: result.models });
      setText('');
      setAdded(undefined);
    }
  }
  async function add(model: DiscoveredModel) {
    let entry = model;
    if (entry.contextWindow === undefined) {
      const result = await tool.run('limits', entry.id);
      if (result?.kind !== 'limits') return;
      entry = result.model;
    }
    onAdd(entry);
    setAdded({ identity: tool.identity, model: entry });
  }
  return (
    <div className="model-discovery">
      <button className="secondary" type="button" disabled={disabled || !!tool.busy} onClick={load}>
        {tool.busy === 'list' ? (
          <LoaderCircle size={15} className="model-tool-spinner" />
        ) : (
          <Download size={15} />
        )}
        {tool.busy === 'list' ? t('models.loadingModels') : t('models.loadList')}
      </button>
      <p className="field-help">{t('models.fetchModelsProviderChooseWhichAddConfiguration')}</p>
      {models && (
        <section className="model-catalog" aria-label={t('models.availableModels')}>
          <label className="model-search">
            <Search size={15} aria-hidden="true" />
            <input
              className="field"
              aria-label={t('models.searchModels')}
              placeholder={t('models.searchNameModelId')}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <p className="field-help" role="status">
            {t('models.modelsFound', { 0: filtered.length })}
            {filtered.length > 80 && t('models.showingFirstSearchNarrowList')}
          </p>
          <div className="model-catalog-list">
            {filtered.slice(0, 80).map((model) => {
              const exists = selected.includes(model.id);
              return (
                <button
                  className="model-catalog-item"
                  key={model.id}
                  type="button"
                  aria-label={t(exists ? 'models.added' : 'models.add', { 0: model.id })}
                  disabled={disabled || !!tool.busy || exists || selected.length >= 50}
                  onClick={() => add(model)}
                >
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.id}</small>
                  </span>
                  {exists ? <Check size={16} /> : <Plus size={16} />}
                </button>
              );
            })}
          </div>
          {!filtered.length && (
            <p className="inline-note">
              {t(
                models.length
                  ? 'models.noMatchingModelsTryAnotherSearch'
                  : 'models.providerReturnedNoModelsAddCanStill',
              )}
            </p>
          )}
        </section>
      )}
      {added?.identity === tool.identity && (
        <p className="inline-note" role="status">
          {t('models.added', { 0: added.model.id })} ·{' '}
          {added.model.contextWindow !== undefined
            ? t('models.matchedContextTokens', { 0: added.model.contextWindow })
            : t('models.contextLengthUnknownCheckDefaultEnterManually')}
          {added.model.source === 'models.dev' && t('models.modelsDevAdjustProviderSLimits')}
        </p>
      )}
      <Feedback error={tool.error} />
    </div>
  );
}
export function ModelInspector({
  query,
  model,
  index,
  disabled,
  onMatch,
}: {
  query: Query;
  model: ModelDefinition;
  index: number;
  disabled: boolean;
  onMatch: (model: DiscoveredModel) => unknown;
}) {
  useLocale();
  const tool = useInspection(query, !disabled, model.id);
  const identity = tool.identity;
  const current = useRef(model);
  current.current = model;
  const [result, setResult] = useState<{ identity: string; value: ModelInspection }>();
  async function run(kind: 'limits' | 'test') {
    setResult(undefined);
    const value = await tool.run(kind, model.id);
    if (!value) return;
    // A manual limits edit made during lookup is newer intent than the lookup result.
    if (
      kind === 'limits' &&
      (current.current.contextWindow !== model.contextWindow ||
        current.current.maxTokens !== model.maxTokens)
    )
      return;
    if (value.kind === 'limits' && value.model.contextWindow !== undefined) onMatch(value.model);
    setResult({ identity, value });
  }
  const value = result?.identity === identity ? result.value : undefined;
  return (
    <div className="model-inspector">
      <div className="model-inspector-actions">
        <button
          className="text-button"
          type="button"
          aria-label={t('models.testModel', { 0: index + 1 })}
          disabled={disabled || !!tool.busy || !model.id.trim()}
          onClick={() => run('test')}
        >
          {tool.busy === 'test' && <LoaderCircle size={14} className="model-tool-spinner" />}
          {tool.busy === 'test' ? t('models.testing') : t('models.test')}
        </button>
        <button
          className="text-button"
          type="button"
          aria-label={t('models.matchContextModel', { 0: index + 1 })}
          disabled={disabled || !!tool.busy || !model.id.trim()}
          onClick={() => run('limits')}
        >
          {tool.busy === 'limits' ? (
            <LoaderCircle size={14} className="model-tool-spinner" />
          ) : (
            <WandSparkles size={14} />
          )}
          {tool.busy === 'limits' ? t('models.matching') : t('models.matchContext')}
        </button>
      </div>
      {value?.kind === 'test' && (
        <p className="model-test-success" role="status">
          <Check size={14} />
          {t('models.callSucceededMs', { 0: value.latencyMs })}
        </p>
      )}
      {value?.kind === 'limits' && (
        <p className="field-help" role="status">
          {value.model.contextWindow === undefined
            ? t('models.noReliableContextLengthFoundExistingSettings')
            : t('models.referenceContextTokens', {
                0: value.model.contextWindow,
                1: value.model.source === 'provider' ? t('models.providerApi') : 'models.dev',
              })}
          {value.model.source === 'models.dev' &&
            t('models.publicCatalogReferenceProviderSLimitsTake')}
        </p>
      )}
      <Feedback error={tool.error} />
    </div>
  );
}
