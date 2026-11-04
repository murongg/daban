import type {
  AppOAuthPhase,
  AppOAuthReceipt,
  AppOAuthStart,
  AppTarget,
  AppCatalog as Catalog,
  McpConnection,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
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
  receipt && ['preparing', 'waiting', 'exchanging'].includes(receipt.phase);
function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return t(
    code === 'OAUTH_BROWSER_UNAVAILABLE'
      ? 'apps.browserUnavailable'
      : code === 'OAUTH_CALLBACK_UNAVAILABLE' || code === 'OAUTH_INTERACTIVE_REQUIRED'
        ? 'apps.remoteUnavailable'
        : code === 'OAUTH_METADATA_REJECTED'
          ? 'apps.metadataRejected'
          : ['OAUTH_CONFLICT', 'MCP_NOT_FOUND', 'MCP_SHARED_READ_ONLY'].includes(code)
            ? 'apps.conflict'
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
}: AppCatalogProps) {
  useLocale();
  const runtime = useRuntime();
  const [catalog, setCatalog] = useState<Catalog>();
  const [name, setName] = useState<string>();
  const [pending, setPending] = useState<AppOAuthStart>();
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
    runtime.snapshot.phase === 'ready' && runtime.snapshot.appConnections?.catalog === true;
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  const dialogOpen = name !== undefined;
  const load = useCallback(async () => {
    const serial = ++reads.current;
    const value = await runtime.command<Catalog>({ type: 'app.catalog', bot });
    if (live.current && owner.current === bot && serial === reads.current) {
      setCatalog(value);
      onOAuthConnections(value.connections.map((c) => c.connection));
      const restored = value.attempts[0];
      if (!currentPending.current && !working.current && restored) {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Store revisions refresh public auth state without replacing the pending authorization.
  useEffect(() => {
    if (available)
      load().catch((e) => {
        if (live.current && owner.current === bot) setError(errorText(e));
      });
    return () => {
      reads.current++;
    };
  }, [available, bot, load, revision]);
  useEffect(() => {
    onDirty(busy || name !== undefined || (!!pending && !receipt) || !!disconnect);
    return () => {
      onDirty(false);
    };
  }, [busy, name, pending, receipt, disconnect, onDirty]);
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
    } catch (e) {
      if (live.current && owner.current === bot) setError(errorText(e));
    } finally {
      working.current = false;
      if (live.current && owner.current === bot) setBusy(false);
    }
  }
  const accept = useCallback(
    async (value: AppOAuthReceipt) => {
      if (!live.current || owner.current !== bot || value.bot !== bot) return;
      setReceipt(value);
      if (!activePhase(value)) {
        setPending(undefined);
        setNotice(t(phases[value.phase]));
        await onChanged();
        await load();
      }
    },
    [bot, onChanged, load],
  );
  async function start(input: AppOAuthStart) {
    setPending(input);
    setName(undefined);
    await accept(await runtime.command<AppOAuthReceipt>({ type: 'app.oauth.start', input }));
  }
  useEffect(() => {
    if (!receipt || !activePhase(receipt)) return;
    let querying = false,
      subscribed = true;
    const target = { bot: receipt.bot, connection: receipt.connection, revision: receipt.revision };
    const timer = setInterval(() => {
      if (querying) return;
      querying = true;
      runtime
        .command<AppOAuthReceipt>({ type: 'app.oauth.status', target, attempt: receipt.attempt })
        .then(async (value) => {
          if (subscribed && live.current && owner.current === bot) await accept(value);
        })
        .catch((e) => {
          if (subscribed && live.current && owner.current === bot) setError(errorText(e));
        })
        .finally(() => {
          querying = false;
        });
    }, 1000);
    return () => {
      subscribed = false;
      clearInterval(timer);
    };
  }, [receipt, runtime.command, bot, accept]);
  if (!available) return null;
  const notion = catalog?.apps.find((a) => a.id === 'notion');
  const disabled = busy || blocked || !!pending || !!disconnect;
  return (
    <section aria-label={t('apps.title')}>
      <h3>{t('apps.title')}</h3>
      <p className="setting-description">{t('apps.description')}</p>
      <div className="integration-row">
        <div className="integration-meta">
          <h3>{t('apps.notion')}</h3>
          <p>{t('apps.publisher', { 0: notion?.publisher ?? 'Notion' })}</p>
          <p>{notion?.origin}</p>
          {notion && !notion.available && (
            <p className="field-help">
              {t(
                notion.reason === 'OAUTH_CALLBACK_UNAVAILABLE'
                  ? 'apps.remoteUnavailable'
                  : 'apps.unverified',
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          className="secondary"
          disabled={disabled || !notion?.available}
          onClick={() => {
            setName('');
            setReceipt(undefined);
            setNotice('');
          }}
        >
          {t('apps.connectNotion')}
        </button>
      </div>
      <button type="button" className="secondary" disabled={disabled} onClick={onCustom}>
        {t('apps.custom')}
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="inline-note">
          {notice}
        </p>
      )}
      {receipt && activePhase(receipt) && <p role="status">{t(phases[receipt.phase])}</p>}
      {pending && (
        <div className="integration-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || blocked}
            onClick={() => perform(() => start(pending))}
          >
            {t('apps.retry')}
          </button>
          {receipt && activePhase(receipt) && (
            <button
              type="button"
              className="secondary"
              disabled={busy || blocked}
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
                  ),
                )
              }
            >
              {t('apps.cancel')}
            </button>
          )}
        </div>
      )}
      {catalog?.connections.map((auth) => {
        const row = rows.find((r) => r.id === auth.connection);
        if (!row) return null;
        return (
          <div className="integration-row" key={auth.connection}>
            <div className="integration-meta">
              <strong>{row.name}</strong>
              <p>{t(states[auth.state])}</p>
              {auth.scope && <p className="field-help">{t('apps.scope', { 0: auth.scope })}</p>}
            </div>
            <div className="integration-actions">
              <button
                type="button"
                className="secondary"
                disabled={disabled || !notion?.available}
                onClick={() =>
                  perform(() =>
                    start({
                      bot,
                      connection: row.id,
                      revision: row.revision,
                      app: 'notion',
                      requestId: crypto.randomUUID(),
                    }),
                  )
                }
              >
                {t('apps.reconnect', { 0: row.name })}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={
                  busy ||
                  blocked ||
                  !!pending ||
                  (auth.state === 'disconnected' && !disconnect) ||
                  (!!disconnect && disconnect.target.connection !== row.id)
                }
                onClick={() =>
                  perform(async () => {
                    const operation = disconnect ?? {
                      target: { bot, connection: row.id, revision: row.revision },
                      requestId: crypto.randomUUID(),
                    };
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
                {t(disconnect ? 'apps.retryDisconnect' : 'apps.disconnect', { 0: row.name })}
              </button>
            </div>
          </div>
        );
      })}
      {name !== undefined && (
        <Dialog
          title={t('apps.connectNotion')}
          onClose={() => setName(undefined)}
          closeDisabled={busy}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input: AppOAuthStart = {
                bot,
                app: 'notion',
                connection: crypto.randomUUID(),
                revision: 0,
                name: name.trim(),
                requestId: crypto.randomUUID(),
              };
              perform(() => start(input)).catch(() => {});
            }}
          >
            <label className="field-label">
              {t('integrations.connectionName')}
              <input
                className="field"
                value={name}
                maxLength={60}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="field-help">{t('apps.description')}</p>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {t('apps.authorize')}
            </button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
