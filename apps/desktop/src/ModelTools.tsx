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
      setState({ identity, error: t('请先填写有效的 API 地址、密钥和模型 ID。') });
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
        {tool.busy === 'list' ? t('正在加载模型…') : t('加载模型列表')}
      </button>
      <p className="field-help">
        {t('从当前供应商获取模型，选择后添加到表单；不会自动保存配置。')}
      </p>
      {models && (
        <section className="model-catalog" aria-label={t('可用模型')}>
          <label className="model-search">
            <Search size={15} aria-hidden="true" />
            <input
              className="field"
              aria-label={t('搜索模型')}
              placeholder={t('按名称或模型 ID 搜索')}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <p className="field-help" role="status">
            {t('找到 {0} 个模型', { 0: filtered.length })}
            {filtered.length > 80 && t('，显示前 80 项，请搜索缩小范围。')}
          </p>
          <div className="model-catalog-list">
            {filtered.slice(0, 80).map((model) => {
              const exists = selected.includes(model.id);
              return (
                <button
                  className="model-catalog-item"
                  key={model.id}
                  type="button"
                  aria-label={t(exists ? '已添加 {0}' : '添加 {0}', { 0: model.id })}
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
                  ? '没有匹配的模型，试试其他关键词。'
                  : '供应商没有返回可添加的模型，你仍可手动填写模型 ID。',
              )}
            </p>
          )}
        </section>
      )}
      {added?.identity === tool.identity && (
        <p className="inline-note" role="status">
          {t('已添加 {0}', { 0: added.model.id })} ·{' '}
          {added.model.contextWindow !== undefined
            ? t('已匹配上下文 {0} tokens', { 0: added.model.contextWindow })
            : t('上下文长度未知，请核对默认值或手动填写。')}
          {added.model.source === 'models.dev' && t('（参考 models.dev，可按供应商限制修改）')}
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
          aria-label={t('测试模型 {0}', { 0: index + 1 })}
          disabled={disabled || !!tool.busy || !model.id.trim()}
          onClick={() => run('test')}
        >
          {tool.busy === 'test' && <LoaderCircle size={14} className="model-tool-spinner" />}
          {tool.busy === 'test' ? t('正在测试…') : t('测试模型')}
        </button>
        <button
          className="text-button"
          type="button"
          aria-label={t('匹配模型 {0} 上下文', { 0: index + 1 })}
          disabled={disabled || !!tool.busy || !model.id.trim()}
          onClick={() => run('limits')}
        >
          {tool.busy === 'limits' ? (
            <LoaderCircle size={14} className="model-tool-spinner" />
          ) : (
            <WandSparkles size={14} />
          )}
          {tool.busy === 'limits' ? t('正在匹配…') : t('自动匹配上下文')}
        </button>
      </div>
      {value?.kind === 'test' && (
        <p className="model-test-success" role="status">
          <Check size={14} />
          {t('调用成功 · {0} ms', { 0: value.latencyMs })}
        </p>
      )}
      {value?.kind === 'limits' && (
        <p className="field-help" role="status">
          {value.model.contextWindow === undefined
            ? t('未找到可靠的上下文长度，已有设置保持不变，请手动填写。')
            : t('参考上下文 {0} tokens · {1}', {
                0: value.model.contextWindow,
                1: value.model.source === 'provider' ? t('供应商接口') : 'models.dev',
              })}
          {value.model.source === 'models.dev' &&
            t('。这是公开目录参考值，请以当前供应商限制为准。')}
        </p>
      )}
      <Feedback error={tool.error} />
    </div>
  );
}
