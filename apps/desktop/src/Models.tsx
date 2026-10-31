import {
  type DeepSeekModel,
  isDeepSeekModel,
  isModelKey,
  type ModelCheck,
  type ModelUpdate,
  modelOptions,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';

const definite = new Set([
  'INVALID_CREDENTIAL',
  'INVALID_MODEL_SETTINGS',
  'MODEL_NOT_CONFIGURED',
  'MODEL_SETTINGS_CONFLICT',
  'MODEL_SETTINGS_ID_REUSED',
  'MODEL_SETTINGS_LIMIT',
  'MODEL_API_UNAUTHORIZED',
  'MODEL_API_BALANCE',
  'MODEL_API_RATE_LIMIT',
  'MODEL_API_UNAVAILABLE',
  'MODEL_API_INVALID_RESPONSE',
  'MODEL_API_MODEL_UNAVAILABLE',
  'RUNTIME_TOO_OLD',
]);
export function Models() {
  const runtime = useRuntime();
  const model = runtime.snapshot.model;
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 13 &&
    model.revision !== undefined;
  const [draft, setDraft] = useState<{ model: DeepSeekModel; apiKey: string; revision: number }>();
  const [pending, setPending] = useState<ModelUpdate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState<ModelCheck>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const name =
    modelOptions.find((option) => option.id === model.model)?.name || model.model || 'DeepSeek';
  async function check() {
    if (!available || busy || model.revision === undefined) return;
    setBusy(true);
    setError('');
    setChecked(undefined);
    setNotice('');
    try {
      const result = await runtime.command<ModelCheck>({
        type: 'model.check',
        revision: model.revision,
      });
      if (mounted.current) setChecked(result);
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (!draft || !available || busy) return;
    if (draft.apiKey && !isModelKey(draft.apiKey)) {
      setError('请检查 API Key，移除空白并确认已完整复制。');
      return;
    }
    const input: ModelUpdate = pending || {
      model: draft.model,
      revision: draft.revision,
      requestId: crypto.randomUUID(),
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    };
    setPending(input);
    setBusy(true);
    setError('');
    setCode('');
    setNotice('');
    try {
      await runtime.command({ type: 'model.configure', input });
      if (mounted.current) {
        setDraft(undefined);
        setPending(undefined);
        setChecked(undefined);
        setNotice('模型设置已保存，下次任务生效。');
      }
    } catch (error) {
      if (mounted.current) {
        setError(runtimeError(error));
        const code = error instanceof Error ? error.message : '';
        setCode(code);
        if (definite.has(code)) setPending(undefined);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="setting-row">
        <div>
          <div className="setting-label">DeepSeek 官方 API</div>
          <p className="setting-description">
            {runtime.enabled
              ? `${model.configured ? (runtime.snapshot.agent?.location === 'host' ? '密钥保存在本机 Agent 服务中，不发送到 Linux 执行虚拟机。' : '密钥已保存在本地 Linux，客户端不回显。') : '先配置 API Key，再开始任务。'} 工作区默认模型：${name}`
              : '网页预览不保存密钥，请在桌面客户端配置。'}
          </p>
          {runtime.enabled && runtime.snapshot.protocolVersion < 13 && (
            <p className="field-help">更新本地运行环境后可在客户端配置模型。</p>
          )}
        </div>
        <div className="model-actions">
          <span className="badge">
            {runtime.snapshot.phase !== 'ready'
              ? '连接后检查'
              : model.configured
                ? '已配置'
                : '未配置'}
          </span>
          <button
            className="secondary"
            type="button"
            disabled={!available || busy || !!draft || !model.configured}
            onClick={check}
          >
            {busy && !draft ? '正在检查…' : '检查连接'}
          </button>
          <button
            className="secondary"
            type="button"
            disabled={!available || busy || !!draft}
            onClick={() => {
              setDraft({
                model: isDeepSeekModel(model.model) ? model.model : 'deepseek-flash',
                apiKey: '',
                revision: model.revision!,
              });
              setPending(undefined);
              setError('');
              setCode('');
              setNotice('');
            }}
          >
            {model.configured ? '修改模型设置' : '配置 DeepSeek'}
          </button>
        </div>
      </div>
      {draft && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            await save();
          }}
        >
          <fieldset className="model-fields" disabled={!available || busy || !!pending}>
            <div className="field-label">
              模型
              <Select
                label="模型"
                value={draft.model}
                disabled={!available || busy || !!pending}
                onValueChange={(value) => {
                  if (isDeepSeekModel(value)) setDraft({ ...draft, model: value });
                }}
                options={modelOptions.map((option) => ({ value: option.id, label: option.name }))}
              />
            </div>
            <label className="field-label">
              API Key
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                value={draft.apiKey}
                required={!model.configured}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
            <p className="field-help">
              {model.configured ? '留空保留现有密钥。' : '从 DeepSeek 开放平台获取密钥。'}
              密钥不写入客户端存储或导出；离开此页会清空未提交输入。
            </p>
          </fieldset>
          <p className="inline-note">
            密钥由工作区共用，默认模型仅影响选择“跟随工作区”的 Bot。
            保存前检查官方模型列表，不发送对话内容。更换模型会开启新推理会话，聊天记录保留；当前任务不受影响。
            {runtime.snapshot.protocolVersion >= 16
              ? 'Flash 支持整屏观察；V4 Pro 可使用已连接浏览器的 DOM 工具，不接收整屏截图。'
              : 'Flash 支持桌面观察；V4 Pro 当前用于文本任务，不提供模型电脑操作。'}
          </p>
          {pending && !busy && (
            <p className="inline-note">
              保存结果未确认，重试会核对同一次操作。退出编辑不会撤回可能已经保存的设置。
            </p>
          )}
          {code === 'MODEL_SETTINGS_CONFLICT' && (
            <div className="inline-note">
              <p>后台当前模型：{name}。密钥不会回显，请核对后重试。</p>
              <button
                className="secondary"
                type="button"
                disabled={model.revision === draft.revision}
                onClick={() => {
                  setDraft({ ...draft, revision: model.revision! });
                  setError('');
                  setCode('');
                }}
              >
                保留输入，按当前版本重试
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                setPending(undefined);
                setError('');
                setCode('');
              }}
            >
              取消编辑
            </button>
            <button className="primary" type="submit" disabled={!available || busy}>
              {busy ? '正在验证并保存…' : pending ? '核对并重试保存' : '验证并保存'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-note" role="status">
          {notice}
        </p>
      )}
      {checked?.revision === model.revision && checked?.model === model.model && (
        <p className="inline-note" role="status">
          连接检查通过 · {name} · {new Date(checked.checkedAt).toLocaleTimeString('zh-CN')}
        </p>
      )}
    </>
  );
}
