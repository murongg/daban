import {
  isModelApi,
  isModelConnection,
  isModelKey,
  type ModelCheck,
  type ModelConnection,
  type ModelDefinition,
  type ModelUpdate,
  modelApi,
  modelCatalog,
  modelReference,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { definitiveModelErrors } from './model-errors';
import { modelChoices, modelName } from './model-options';
import { NumberField } from './NumberField';
import { ProviderIcon } from './ProviderIcon';
import { apiOptions, platforms as presets, providerIdentity } from './platforms';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';

const newModel = (): ModelDefinition => ({
  id: '',
  name: '',
  vision: false,
  contextWindow: 128000,
  maxTokens: 8192,
});
interface Draft {
  connection: ModelConnection;
  apiKey: string;
  revision: number;
  selected: string;
  preset: string;
  keys: string[];
  // Keep the choice independent of the first model's still-editable upstream ID.
  defaultFirst: boolean;
}

export function Providers() {
  const runtime = useRuntime();
  const model = runtime.snapshot.model;
  const connections = model.connections || [];
  const catalog = modelCatalog(connections);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    model.connections !== undefined &&
    model.revision !== undefined;
  const [draft, setDraft] = useState<Draft>();
  const [selected, setSelected] = useState<string>();
  const [defaultRevision, setDefaultRevision] = useState<number>();
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
  const original = connections.find((connection) => connection.id === draft?.connection.id);
  const retainKey =
    !!original &&
    !!draft &&
    original.baseURL === draft.connection.baseURL &&
    modelApi(original) === modelApi(draft.connection);
  const current = selected ?? model.model;
  function edit(connection?: ModelConnection) {
    setDraft({
      connection: connection
        ? structuredClone(connection)
        : { id: crypto.randomUUID(), name: '', baseURL: '', models: [newModel()] },
      apiKey: '',
      revision: model.revision!,
      selected: model.configured ? model.model : '',
      preset:
        presets.find(
          (preset) =>
            preset.baseURL &&
            preset.baseURL === connection?.baseURL &&
            preset.api === modelApi(connection || {}),
        )?.id || 'custom',
      keys: (connection?.models || [null]).map(() => crypto.randomUUID()),
      defaultFirst: !model.configured,
    });
    setPending(undefined);
    setError('');
    setCode('');
    setNotice('');
  }
  async function save() {
    if (!available || busy) return;
    let input = pending;
    if (!input) {
      if (draft) {
        const connection = {
          ...draft.connection,
          name: draft.connection.name.trim(),
          baseURL: draft.connection.baseURL.trim(),
          models: draft.connection.models.map((entry) => ({
            ...entry,
            id: entry.id.trim(),
            name: entry.name.trim() || entry.id.trim(),
          })),
        };
        if (!isModelConnection(connection)) {
          setError('请检查 API 地址和模型配置；模型 ID 不能重复，输出上限不能超过上下文窗口。');
          return;
        }
        if ((!retainKey && !draft.apiKey) || (draft.apiKey && !isModelKey(draft.apiKey))) {
          setError('请为这个供应商填写完整的 API Key。更换 API 地址或接口协议时需要重新填写。');
          return;
        }
        const selectedModel = draft.defaultFirst
          ? modelReference(connection.id, connection.models[0].id)
          : draft.selected;
        const nextCatalog = modelCatalog([
          ...connections.filter((entry) => entry.id !== connection.id),
          connection,
        ]);
        // Editing or removing a model must not silently choose a replacement based on its row position.
        if (!nextCatalog.some((entry) => entry.id === selectedModel)) {
          setError('当前默认模型已被移除或改名，请明确将首个模型设为默认后再保存。');
          return;
        }
        input = {
          model: selectedModel,
          connection,
          revision: draft.revision,
          requestId: crypto.randomUUID(),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        };
      } else {
        if (!catalog.some((entry) => entry.id === current)) return;
        input = {
          model: current,
          revision: defaultRevision ?? model.revision!,
          requestId: crypto.randomUUID(),
        };
      }
    }
    setPending(input);
    setBusy(true);
    setError('');
    setCode('');
    setNotice('');
    try {
      await runtime.command({ type: 'model.configure', input });
      if (mounted.current) {
        setDraft(undefined);
        setSelected(undefined);
        setDefaultRevision(undefined);
        setPending(undefined);
        setChecked(undefined);
        setNotice('模型设置已保存，下次任务生效。');
      }
    } catch (failure) {
      if (mounted.current) {
        const next = failure instanceof Error ? failure.message : '';
        setError(runtimeError(failure));
        setCode(next);
        // Only a definitive server decision allows a new intent; uncertain replies retain the exact key and route.
        if (definitiveModelErrors.has(next)) setPending(undefined);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function check() {
    if (!available || busy) return;
    setBusy(true);
    setError('');
    setChecked(undefined);
    try {
      const result = await runtime.command<ModelCheck>({
        type: 'model.check',
        revision: model.revision!,
      });
      if (mounted.current) setChecked(result);
    } catch (failure) {
      if (mounted.current) setError(runtimeError(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function updateModel(index: number, patch: Partial<ModelDefinition>) {
    if (!draft) return;
    setDraft({
      ...draft,
      connection: {
        ...draft.connection,
        models: draft.connection.models.map((entry, position) =>
          position === index ? { ...entry, ...patch } : entry,
        ),
      },
    });
  }
  return (
    <div className="provider-settings">
      <div className="setting-row">
        <div>
          <div className="setting-label">供应商与模型</div>
          <p className="setting-description">
            添加常用供应商或自定义接口，为不同 Bot 选择模型。密钥只保存在本机 Agent 服务中。
          </p>
        </div>
        <button
          className="secondary"
          type="button"
          disabled={!available || busy || !!draft || !!pending}
          onClick={() => edit()}
        >
          添加供应商
        </button>
      </div>
      {connections.map((connection) => (
        <div className="setting-row provider-row" key={connection.id}>
          <div className="provider-identity">
            <ProviderIcon platform={providerIdentity(connection)} size="large" />
            <div>
              <div className="setting-label">{connection.name}</div>
              <p className="setting-description provider-address">{connection.baseURL}</p>
              <p className="setting-description">
                {connection.models.map((entry) => entry.name).join(' · ')}
              </p>
            </div>
          </div>
          <button
            className="text-button"
            type="button"
            aria-label={`编辑 ${connection.name}`}
            disabled={!available || busy || !!draft || !!pending}
            onClick={() => edit(connection)}
          >
            编辑
          </button>
        </div>
      ))}
      {model.connections === undefined && (
        <p className="inline-note">
          模型目录暂不可用，未提交输入与待核对操作已保留。恢复连接后可继续编辑。
        </p>
      )}
      {model.connections !== undefined && !connections.length && (
        <p className="inline-note">先添加一个供应商，再选择工作区和每位 Bot 的模型。</p>
      )}
      {!draft && catalog.length > 0 && (
        <div className="provider-default">
          <div className="field-label">
            工作区默认模型
            <Select
              label="工作区默认模型"
              value={current}
              disabled={!available || busy || !!pending}
              onValueChange={(value) => {
                setSelected(value);
                setDefaultRevision(model.revision);
                setCode('');
                setError('');
              }}
              options={modelChoices(connections, current)}
            />
          </div>
          <p className="field-help">
            仅影响选择「跟随工作区」的
            Bot；运行中的任务继续使用原模型。连接验证可能发送固定的测试请求，产生少量 API
            费用，不包含你的聊天内容。
          </p>
          <div className="model-actions">
            <button
              className="secondary"
              type="button"
              disabled={
                !available ||
                busy ||
                code === 'MODEL_SETTINGS_CONFLICT' ||
                (!pending && current === model.model)
              }
              onClick={save}
            >
              {pending ? '核对并重试保存' : busy ? '正在保存…' : '保存默认模型'}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={!available || busy || !!pending || !model.configured}
              onClick={check}
            >
              检查默认连接
            </button>
          </div>
          {code === 'MODEL_SETTINGS_CONFLICT' && (
            <div className="inline-note">
              <p>模型设置已由其他操作更新，请核对后保留选择重试。</p>
              <p>当前默认模型：{modelName(model.model, connections)}</p>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setDefaultRevision(model.revision);
                  setCode('');
                  setError('');
                }}
              >
                保留输入，按当前版本重试
              </button>
            </div>
          )}
        </div>
      )}
      {draft && (
        <form
          className="inline-form provider-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            await save();
          }}
        >
          <fieldset className="model-fields" disabled={!available || busy || !!pending}>
            {draft.connection.id !== 'deepseek-official' && (
              <div className="field-label">
                供应商类型
                <Select
                  label="供应商类型"
                  value={draft.preset}
                  disabled={!available || busy || !!pending}
                  options={presets.map((preset) => ({
                    value: preset.id,
                    label: preset.name,
                    icon: <ProviderIcon platform={preset.id} />,
                  }))}
                  onValueChange={(value) => {
                    const preset = presets.find((entry) => entry.id === value);
                    if (preset)
                      setDraft({
                        ...draft,
                        preset: value,
                        connection: {
                          ...draft.connection,
                          ...(preset.id === 'custom'
                            ? {}
                            : { name: preset.name, baseURL: preset.baseURL, api: preset.api }),
                        },
                      });
                  }}
                />
              </div>
            )}
            <div className="field-label">
              接口协议
              <Select
                label="接口协议"
                value={modelApi(draft.connection)}
                disabled={
                  !available || busy || !!pending || draft.connection.id === 'deepseek-official'
                }
                options={apiOptions}
                onValueChange={(value) => {
                  if (!isModelApi(value)) return;
                  const { api: _api, ...connection } = draft.connection;
                  // Leaving an unchanged legacy connection absent preserves its original save fingerprint.
                  setDraft({
                    ...draft,
                    preset: 'custom',
                    connection:
                      original?.api === undefined && value === 'openai-completions'
                        ? connection
                        : { ...connection, api: value },
                  });
                }}
              />
            </div>
            <div className="provider-pair">
              <label className="field-label">
                供应商名称
                <input
                  className="field"
                  required
                  maxLength={80}
                  value={draft.connection.name}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      connection: { ...draft.connection, name: event.target.value },
                    })
                  }
                />
              </label>
              <label className="field-label">
                API 地址
                <input
                  className="field"
                  required
                  type="url"
                  readOnly={draft.connection.id === 'deepseek-official'}
                  spellCheck={false}
                  value={draft.connection.baseURL}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      connection: { ...draft.connection, baseURL: event.target.value },
                    })
                  }
                />
              </label>
            </div>
            {draft.connection.id === 'deepseek-official' && (
              <p className="field-help">
                DeepSeek 官方连接使用固定地址。如需使用网关，请另外添加供应商。
              </p>
            )}
            {modelApi(draft.connection) === 'anthropic-messages' && (
              <p className="field-help">
                Claude 原生 API 地址填写服务根地址，例如 https://api.anthropic.com，不带 /v1。
              </p>
            )}
            {modelApi(draft.connection) === 'google-generative-ai' && (
              <p className="field-help">
                Gemini 原生 API 使用 /v1beta 地址。模型 ID 从供应商控制台复制。
              </p>
            )}
            <label className="field-label">
              API Key
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                value={draft.apiKey}
                required={!retainKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
            <p className="field-help">
              {retainKey
                ? '留空保留这个供应商的现有密钥。'
                : '新供应商、新的 API 地址或接口协议需要单独填写密钥。'}{' '}
              密钥不会写入客户端存储；关闭设置后会清空未提交输入。
            </p>
            <p className="inline-note">
              使用所选接口协议。请按供应商文档填写模型 ID
              和能力。保存时会验证连接；必要时发送固定的测试请求，产生少量 API
              费用，不包含你的聊天内容。
            </p>
            <div className="provider-models">
              {draft.connection.models.map((entry, index) => (
                <fieldset className="provider-model" key={draft.keys[index]}>
                  <legend>模型 {index + 1}</legend>
                  <div className="provider-pair">
                    <label className="field-label">
                      模型 ID
                      <input
                        className="field"
                        aria-label={`模型 ${index + 1} ID`}
                        required
                        maxLength={160}
                        spellCheck={false}
                        value={entry.id}
                        onChange={(event) => updateModel(index, { id: event.target.value })}
                      />
                    </label>
                    <label className="field-label">
                      显示名称
                      <input
                        className="field"
                        aria-label={`模型 ${index + 1} 名称`}
                        maxLength={120}
                        value={entry.name}
                        onChange={(event) => updateModel(index, { name: event.target.value })}
                      />
                    </label>
                  </div>
                  <label className="provider-vision">
                    <input
                      type="checkbox"
                      aria-label={`模型 ${index + 1} 支持图片`}
                      checked={entry.vision}
                      onChange={(event) => updateModel(index, { vision: event.target.checked })}
                    />
                    支持图片与桌面观察
                  </label>
                  <details className="provider-limits">
                    <summary>上下文与输出上限</summary>
                    <div className="provider-pair">
                      <div className="field-label">
                        上下文窗口
                        <NumberField
                          label={`模型 ${index + 1} 上下文窗口`}
                          value={String(entry.contextWindow)}
                          required
                          min={4096}
                          max={4000000}
                          onValueChange={(value) =>
                            updateModel(index, { contextWindow: Number(value) })
                          }
                        />
                      </div>
                      <div className="field-label">
                        最大输出 Token
                        <NumberField
                          label={`模型 ${index + 1} 最大输出`}
                          value={String(entry.maxTokens)}
                          required
                          min={128}
                          max={262144}
                          onValueChange={(value) =>
                            updateModel(index, { maxTokens: Number(value) })
                          }
                        />
                      </div>
                    </div>
                  </details>
                  {draft.connection.models.length > 1 && (
                    <button
                      className="text-button"
                      type="button"
                      aria-label={`移除模型 ${index + 1}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          keys: draft.keys.filter((_, position) => position !== index),
                          connection: {
                            ...draft.connection,
                            models: draft.connection.models.filter(
                              (_, position) => position !== index,
                            ),
                          },
                        })
                      }
                    >
                      移除此模型
                    </button>
                  )}
                </fieldset>
              ))}
            </div>
            <button
              className="secondary"
              type="button"
              disabled={draft.connection.models.length >= 50}
              onClick={() =>
                setDraft({
                  ...draft,
                  keys: [...draft.keys, crypto.randomUUID()],
                  connection: {
                    ...draft.connection,
                    models: [...draft.connection.models, newModel()],
                  },
                })
              }
            >
              添加模型
            </button>
            <label className="provider-default-choice">
              <input
                type="checkbox"
                checked={draft.defaultFirst}
                disabled={!model.configured}
                onChange={(event) => setDraft({ ...draft, defaultFirst: event.target.checked })}
              />
              将首个模型设为工作区默认模型
            </label>
          </fieldset>
          {pending && !busy && (
            <p className="inline-note">
              保存结果未确认。重试会核对同一次操作，不会改用其他密钥或模型。
            </p>
          )}
          {code === 'MODEL_SETTINGS_CONFLICT' && (
            <div className="inline-note">
              <p>后台设置已更新，请核对后保留输入重试。</p>
              <button
                className="secondary"
                type="button"
                disabled={model.revision === draft.revision}
                onClick={() => {
                  setDraft({ ...draft, revision: model.revision! });
                  setCode('');
                  setError('');
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
                setCode('');
                setError('');
              }}
            >
              取消编辑
            </button>
            <button className="primary" type="submit" disabled={!available || busy}>
              {busy ? '正在验证并保存…' : pending ? '核对并重试保存' : '验证并保存供应商'}
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
          默认连接检查通过 · {new Date(checked.checkedAt).toLocaleTimeString('zh-CN')}
        </p>
      )}
    </div>
  );
}
