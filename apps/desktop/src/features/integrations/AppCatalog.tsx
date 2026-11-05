import type {
  AppConnect,
  AppDirectory,
  AppDirectoryEntry,
  AppId,
  AppOAuthPhase,
  AppOAuthReceipt,
  AppTarget,
  AppCatalog as Catalog,
  McpConnection,
} from '@daban/protocol';
import { isAppCatalog, isAppDirectory } from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';

export interface AppCatalogProps {
  bot: string;
  rows: McpConnection[];
  blocked?: boolean;
  onCustom: () => unknown;
  onChanged: () => Promise<unknown>;
  onDirty: (value: boolean) => unknown;
  onOAuthConnections: (ids: string[]) => unknown;
  onDialogChange?: (open: boolean) => unknown;
  onCheck?: (row: McpConnection) => Promise<unknown>;
  onTools?: (row: McpConnection) => unknown;
  onCopy?: (row: McpConnection) => unknown;
  onArchive?: (row: McpConnection) => unknown;
}
const phases: Record<AppOAuthPhase, MessageKey> = {
  preparing: 'apps.preparing',
  waiting: 'apps.waiting',
  exchanging: 'apps.exchanging',
  connected: 'apps.connected',
  cancelled: 'apps.cancelled',
  expired: 'apps.expired',
  failed: 'apps.failed',
  interrupted: 'apps.interrupted',
};
const states = {
  disconnected: 'apps.stateDisconnected',
  authorizing: 'apps.stateAuthorizing',
  connected: 'apps.stateConnected',
  'reconnect-required': 'apps.stateReconnect',
} as const;
const activePhase = (receipt?: AppOAuthReceipt) =>
  !!receipt && ['preparing', 'waiting', 'exchanging'].includes(receipt.phase);
function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (['MCP_NAME_CONFLICT', 'MCP_CONNECTION_LIMIT', 'MCP_STORAGE_LIMIT'].includes(code))
    return runtimeError(error);
  return t(
    code === 'OAUTH_BROWSER_UNAVAILABLE'
      ? 'apps.browserUnavailable'
      : code === 'OAUTH_UPGRADE_REQUIRED'
        ? 'apps.upgradeRequired'
        : code === 'OAUTH_CALLBACK_UNAVAILABLE' || code === 'OAUTH_INTERACTIVE_REQUIRED'
          ? 'apps.remoteUnavailable'
          : code === 'OAUTH_METADATA_REJECTED'
            ? 'apps.metadataRejected'
            : ['OAUTH_CONFLICT', 'MCP_NOT_FOUND', 'MCP_SHARED_READ_ONLY'].includes(code)
              ? 'apps.conflict'
              : code === 'OAUTH_SCOPE_REQUIRED'
                ? 'apps.scopeRequired'
                : 'apps.error',
  );
}
export function AppCatalog({
  bot,
  rows,
  blocked = false,
  onCustom,
  onChanged,
  onDirty,
  onOAuthConnections,
  onDialogChange,
  onCheck,
  onTools,
  onCopy,
  onArchive,
}: AppCatalogProps) {
  useLocale();
  const runtime = useRuntime();
  const [catalog, setCatalog] = useState<Catalog | AppDirectory>();
  const [editor, setEditor] = useState<{ app: AppId; name: string }>();
  const [pending, setPending] = useState<AppConnect>();
  const [receipt, setReceipt] = useState<AppOAuthReceipt>();
  const [disconnect, setDisconnect] = useState<{ target: AppTarget; requestId: string }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const live = useRef(true),
    owner = useRef(bot),
    reads = useRef(0),
    working = useRef(false);
  const currentPending = useRef(pending);
  currentPending.current = pending;
  owner.current = bot;
  const available =
    runtime.snapshot.phase === 'ready' &&
    (runtime.snapshot.mcp?.available === true || runtime.snapshot.appConnections?.catalog === true);
  const canControl = runtime.snapshot.appConnections?.catalog === true;
  const canAuthorize = canControl && runtime.snapshot.appConnections?.oauthLoopback === true;
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  const load = useCallback(async () => {
    const serial = ++reads.current;
    let value: Catalog | AppDirectory;
    try {
      value = await runtime.command<AppDirectory>({ type: 'app.directory', bot });
      if (!isAppDirectory(value) || value.bot !== bot) throw Error('INVALID_RUNTIME_STATE');
    } catch (cause) {
      // Only the read-only protocol probe permits legacy fallback. A start is never replayed on another route.
      if (!(cause instanceof Error) || cause.message !== 'OAUTH_UPGRADE_REQUIRED') throw cause;
      value = await runtime.command<Catalog>({ type: 'app.catalog', bot });
      if (!isAppCatalog(value) || value.bot !== bot) throw Error('INVALID_RUNTIME_STATE');
    }
    if (live.current && owner.current === bot && serial === reads.current) {
      setCatalog(value);
      onOAuthConnections(value.connections.map((c) => c.connection));
      const restored = value.attempts.find(
        (a) => !['connected', 'cancelled'].includes(a.receipt.phase),
      );
      if (!currentPending.current && !working.current && restored) {
        currentPending.current = restored.input;
        setPending(restored.input);
        setReceipt(restored.receipt);
      }
    }
  }, [runtime.command, bot, onOAuthConnections]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      reads.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Store revisions refresh public state without replacing an unresolved authorization.
  useEffect(() => {
    if (available)
      load().catch((cause) => {
        if (live.current && owner.current === bot) setError(errorText(cause));
      });
    return () => {
      reads.current++;
    };
  }, [available, bot, load, revision]);
  useEffect(() => {
    onDirty(busy || !!editor || (!!pending && !receipt) || !!disconnect);
    return () => {
      onDirty(false);
    };
  }, [busy, editor, pending, receipt, disconnect, onDirty]);
  const dialogOpen = !!editor;
  useEffect(() => {
    onDialogChange?.(dialogOpen);
    return () => {
      onDialogChange?.(false);
    };
  }, [dialogOpen, onDialogChange]);
  async function perform(action: () => Promise<unknown>) {
    if (working.current || blocked || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (live.current && owner.current === bot) setError(errorText(cause));
    } finally {
      working.current = false;
      if (live.current && owner.current === bot) setBusy(false);
    }
  }
  const accept = useCallback(
    async (value: AppOAuthReceipt, input: AppConnect) => {
      const current = currentPending.current;
      if (
        !live.current ||
        owner.current !== bot ||
        value.bot !== bot ||
        current?.requestId !== input.requestId ||
        value.requestId !== input.requestId ||
        value.connection !== input.connection ||
        value.revision !== input.revision
      )
        return;
      setReceipt(value);
      if (!activePhase(value)) {
        if (value.phase === 'connected' || value.phase === 'cancelled') {
          currentPending.current = undefined;
          setPending(undefined);
          setNotice(t(phases[value.phase]));
        }
        await onChanged();
        await load();
      }
    },
    [bot, onChanged, load],
  );
  async function start(input: AppConnect) {
    if (!canAuthorize) return;
    currentPending.current = input;
    setPending(input);
    setReceipt(undefined);
    setNotice('');
    setEditor(undefined);
    const command =
      catalog && 'protocol' in catalog
        ? { type: 'app.oauth.connect' as const, input }
        : input.app === 'notion'
          ? { type: 'app.oauth.start' as const, input: { ...input, app: 'notion' as const } }
          : undefined;
    if (!command) throw Error('OAUTH_UPGRADE_REQUIRED');
    try {
      await accept(await runtime.command<AppOAuthReceipt>(command), input);
    } catch (cause) {
      // These rejections precede reservation/provider IO. Ambiguous replies retain the original nonce instead.
      if (
        cause instanceof Error &&
        [
          'MCP_NAME_CONFLICT',
          'MCP_CONNECTION_LIMIT',
          'MCP_STORAGE_LIMIT',
          'OAUTH_CONFLICT',
          'OAUTH_CONNECTION_MISMATCH',
          'MCP_NOT_FOUND',
          'MCP_SHARED_READ_ONLY',
        ].includes(cause.message) &&
        live.current &&
        owner.current === bot &&
        currentPending.current?.requestId === input.requestId
      ) {
        currentPending.current = undefined;
        setPending(undefined);
        if (input.revision === 0) setEditor({ app: input.app, name: input.name ?? '' });
      }
      throw cause;
    }
  }
  useEffect(() => {
    if (!receipt || !pending || !activePhase(receipt)) return;
    let querying = false,
      subscribed = true;
    const target = { bot: receipt.bot, connection: receipt.connection, revision: receipt.revision };
    const timer = setInterval(() => {
      if (querying) return;
      querying = true;
      runtime
        .command<AppOAuthReceipt>({ type: 'app.oauth.status', target, attempt: receipt.attempt })
        .then(async (value) => {
          if (subscribed) await accept(value, pending);
        })
        .catch((cause) => {
          if (subscribed && live.current && owner.current === bot) setError(errorText(cause));
        })
        .finally(() => {
          querying = false;
        });
    }, 1000);
    return () => {
      subscribed = false;
      clearInterval(timer);
    };
  }, [receipt, pending, runtime.command, bot, accept]);
  if (!available) return null;
  const directory = catalog && 'protocol' in catalog ? catalog : undefined;
  const apps: AppDirectoryEntry[] = catalog?.apps ?? [];
  const unresolved = !!pending && (!receipt || activePhase(receipt));
  const disabled = busy || blocked || unresolved || !!disconnect;
  function open(app: AppDirectoryEntry) {
    if (app.id === 'custom-mcp') return;
    // A completed attempt does not lock other accounts; an unknown or active start keeps its nonce and blocks new starts.
    if (pending && receipt && !activePhase(receipt)) {
      currentPending.current = undefined;
      setPending(undefined);
    }
    let name = app.publisher;
    for (let index = 2; rows.some((row) => row.name === name); index++)
      name = `${app.publisher} ${index}`;
    setEditor({ app: app.id, name: directory ? name : '' });
    setReceipt(undefined);
    setNotice('');
  }
  return (
    <section aria-label={t('apps.title')}>
      <h3>{t('apps.title')}</h3>
      {!canAuthorize && <p className="field-help">{t('apps.remoteUnavailable')}</p>}
      {catalog?.connections.map((auth) => {
        const row = rows.find((r) => r.id === auth.connection);
        const identity = directory?.connections.find((c) => c.connection === auth.connection);
        const appId = identity?.app ?? 'notion';
        const app = apps.find((a) => a.id === appId);
        const target = {
          bot,
          connection: auth.connection,
          revision: identity?.revision ?? row?.revision ?? 0,
        };
        const fresh = !row || row.revision === target.revision;
        const connected = auth.state === 'connected';
        const ready = connected && row?.health === 'ready';
        const name = identity?.name ?? row?.name;
        if (!name || (!identity && !row)) return null;
        return (
          <div className="integration-row" key={auth.connection}>
            <div className="integration-meta">
              <h3>{name}</h3>
              <p>
                {app?.publisher} · {t(states[auth.state])}
              </p>
              {auth.scope && <p className="field-help">{t('apps.scope', { 0: auth.scope })}</p>}
              {connected && (
                <p className="field-help">{t(ready ? 'apps.chooseTools' : 'apps.checkNext')}</p>
              )}
              {!fresh && (
                <p role="alert" className="form-error">
                  {t('apps.conflict')}
                </p>
              )}
              <p className="field-help">{t('apps.accountImpact')}</p>
              <details>
                <summary>{t('apps.details')}</summary>
                <p>{row?.origin ?? app?.origin}</p>
                <p>
                  {t('integrations.revision')} {target.revision}
                </p>
                <div className="integration-actions">
                  {row && onCopy && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || !fresh}
                      onClick={() => onCopy(row)}
                    >
                      {t('capabilities.copyToBot')}
                    </button>
                  )}
                  {row && onArchive && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || !fresh}
                      aria-label={t('integrations.archive', { 0: name })}
                      onClick={() => onArchive(row)}
                    >
                      {t('common.archive')}
                    </button>
                  )}
                  {connected && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || !canAuthorize || !app?.available || !fresh}
                      onClick={() =>
                        perform(() =>
                          start({ ...target, app: appId, requestId: crypto.randomUUID() }),
                        )
                      }
                    >
                      {t('apps.reconnect', { 0: name })}
                    </button>
                  )}
                </div>
              </details>
            </div>
            <div className="integration-actions">
              {!connected && (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled || !canAuthorize || !app?.available || !fresh}
                  onClick={() =>
                    perform(() => start({ ...target, app: appId, requestId: crypto.randomUUID() }))
                  }
                >
                  {t('apps.reconnect', { 0: name })}
                </button>
              )}
              {connected && row && onCheck && (
                <button
                  type="button"
                  className={ready ? 'secondary' : 'primary'}
                  disabled={disabled || !fresh}
                  aria-label={t('integrations.check', { 0: name })}
                  onClick={() => perform(() => onCheck(row))}
                >
                  {t('common.checkConnection')}
                </button>
              )}
              {connected && row && onTools && (
                <button
                  type="button"
                  className={ready ? 'primary' : 'secondary'}
                  disabled={disabled || !fresh}
                  aria-label={t('integrations.namedToolsPermissions', { 0: name })}
                  onClick={() => onTools(row)}
                >
                  {t('integrations.toolsPermissions')}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={
                  busy ||
                  blocked ||
                  unresolved ||
                  !canControl ||
                  !fresh ||
                  (auth.state === 'disconnected' && !disconnect) ||
                  (!!disconnect && disconnect.target.connection !== auth.connection)
                }
                onClick={() =>
                  perform(async () => {
                    const operation = disconnect ?? { target, requestId: crypto.randomUUID() };
                    setDisconnect(operation);
                    await runtime.command({ type: 'app.disconnect', ...operation });
                    if (!live.current || owner.current !== bot) return;
                    setDisconnect(undefined);
                    setNotice(t('apps.disconnectedNotice'));
                    await onChanged();
                    await load();
                  })
                }
              >
                {t(disconnect ? 'apps.retryDisconnect' : 'apps.disconnect', { 0: name })}
              </button>
            </div>
          </div>
        );
      })}
      <details open={!catalog?.connections.length}>
        <summary>{t('apps.addApp')}</summary>
        {apps
          .filter((app) => app.auth === 'oauth')
          .map((app) => (
            <div className="integration-row" key={app.id}>
              <div className="integration-meta">
                <h3>{app.publisher}</h3>
                {app.scope && <p className="field-help">{t('apps.scope', { 0: app.scope })}</p>}
                {app.adminApproval && <p className="field-help">{t('apps.adminApproval')}</p>}
                {!app.available && app.reason === 'OAUTH_NOT_VERIFIED' && (
                  <p className="field-help">{t('apps.unverified')}</p>
                )}
                <details>
                  <summary>{t('apps.details')}</summary>
                  <p>{t('apps.publisher', { 0: app.publisher })}</p>
                  <p>{app.origin}</p>
                </details>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={disabled || !canAuthorize || !app.available}
                onClick={() => open(app)}
              >
                {t('apps.connect', { 0: app.publisher })}
              </button>
            </div>
          ))}
        {canControl && (
          <button type="button" className="secondary" disabled={disabled} onClick={onCustom}>
            {t('apps.custom')}
          </button>
        )}
      </details>
      {error && !editor && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="inline-note">
          {notice}
        </p>
      )}
      {pending && (
        <div className="inline-note">
          <strong>
            {pending.name ??
              rows.find((row) => row.id === pending.connection)?.name ??
              apps.find((app) => app.id === pending.app)?.publisher}
          </strong>
          {receipt && <p role="status">{t(phases[receipt.phase])}</p>}
          {pending.app === 'monday' && <p>{t('apps.adminApproval')}</p>}
          {receipt?.error && <p role="alert">{errorText(Error(receipt.error))}</p>}
          <div className="integration-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || blocked || !canAuthorize}
              onClick={() =>
                perform(() =>
                  start(
                    receipt && !activePhase(receipt)
                      ? { ...pending, requestId: crypto.randomUUID() }
                      : pending,
                  ),
                )
              }
            >
              {t(receipt && !activePhase(receipt) ? 'apps.restart' : 'apps.retry')}
            </button>
            {receipt && activePhase(receipt) && (
              <button
                type="button"
                className="secondary"
                disabled={busy || blocked || !canControl}
                onClick={() =>
                  perform(async () =>
                    accept(
                      await runtime.command<AppOAuthReceipt>({
                        type: 'app.oauth.cancel',
                        target: {
                          bot: receipt.bot,
                          connection: receipt.connection,
                          revision: receipt.revision,
                        },
                        attempt: receipt.attempt,
                        requestId: receipt.requestId,
                      }),
                      pending,
                    ),
                  )
                }
              >
                {t('apps.cancel')}
              </button>
            )}
          </div>
        </div>
      )}
      {directory?.attemptsMore && <p className="field-help">{t('apps.partialHistory')}</p>}
      {editor && (
        <Dialog
          title={t('apps.connect', {
            0: apps.find((app) => app.id === editor.app)?.publisher ?? editor.app,
          })}
          onClose={() => setEditor(undefined)}
          closeDisabled={busy}
        >
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await perform(() =>
                start({
                  bot,
                  app: editor.app,
                  connection: crypto.randomUUID(),
                  revision: 0,
                  name: editor.name.trim(),
                  requestId: crypto.randomUUID(),
                }),
              );
            }}
          >
            <label className="field-label">
              {t('integrations.connectionName')}
              <input
                className="field"
                value={editor.name}
                maxLength={60}
                required
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </label>
            <p className="field-help">{t('apps.description')}</p>
            {apps.find((app) => app.id === editor.app)?.scope && (
              <p className="field-help">
                {t('apps.scope', { 0: apps.find((app) => app.id === editor.app)?.scope ?? '' })}
              </p>
            )}
            {editor.app === 'monday' && <p className="field-help">{t('apps.adminApproval')}</p>}
            <button
              type="submit"
              className="primary"
              disabled={busy || !editor.name.trim() || !canAuthorize}
            >
              {t('apps.authorize')}
            </button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
