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
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { t, useLocale } from '../../i18n/locale';

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
  bot: target,
  onClose,
  onChanged,
  onDirty,
}: {
  connection: McpConnection;
  bot: Bot;
  onChanged?: () => Promise<unknown>;
  onClose: () => unknown;
  onDirty?: (value: boolean) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const bot = agentId(target.id);
  const active =
    !target.archived &&
    runtime.snapshot.profiles.some((profile) => profile.id === bot && !profile.archived);
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
    active &&
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
        runtime.command<McpCatalog>({ type: 'mcp.catalog', id: connection.id, bot }),
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
      setNotice(t('integrationtools.toolSelectionSavedActualCallsStillNeed'));
      await load(true);
      await onChanged?.();
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
      aria-label={t('integrationtools.tools', { 0: connection.name })}
    >
      <div className="integration-access-heading">
        <h3>
          {t('integrationtools.toolsPermissions')}
          {connection.name}
        </h3>
        <button className="secondary" type="button" disabled={locked} onClick={onClose}>
          {t('integrationtools.closeToolSettings')}
        </button>
      </div>
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
        <p className="inline-note">
          {t('integrationtools.externalToolsTemporarilyUnavailableUnsavedSelectionsRemain')}
        </p>
      )}
      {locked && <p className="field-help">{t('integrationtools.finishSelection')}</p>}
      {current && draft && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await perform(save);
          }}
        >
          <p className="field-help">
            {t('integrationtools.catalog')}
            {current.catalog.current.origin}
            {t('integrationtools.toolDescriptionsResultsDoNotGrantPermission')}
          </p>
          {current.entry.enabled && !current.entry.available && (
            <p className="inline-note">
              {t('integrationtools.previousToolAuthorizationHasExpiredReviewCurrent')}
            </p>
          )}
          {changed && (
            <div className="inline-note">
              <p>
                {t('integrationtools.catalogPermissionsChangedSelectionsRetainedReviewCurrent')}
              </p>
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
                {t('integrationtools.continueEditingCurrentRevision')}
              </button>
            </div>
          )}
          <fieldset
            className="integration-tool-list"
            disabled={!available || busy || !!pending || changed}
          >
            {current.catalog.tools.length === 0 && (
              <p className="inline-note">
                {t('integrationtools.noToolsSelectCheckConnectionFirst')}
              </p>
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
                  <summary>{t('integrations.parameterSchema')}</summary>
                  <ScrollText
                    label={t('integrations.namedParameterSchema', { 0: tool.name })}
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
              {t('integrationtools.allowBotUseSelectedTools')}
            </label>
          </fieldset>
          <p className="field-help">
            {t('integrationtools.newTasksUseSavedSelectionDisablingCancels')}
          </p>
          <div className="inline-form-actions">
            <button className="primary" type="submit" disabled={!canSave}>
              {t('integrationtools.saveToolSelection')}
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
                      setNotice(t('integrationtools.toolSelectionVerified'));
                    }
                    await load(true);
                    await onChanged?.();
                  })
                }
              >
                {t('integrationtools.verifyAuthorizationResult')}
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
              {pending
                ? t('integrationtools.leavePermissionEditor')
                : t('integrationtools.discardSelectionChanges')}
            </button>
          </div>
          {pending && (
            <p className="inline-note">
              {t('integrationtools.authorizationResultUnconfirmedCheckingDoesNotResend')}
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
  claimed: 'integrationtools.awaitingApproval',
  dispatched: 'integrationtools.sent',
  settled: 'integrationtools.returned',
  denied: 'common.declined',
  cancelled: 'integrationtools.cancelled',
  unknown: 'integrationtools.outcomeUncertain',
} as const;
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
      <h3>{t('integrationtools.recentCalls')}</h3>
      <p className="field-help">{t('integrationtools.showsOnlyBotSLatestCallsConnection')}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {history?.items.length === 0 && (
        <p className="inline-note">{t('integrationtools.botHasNotUsedConnectionYet')}</p>
      )}
      {history?.items.map((item) => (
        <div className="integration-call" key={item.id}>
          <div>
            <strong>{item.tool}</strong>
            <span className="badge">{t(phases[item.phase])}</span>
          </div>
          {item.phase === 'unknown' && (
            <p className="inline-note">
              {t('common.operationMayAlreadyHaveExecutedCheckDestination')}
            </p>
          )}
          <p className="field-help">
            {new Date(item.createdAt).toLocaleString()}
            {t('integrationtools.connectionRevision')}
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
            {t('integrationtools.checkReceipt')}
          </button>
        </div>
      ))}
      {receipt && (
        <div className="integration-receipt">
          <h4>
            {receipt.tool} · {t(phases[receipt.phase])}
          </h4>
          <p className="field-help">{t('integrationtools.parameters')}</p>
          <ScrollText label={t('integrationtools.callParameters')} value={receipt.preview} />
          {receipt.result && (
            <>
              <p className="field-help">{t('integrationtools.backContent')}</p>
              <ScrollText label={t('integrationtools.backContent')} value={receipt.result} />
            </>
          )}
          {receipt.error && <p className="inline-note">{runtimeError(new Error(receipt.error))}</p>}
          <button className="secondary" type="button" onClick={() => setReceipt(undefined)}>
            {t('integrationtools.collapseReceipt')}
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
