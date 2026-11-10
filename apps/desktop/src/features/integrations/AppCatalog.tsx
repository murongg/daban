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
import { ArrowUpRight, ChevronDown, Info, Link2, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import './app-catalog.css';

export interface AppCatalogProps {
  bot?: string;
  botName?: (id: string) => string;
  rows: McpConnection[];
  blocked?: boolean;
  onCustom: () => unknown;
  onChanged: () => Promise<unknown>;
  onDirty?: (value: boolean) => unknown;
  onOAuthConnections: (ids: string[]) => unknown;
  onDialogChange?: (open: boolean) => unknown;
  onCheck?: (row: McpConnection) => Promise<unknown>;
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
  botName = (id) => id,
  rows,
  blocked = false,
  onCustom,
  onChanged,
  onDirty,
  onOAuthConnections,
  onDialogChange,
  onCheck,
  onArchive,
}: AppCatalogProps) {
  useLocale();
  const runtime = useRuntime();
  const [catalog, setCatalog] = useState<Catalog | AppDirectory>();
  const [editor, setEditor] = useState<{ app: AppId; name: string; editName?: boolean }>();
  const [pending, setPending] = useState<AppConnect>();
  const [receipt, setReceipt] = useState<AppOAuthReceipt>();
  const [disconnect, setDisconnect] = useState<{ target: AppTarget; requestId: string }>();
  const [confirmDisconnect, setConfirmDisconnect] = useState<{
    target: AppTarget;
    name: string;
    bots: string[];
  }>();
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
  const canAuthorize =
    canControl &&
    runtime.snapshot.appConnections?.oauthLoopback === true &&
    (bot !== undefined || runtime.snapshot.appWorkspace === true);
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  const load = useCallback(async () => {
    const serial = ++reads.current;
    let value: Catalog | AppDirectory;
    try {
      value = await runtime.command<AppDirectory>({
        type: 'app.directory',
        ...(bot ? { bot } : {}),
      });
      if (!isAppDirectory(value) || value.bot !== bot) throw Error('INVALID_RUNTIME_STATE');
    } catch (cause) {
      // Only the read-only protocol probe permits legacy fallback. A start is never replayed on another route.
      if (!bot || !(cause instanceof Error) || cause.message !== 'OAUTH_UPGRADE_REQUIRED')
        throw cause;
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
    onDirty?.(busy || !!editor || (!!pending && !receipt) || !!disconnect);
    return () => {
      onDirty?.(false);
    };
  }, [busy, editor, pending, receipt, disconnect, onDirty]);
  const dialogOpen = !!editor || !!confirmDisconnect;
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
        value.bot !== input.bot ||
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
        : input.app === 'notion' && input.bot
          ? {
              type: 'app.oauth.start' as const,
              input: { ...input, bot: input.bot, app: 'notion' as const },
            }
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
        if (input.revision === 0)
          setEditor({
            app: input.app,
            name: input.name ?? '',
            editName: cause.message === 'MCP_NAME_CONFLICT',
          });
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
  const editorApp = apps.find((app) => app.id === editor?.app);
  const unresolved = !!pending && (!receipt || activePhase(receipt));
  const disabled = busy || blocked || unresolved || !!disconnect;
  async function disconnectAccount(target: AppTarget) {
    const operation = disconnect ?? { target, requestId: crypto.randomUUID() };
    setDisconnect(operation);
    await runtime.command({ type: 'app.disconnect', ...operation });
    if (!live.current || owner.current !== bot) return;
    setDisconnect(undefined);
    setNotice(t('apps.disconnectedNotice'));
    await onChanged();
    await load();
  }
  function open(app: AppDirectoryEntry) {
    if (app.id === 'custom-mcp') return;
    // A completed attempt does not lock other accounts; an unknown or active start keeps its nonce and blocks new starts.
    if (pending && receipt && !activePhase(receipt)) {
      currentPending.current = undefined;
      setPending(undefined);
    }
    let name = app.publisher;
    for (let index = 2; rows.some((row) => row.ownerBot === bot && row.name === name); index++)
      name = `${app.publisher} ${index}`;
    setEditor({ app: app.id, name });
    setReceipt(undefined);
    setNotice('');
  }
  return (
    <section className="app-catalog" aria-label={t('apps.title')}>
      <h3 className="app-catalog-title">{t('apps.title')}</h3>
      {!canAuthorize && <p className="field-help">{t('apps.remoteUnavailable')}</p>}
      {catalog?.connections.map((auth) => {
        const row = rows.find((r) => r.id === auth.connection);
        const identity = directory?.connections.find((c) => c.connection === auth.connection);
        const appId = identity?.app ?? 'notion';
        const app = apps.find((a) => a.id === appId);
        const accountOwner = identity?.ownerBot ?? row?.ownerBot ?? bot;
        const target = {
          ...(accountOwner ? { bot: accountOwner } : {}),
          connection: auth.connection,
          revision: identity?.revision ?? row?.revision ?? 0,
        };
        const fresh = !row || row.revision === target.revision;
        const connected = auth.state === 'connected';
        const ready = connected && row?.health === 'ready';
        const name = identity?.name ?? row?.name;
        if (!name || (!identity && !row)) return null;
        return (
          <div className="integration-row app-connection-row" key={auth.connection}>
            <span className="app-logo" aria-hidden="true">
              <img
                src={`${import.meta.env.BASE_URL}apps/${appId}.svg`}
                alt=""
                width="24"
                height="24"
              />
            </span>
            <div className="integration-meta">
              <h3>{name}</h3>
              <p>
                {app?.publisher} · {t(states[auth.state])}
              </p>
              {accountOwner && bot === undefined && (
                <p className="field-help">
                  {t('apps.privateConnection', { 0: botName(accountOwner) })}
                </p>
              )}
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
                onClick={() => {
                  if (!disconnect && row?.boundBots?.length) {
                    setConfirmDisconnect({ target, name, bots: row.boundBots });
                    return;
                  }
                  return perform(() => disconnectAccount(target));
                }}
              >
                {t(disconnect ? 'apps.retryDisconnect' : 'apps.disconnect', { 0: name })}
              </button>
            </div>
          </div>
        );
      })}
      <details className="app-picker" open={!catalog?.connections.length}>
        <summary className="app-picker-heading">
          {t('apps.addApp')}
          <ChevronDown aria-hidden="true" />
        </summary>
        <ul className="app-grid" aria-label={t('apps.addApp')}>
          {apps
            .filter((app) => app.auth === 'oauth')
            .map((app) => (
              <li className="app-card" key={app.id}>
                <div className="app-card-heading">
                  <span className="app-logo" aria-hidden="true">
                    <img
                      src={`${import.meta.env.BASE_URL}apps/${app.id}.svg`}
                      alt=""
                      width="24"
                      height="24"
                    />
                  </span>
                  <div className="app-card-identity">
                    <h4>{app.publisher}</h4>
                    <p>
                      {t(
                        !app.available
                          ? 'apps.unavailable'
                          : app.adminApproval
                            ? 'apps.requiresAdmin'
                            : 'apps.browserAuthorization',
                      )}
                    </p>
                  </div>
                  <IconButton
                    className="app-connect"
                    label={t('apps.connect', { 0: app.publisher })}
                    disabled={disabled || !canAuthorize || !app.available}
                    onClick={() => open(app)}
                  >
                    <Link2 aria-hidden="true" />
                  </IconButton>
                </div>
                {!app.available && app.reason === 'OAUTH_NOT_VERIFIED' && (
                  <p className="app-card-note">{t('apps.unverified')}</p>
                )}
                <details className="app-details">
                  <summary>
                    {t('apps.details')}
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div className="app-details-content">
                    <p>{t('apps.publisher', { 0: app.publisher })}</p>
                    <p>{app.origin}</p>
                    {app.scope && <p>{t('apps.scope', { 0: app.scope })}</p>}
                    {app.adminApproval && <p>{t('apps.adminApproval')}</p>}
                  </div>
                </details>
              </li>
            ))}
        </ul>
        {canControl && (
          <button type="button" className="app-custom" disabled={disabled} onClick={onCustom}>
            <Plus aria-hidden="true" />
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
      {confirmDisconnect && (
        <Dialog
          title={t('apps.disconnect', { 0: confirmDisconnect.name })}
          onClose={() => setConfirmDisconnect(undefined)}
        >
          <p>{t('apps.affectedBots', { 0: confirmDisconnect.bots.map(botName).join(', ') })}</p>
          <p className="field-help">{t('apps.accountImpact')}</p>
          <div className="inline-form-actions">
            <button
              type="button"
              className="secondary"
              data-autofocus
              onClick={() => setConfirmDisconnect(undefined)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const { target } = confirmDisconnect;
                setConfirmDisconnect(undefined);
                return perform(() => disconnectAccount(target));
              }}
            >
              {t('apps.disconnect', { 0: confirmDisconnect.name })}
            </button>
          </div>
        </Dialog>
      )}
      {editor && (
        <Dialog
          title={
            <span className="app-authorization-title">
              <span className="app-logo" aria-hidden="true">
                <img src={`${import.meta.env.BASE_URL}apps/${editor.app}.svg`} alt="" />
              </span>
              <span>{t('apps.connect', { 0: editorApp?.publisher ?? editor.app })}</span>
            </span>
          }
          className="app-authorization"
          onClose={() => setEditor(undefined)}
          closeDisabled={busy}
        >
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <form
            className="app-authorization-form"
            onSubmit={async (event) => {
              event.preventDefault();
              await perform(() =>
                start({
                  ...(bot ? { bot } : {}),
                  app: editor.app,
                  connection: crypto.randomUUID(),
                  revision: 0,
                  name: editor.name.trim(),
                  requestId: crypto.randomUUID(),
                }),
              );
            }}
          >
            <p className="app-authorization-description">{t('apps.description')}</p>
            {editor.editName && (
              <label className="field-label">
                {t('integrations.connectionName')}
                <input
                  className="field"
                  data-autofocus
                  value={editor.name}
                  maxLength={60}
                  required
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                />
              </label>
            )}
            {editorApp?.scope && (
              <section className="app-authorization-scopes">
                <h3>{t('apps.scopeLabel')}</h3>
                <ul aria-label={t('apps.scopeLabel')}>
                  {editorApp.scope
                    .split(/\s+/)
                    .filter(Boolean)
                    .map((scope) => (
                      <li key={scope}>
                        <code>{scope}</code>
                      </li>
                    ))}
                </ul>
              </section>
            )}
            {editor.app === 'monday' && (
              <p className="app-authorization-notice">
                <Info aria-hidden="true" />
                <span>{t('apps.adminApproval')}</span>
              </p>
            )}
            <div className="app-authorization-actions">
              <button
                type="button"
                className="secondary"
                data-autofocus={editor.editName ? undefined : true}
                onClick={() => setEditor(undefined)}
                disabled={busy}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || !editor.name.trim() || !canAuthorize}
              >
                {t('apps.authorize')}
                <ArrowUpRight aria-hidden="true" />
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
