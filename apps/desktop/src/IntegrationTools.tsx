import {
  agentId,
  type McpAssignment,
  type McpAssignments,
  type McpBindingInput,
  type McpCatalog,
  type McpConnection,
  type McpHistory,
  type McpReceipt,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';
import type { Bot } from './state';

interface Selection {
  input: McpBindingInput;
  baseTools: string[];
  baseEnabled: boolean;
  review: boolean;
}
const sameTools = (left: string[], right: string[]) =>
  left.length === right.length && left.every((name) => right.includes(name));
const dirty = (value?: Selection) =>
  !!value &&
  (value.review ||
    value.input.enabled !== value.baseEnabled ||
    !sameTools(value.input.tools, value.baseTools));
function selection(catalog: McpCatalog, entry: McpAssignment): Selection {
  const tools = entry.tools.filter((name) => catalog.tools.some((tool) => tool.name === name));
  return {
    input: {
      connection: catalog.current.id,
      configRevision: catalog.current.revision,
      bindingRevision: entry.revision,
      catalogDigest: catalog.current.catalogDigest,
      tools,
      enabled: entry.enabled,
    },
    baseTools: tools,
    baseEnabled: entry.enabled,
    // Stale saved authority needs review, but is not an unsaved edit that should trap navigation.
    review: false,
  };
}

export function IntegrationTools({
  connection,
  bots,
  onClose,
  onDirty,
}: {
  connection: McpConnection;
  bots: Bot[];
  onClose: () => unknown;
  onDirty?: (value: boolean) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const choices = bots.filter(
    (bot) =>
      !bot.members &&
      !bot.archived &&
      runtime.snapshot.profiles.some(
        (profile) => profile.id === agentId(bot.id) && !profile.archived,
      ),
  );
  const [bot, setBot] = useState(() => (choices[0] ? agentId(choices[0].id) : ''));
  const first = choices[0] ? agentId(choices[0].id) : '';
  useEffect(() => {
    if (!bot && first) setBot(first);
  }, [bot, first]);
  const [data, setData] = useState<{ bot: string; catalog: McpCatalog; entry: McpAssignment }>();
  const [draft, setDraft] = useState<Selection>();
  const [pending, setPending] = useState<McpBindingInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reads = useRef(0),
    mounted = useRef(true),
    working = useRef(false);
  const available =
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 21 &&
    runtime.snapshot.mcp?.available === true;
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  const locked = busy || !!pending || dirty(draft);
  useEffect(() => {
    onDirty?.(locked);
    return () => {
      onDirty?.(false);
    };
  }, [locked, onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reads.current++;
    };
  }, []);
  const load = useCallback(
    async (reset = false) => {
      const serial = ++reads.current;
      const [catalog, assignments] = await Promise.all([
        runtime.command<McpCatalog>({ type: 'mcp.catalog', id: connection.id }),
        runtime.command<McpAssignments>({ type: 'mcp.bindings', bot }),
      ]);
      const entry = assignments.items.find((item) => item.connection.id === connection.id);
      if (!entry) throw new Error('MCP_ARCHIVED');
      if (!mounted.current || reads.current !== serial) return;
      setData({ bot, catalog, entry });
      setDraft((current) => (!reset && dirty(current) ? current : selection(catalog, entry)));
    },
    [bot, connection.id, runtime.command],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Configuration and store revisions revalidate the catalog while dirty selections remain intact.
  useEffect(() => {
    if (!available || !bot) return;
    load().catch((error) => {
      if (mounted.current) setError(runtimeError(error));
    });
    return () => {
      reads.current++;
    };
  }, [
    available,
    bot,
    load,
    connection.revision,
    connection.catalogDigest,
    connection.health,
    revision,
  ]);
  const current = data?.bot === bot ? data : undefined;
  const changed =
    !!current &&
    !!draft &&
    (draft.input.configRevision !== current.catalog.current.revision ||
      draft.input.catalogDigest !== current.catalog.current.catalogDigest ||
      draft.input.bindingRevision !== current.entry.revision);
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
  async function save() {
    if (!draft) return;
    const input = pending ?? draft.input;
    setPending(input);
    try {
      await runtime.command({ type: 'mcp.bind', bot, input });
      if (!mounted.current) return;
      setPending(undefined);
      setNotice(t('工具选择已保存；实际调用仍需本次审批。'));
      await load(true);
    } catch (error) {
      if (
        mounted.current &&
        error instanceof Error &&
        [
          'MCP_CONFLICT',
          'MCP_BINDING_CONFLICT',
          'MCP_ARCHIVED',
          'MCP_REVIEW_REQUIRED',
          'MCP_TOOL_NOT_FOUND',
          'MCP_TOOL_LIMIT',
        ].includes(error.message)
      ) {
        setPending(undefined);
        await load();
      }
      throw error;
    }
  }
  const canSave =
    available &&
    choices.some((entry) => agentId(entry.id) === bot) &&
    current &&
    draft &&
    (dirty(draft) || (current.entry.enabled && !current.entry.available)) &&
    !changed &&
    !busy &&
    !pending &&
    !current.catalog.current.deleted &&
    (!draft.input.enabled ||
      (draft.input.tools.length > 0 && current.catalog.current.health === 'ready'));
  return (
    <section
      className="integration-access"
      aria-label={t('{0} 的工具设置', { 0: connection.name })}
    >
      <div className="integration-access-heading">
        <h3>
          {t('工具与授权 ·')}
          {connection.name}
        </h3>
        <button className="secondary" type="button" disabled={locked} onClick={onClose}>
          {t('关闭工具设置')}
        </button>
      </div>
      <div className="field-label">
        {t('使用工具的 Bot')}
        <Select
          label={t('使用工具的 Bot')}
          value={bot}
          disabled={locked || !available}
          onValueChange={(value) => {
            setBot(value);
            setDraft(undefined);
            setPending(undefined);
            setError('');
            setNotice('');
          }}
          options={[
            ...(!choices.some((entry) => agentId(entry.id) === bot) && bot
              ? [{ value: bot, label: t('原 Bot 已归档或不可用'), disabled: true }]
              : []),
            ...choices.map((item) => ({ value: agentId(item.id), label: item.name })),
          ]}
        />
      </div>
      {choices.length === 0 && (
        <p className="inline-note">{t('先创建并同步一位 Bot，再选择工具。')}</p>
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
      {!available && (
        <p className="inline-note">{t('外部工具服务暂不可用，未保存的选择仍留在本页。')}</p>
      )}
      {locked && (
        <p className="field-help">{t('先保存、核对或放弃当前修改，再切换 Bot 或连接。')}</p>
      )}
      {current && draft && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await perform(save);
          }}
        >
          <p className="field-help">
            {t('目录来自')}
            {current.catalog.current.origin}
            {t('。工具说明与返回内容不授予权限；可展开参数定义，核对后再保存。')}
          </p>
          {current.entry.enabled && !current.entry.available && (
            <p className="inline-note">
              {t('上次工具授权已失效，核对当前目录后再次保存才会启用。')}
            </p>
          )}
          {changed && (
            <div className="inline-note">
              <p>{t('目录或授权已变化。你的选择仍保留，请核对当前版本。')}</p>
              <button
                className="secondary"
                type="button"
                disabled={busy || !!pending}
                onClick={() => {
                  const next = selection(current.catalog, current.entry);
                  setDraft({
                    ...next,
                    review: true,
                    input: {
                      ...next.input,
                      enabled: draft.input.enabled,
                      tools: draft.input.tools.filter((name) =>
                        current.catalog.tools.some((tool) => tool.name === name),
                      ),
                    },
                  });
                }}
              >
                {t('按当前版本继续编辑')}
              </button>
            </div>
          )}
          <fieldset
            className="integration-tool-list"
            disabled={!available || busy || !!pending || changed}
          >
            {current.catalog.tools.length === 0 && (
              <p className="inline-note">{t('没有可选择的工具，请先检查连接。')}</p>
            )}
            {current.catalog.tools.map((tool) => (
              <div className="integration-tool" key={tool.name}>
                <label className="integration-check">
                  <input
                    type="checkbox"
                    checked={draft.input.tools.includes(tool.name)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        input: {
                          ...draft.input,
                          tools: event.target.checked
                            ? [...draft.input.tools, tool.name]
                            : draft.input.tools.filter((name) => name !== tool.name),
                        },
                      })
                    }
                  />
                  {tool.name}
                </label>
                <p className="setting-description">{tool.description}</p>
                <details>
                  <summary>{t('参数定义')}</summary>
                  <ScrollText
                    label={t('{0} 参数定义', { 0: tool.name })}
                    value={JSON.stringify(tool.inputSchema, null, 2)}
                  />
                </details>
              </div>
            ))}
            <label className="integration-check">
              <input
                type="checkbox"
                checked={draft.input.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, input: { ...draft.input, enabled: event.target.checked } })
                }
              />
              {t('允许这位 Bot 使用所选工具')}
            </label>
          </fieldset>
          <p className="field-help">
            {t('新任务会使用已保存的选择。停用会取消尚未发出的调用；已发出的操作可能已经生效。')}
          </p>
          <div className="inline-form-actions">
            <button className="primary" type="submit" disabled={!canSave}>
              {t('保存工具选择')}
            </button>
            {pending && (
              <button
                className="secondary"
                type="button"
                disabled={busy || !available}
                onClick={() =>
                  perform(async () => {
                    const value = await runtime.command<McpAssignments>({
                      type: 'mcp.bindings',
                      bot,
                    });
                    const entry = value.items.find(
                      (item) => item.connection.id === pending.connection,
                    );
                    if (
                      !entry ||
                      entry.revision !== pending.bindingRevision + 1 ||
                      entry.connection.revision !== pending.configRevision ||
                      entry.enabled !== pending.enabled ||
                      entry.catalogDigest !== pending.catalogDigest ||
                      !sameTools(entry.tools, pending.tools)
                    )
                      throw new Error('MCP_BINDING_UNCONFIRMED');
                    if (mounted.current) {
                      setPending(undefined);
                      setNotice(t('已核对这次工具选择。'));
                    }
                    await load(true);
                  })
                }
              >
                {t('核对授权结果')}
              </button>
            )}
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setPending(undefined);
                setDraft(current ? selection(current.catalog, current.entry) : undefined);
                if (pending) {
                  onDirty?.(false);
                  onClose();
                }
              }}
            >
              {pending ? t('退出授权编辑') : t('放弃选择修改')}
            </button>
          </div>
          {pending && (
            <p className="inline-note">
              {t('授权结果未确认，核对不会重发请求。退出编辑不会撤回可能已提交的授权。')}
            </p>
          )}
        </form>
      )}
      {bot && (
        <CallHistory
          key={`${bot}/${connection.id}`}
          bot={bot}
          connection={connection.id}
          available={available}
        />
      )}
    </section>
  );
}

const phases = {
  claimed: '等待审批',
  dispatched: '已发出',
  settled: '已返回',
  denied: '已拒绝',
  cancelled: '已取消',
  unknown: '结果不确定',
};
function CallHistory({
  bot,
  connection,
  available,
}: {
  bot: string;
  connection: string;
  available: boolean;
}) {
  useLocale();
  const runtime = useRuntime();
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  const [history, setHistory] = useState<McpHistory>();
  const [receipt, setReceipt] = useState<McpReceipt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Receipt revisions refresh read-only history after a live call changes phase.
  useEffect(() => {
    if (!available) return;
    let live = true;
    runtime
      .command<McpHistory>({ type: 'mcp.calls', bot, connection })
      .then((value) => {
        if (live) setHistory(value);
      })
      .catch((error) => {
        if (live) setError(runtimeError(error));
      });
    return () => {
      live = false;
    };
  }, [available, bot, connection, runtime.command, revision]);
  return (
    <div className="integration-history">
      <h3>{t('最近调用')}</h3>
      <p className="field-help">
        {t('仅显示这位 Bot 在此连接上的最近 20 次调用。回执查询不会重新执行工具。')}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {history?.items.length === 0 && (
        <p className="inline-note">{t('这位 Bot 还没有调用过此连接。')}</p>
      )}
      {history?.items.map((item) => (
        <div className="integration-call" key={item.id}>
          <div>
            <strong>{item.tool}</strong>
            <span className="badge">{t(phases[item.phase])}</span>
          </div>
          {item.phase === 'unknown' && (
            <p className="inline-note">
              {t('操作可能已经执行，请先到目标服务核对，不要重复提交。')}
            </p>
          )}
          <p className="field-help">
            {new Date(item.createdAt).toLocaleString()}
            {t('· 连接版本')}
            {item.configRevision}
          </p>
          <button
            className="secondary"
            type="button"
            disabled={busy || !available}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const value = await runtime.command<McpReceipt>({
                  type: 'mcp.receipt',
                  bot,
                  run: item.run,
                  id: item.id,
                });
                if (mounted.current) setReceipt(value);
              } catch (error) {
                if (mounted.current) setError(runtimeError(error));
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            {t('查看回执')}
          </button>
        </div>
      ))}
      {receipt && (
        <div className="integration-receipt">
          <h4>
            {receipt.tool} · {t(phases[receipt.phase])}
          </h4>
          <p className="field-help">{t('参数')}</p>
          <ScrollText label={t('调用参数')} value={receipt.preview} />
          {receipt.result && (
            <>
              <p className="field-help">{t('返回内容')}</p>
              <ScrollText label={t('返回内容')} value={receipt.result} />
            </>
          )}
          {receipt.error && <p className="inline-note">{runtimeError(new Error(receipt.error))}</p>}
          <button className="secondary" type="button" onClick={() => setReceipt(undefined)}>
            {t('收起回执')}
          </button>
        </div>
      )}
    </div>
  );
}

function ScrollText({ label, value }: { label: string; value: string }) {
  useLocale();
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded text must be focusable for keyboard scrolling.
    <section className="integration-scroll" aria-label={label} tabIndex={0}>
      <pre>{value}</pre>
    </section>
  );
}
