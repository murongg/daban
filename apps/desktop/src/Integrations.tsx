import type { McpCatalog, McpConnection, McpSave, McpSaved } from '@daban/protocol';
import { Archive, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { IntegrationTools } from './IntegrationTools';
import { runtimeError, useRuntime } from './Runtime';
import type { Bot } from './state';

interface Draft {
  id: string;
  revision: number;
  name: string;
  endpoint: string;
  bearer: string;
  clearBearer: boolean;
}
const definite = new Set([
  'INVALID_MCP_CONFIG',
  'MCP_CONFLICT',
  'MCP_ARCHIVED',
  'MCP_NAME_CONFLICT',
  'MCP_CONNECTION_LIMIT',
  'MCP_STORAGE_LIMIT',
  'MCP_NOT_FOUND',
  'MCP_REQUEST_ID_REUSED',
]);
const health = { unchecked: '未检查', ready: '上次检查可用', unavailable: '上次检查失败' };

export function Integrations({ bots }: { bots: Bot[] }) {
  const runtime = useRuntime();
  const [rows, setRows] = useState<McpConnection[]>([]);
  const [trash, setTrash] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState<McpSave>();
  const [conflict, setConflict] = useState<McpConnection>();
  const [selected, setSelected] = useState<McpConnection>();
  const [accessDirty, setAccessDirty] = useState(false);
  const [archiving, setArchiving] = useState<McpConnection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true),
    working = useRef(false),
    reads = useRef(0);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 21 &&
    runtime.snapshot.mcp?.available === true;
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reads.current++;
    };
  }, []);
  const load = useCallback(async () => {
    const serial = ++reads.current;
    const value = await runtime.command<{ revision: number; items: McpConnection[] }>({
      type: 'mcp.list',
      includeDeleted: trash,
    });
    if (mounted.current && serial === reads.current) setRows(value.items);
  }, [runtime.command, trash]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Store revisions refresh metadata without replacing a private editor draft.
  useEffect(() => {
    if (!available) return;
    load().catch((error) => {
      if (mounted.current) setError(runtimeError(error));
    });
    return () => {
      reads.current++;
    };
  }, [available, load, revision]);
  async function perform(action: () => Promise<unknown>) {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function edit(entry?: McpConnection) {
    setSelected(undefined);
    setPending(undefined);
    setConflict(undefined);
    setError('');
    setNotice('');
    setDraft({
      id: entry?.id ?? crypto.randomUUID(),
      revision: entry?.revision ?? 0,
      name: entry?.name ?? '',
      endpoint: '',
      bearer: '',
      clearBearer: false,
    });
  }
  async function acknowledge(value: McpSaved) {
    if (!mounted.current) return;
    setDraft(undefined);
    setPending(undefined);
    setConflict(undefined);
    setNotice(
      value.current.revision === value.receipt.revision
        ? '连接已保存，请检查连接并单独为 Bot 选择工具。'
        : '这次保存已提交，但连接已有后续更新，请核对当前配置。',
    );
    await load();
  }
  async function save() {
    if (!draft) return;
    const input = pending ?? {
      requestId: crypto.randomUUID(),
      id: draft.id,
      revision: draft.revision,
      name: draft.name.trim(),
      ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
      ...(draft.clearBearer ? { bearer: null } : draft.bearer ? { bearer: draft.bearer } : {}),
    };
    setPending(input);
    try {
      await acknowledge(await runtime.command<McpSaved>({ type: 'mcp.save', input }));
    } catch (error) {
      if (mounted.current && error instanceof Error && definite.has(error.message))
        setPending(undefined);
      throw error;
    }
  }
  const entry = rows.find((row) => row.id === selected?.id) ?? selected;
  const blocked = !available || busy || !!draft || accessDirty;
  return (
    <div className="settings-section integration-settings">
      <h2>外部工具</h2>
      <p className="setting-description">
        连接 MCP 服务，让 Bot 使用你选择的工具。每次实际调用仍需单独审批。
      </p>
      <p className="field-help">
        当前支持公网 HTTPS 的 Streamable HTTP；本地程序、OAuth 登录和自定义请求头尚未接入。
      </p>
      {!available && (
        <p className="inline-note">
          {runtime.snapshot.protocolVersion < 21
            ? '更新本地运行环境后可配置外部工具。'
            : runtime.snapshot.phase !== 'ready'
              ? '本地运行环境尚未连接，连接恢复后可管理外部工具。'
              : '外部工具服务暂不可用，普通对话和已有工作区仍可使用。'}
        </p>
      )}
      <div className="integration-actions">
        <button className="secondary" type="button" disabled={blocked} onClick={() => edit()}>
          <Plus />
          添加连接
        </button>
        <button
          className="secondary"
          type="button"
          disabled={blocked}
          aria-pressed={trash}
          onClick={() => {
            setTrash(!trash);
            setSelected(undefined);
          }}
        >
          {trash ? '返回连接' : '已归档'}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={!available || busy}
          onClick={() => perform(load)}
        >
          <RefreshCw />
          刷新列表
        </button>
      </div>
      {error && !archiving && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-note" role="status">
          {notice}
        </p>
      )}
      {draft && (
        <form
          className="inline-form"
          aria-label="连接编辑"
          onSubmit={async (event) => {
            event.preventDefault();
            await perform(save);
          }}
        >
          <fieldset className="model-fields" disabled={!available || busy || !!pending}>
            <label className="field-label">
              连接名称
              <input
                className="field"
                required
                maxLength={60}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="field-label">
              服务地址
              <input
                className="field"
                type="url"
                autoComplete="off"
                spellCheck={false}
                required={draft.revision === 0}
                maxLength={4096}
                value={draft.endpoint}
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              />
            </label>
            <label className="field-label">
              Bearer Token
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={draft.clearBearer}
                maxLength={4096}
                value={draft.bearer}
                onChange={(event) => setDraft({ ...draft, bearer: event.target.value })}
              />
            </label>
            {draft.revision > 0 && (
              <label className="integration-check">
                <input
                  type="checkbox"
                  checked={draft.clearBearer}
                  onChange={(event) => setDraft({ ...draft, clearBearer: event.target.checked })}
                />
                清除已保存的 Bearer
              </label>
            )}
            <p className="field-help">
              地址与 Token 保存后不回显；编辑时留空沿用当前版本。清除 Bearer
              不会移除地址中的凭据，需替换服务地址。未提交输入仅留在本页内存，离开此页会清空。
            </p>
          </fieldset>
          {pending && !busy && (
            <p className="inline-note">
              保存结果未确认。核对只查询回执；重试使用同一次保存。退出编辑不会撤回可能已保存的配置。
            </p>
          )}
          {conflict && (
            <div className="inline-note">
              <p>
                当前配置：{conflict.name} · 版本 {conflict.revision} · {conflict.origin}
                。未填写的地址和 Token 将沿用这个版本。
              </p>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft({ ...draft, revision: conflict.revision });
                  setConflict(undefined);
                  setError('');
                }}
              >
                以此版本继续编辑
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            {pending ? (
              <>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || !available}
                  onClick={() =>
                    perform(async () =>
                      acknowledge(
                        await runtime.command<McpSaved>({
                          type: 'mcp.saved',
                          id: pending.requestId,
                          connection: pending.id,
                        }),
                      ),
                    )
                  }
                >
                  核对保存结果
                </button>
                <button className="secondary" type="submit" disabled={busy || !available}>
                  重试这次保存
                </button>
              </>
            ) : (
              <button className="primary" type="submit" disabled={busy || !available}>
                {busy ? '正在保存…' : '保存连接'}
              </button>
            )}
            {draft.revision > 0 && !pending && (
              <button
                className="secondary"
                type="button"
                disabled={busy || !available}
                onClick={() =>
                  perform(async () => {
                    const value = await runtime.command<McpCatalog>({
                      type: 'mcp.catalog',
                      id: draft.id,
                    });
                    if (mounted.current) setConflict(value.current);
                  })
                }
              >
                核对当前配置
              </button>
            )}
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                setPending(undefined);
                setConflict(undefined);
              }}
            >
              退出编辑
            </button>
          </div>
        </form>
      )}
      {available && rows.length === 0 && (
        <p className="inline-note">
          {trash ? '没有已归档的连接。' : '还没有外部连接。添加后先检查目录，再为 Bot 选择工具。'}
        </p>
      )}
      {rows.map((row) => (
        <div className="integration-row" key={row.id}>
          <div className="integration-meta">
            <h3>{row.name}</h3>
            <p>{row.origin}</p>
            <span className="badge">{health[row.health]}</span>
            <span className="field-help">
              {row.toolCount} 个工具 · {row.credentialConfigured ? '已配置凭据' : '未配置凭据'}
            </span>
          </div>
          <div className="integration-actions">
            {trash ? (
              <button
                className="secondary"
                type="button"
                aria-label={`恢复 ${row.name}`}
                disabled={blocked}
                onClick={() =>
                  perform(async () => {
                    await runtime.command({
                      type: 'mcp.restore',
                      id: row.id,
                      revision: row.revision,
                    });
                    if (mounted.current)
                      setNotice('连接已恢复，需要重新为每位 Bot 选择并启用工具。');
                    await load();
                  })
                }
              >
                <RotateCcw />
                恢复
              </button>
            ) : (
              <>
                <button
                  className="secondary"
                  type="button"
                  aria-label={`编辑 ${row.name}`}
                  disabled={blocked}
                  onClick={() => edit(row)}
                >
                  编辑
                </button>
                <button
                  className="secondary"
                  type="button"
                  aria-label={`检查 ${row.name}`}
                  disabled={!available || busy || !!draft}
                  onClick={() =>
                    perform(async () => {
                      await runtime.command({
                        type: 'mcp.check',
                        id: row.id,
                        revision: row.revision,
                      });
                      if (mounted.current) setNotice('检查完成，尚未为任何 Bot 新增工具授权。');
                      await load();
                    })
                  }
                >
                  检查连接
                </button>
                <button
                  className="secondary"
                  type="button"
                  aria-label={`工具与授权 ${row.name}`}
                  disabled={blocked}
                  onClick={() => setSelected(selected?.id === row.id ? undefined : row)}
                >
                  工具与授权
                </button>
                <button
                  className="secondary"
                  type="button"
                  aria-label={`归档 ${row.name}`}
                  disabled={blocked}
                  onClick={() => setArchiving(row)}
                >
                  <Archive />
                  归档
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {entry && !trash && (
        <IntegrationTools
          connection={entry}
          bots={bots}
          onDirty={setAccessDirty}
          onClose={() => setSelected(undefined)}
        />
      )}
      {archiving && (
        <Dialog
          title="归档连接"
          onClose={() => {
            if (!busy) setArchiving(undefined);
          }}
        >
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p>
            归档“{archiving.name}”会停用所有 Bot
            对此连接的工具授权，并取消尚未执行的调用。已发出的外部操作可能已经生效。
          </p>
          <p className="field-help">连接可以恢复，恢复后需要重新为每位 Bot 选择并启用工具。</p>
          <div className="inline-form-actions">
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await runtime.command({
                    type: 'mcp.archive',
                    id: archiving.id,
                    revision: archiving.revision,
                  });
                  if (mounted.current) {
                    setArchiving(undefined);
                    setSelected(undefined);
                  }
                  await load();
                })
              }
            >
              确认归档
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setArchiving(undefined)}
            >
              取消
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
