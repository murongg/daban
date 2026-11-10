import {
  agentId,
  agentTask,
  isLocalComputerFrame,
  isLocalComputerWindow,
  type LocalComputerCommand,
  type LocalComputerFrame,
  type LocalComputerWindow,
  modelCatalog,
  modelHasVision,
} from '@daban/protocol';
import { Monitor, Pause, Play, Power, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { t } from '../../i18n/locale';
import { modelName } from '../models/model-options';
import { Permissions } from './Permissions';

type Consent = {
  command: Extract<LocalComputerCommand, { type: 'local.connect' }>;
  provider: string;
  model: string;
  windows?: LocalComputerWindow[];
  scope: string;
};
export function LocalComputer({ bot }: { bot: Bot }) {
  const runtime = useRuntime(),
    status = runtime.snapshot.localComputer,
    target = agentId(bot.id);
  const session = status?.session?.bot === target ? status.session : undefined;
  const [consent, setConsent] = useState<Consent>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [frame, setFrame] = useState<LocalComputerFrame>();
  const epoch = useRef(0);
  const profile = runtime.snapshot.profiles.find((item) => item.id === target);
  const selected = profile?.model || bot.model || runtime.snapshot.model.model;
  const vision = modelHasVision(selected, modelCatalog(runtime.snapshot.model.connections));
  const task = agentTask(runtime.snapshot, bot.id);
  const shortcut = status?.platform === 'win32' ? 'Ctrl + Alt + Esc' : 'Ctrl + Option + Esc';
  const permissions = status?.permissions.screen && status.permissions.accessibility;
  const other = status?.session && !session;
  const sessionId = session?.id,
    sessionRevision = session?.revision;
  const shortcutHint = (background?: string) =>
    t(background ? 'localComputer.windowShortcut' : 'localComputer.shortcut', { 0: shortcut });
  useEffect(() => {
    if (status?.platform !== 'darwin' || permissions) return;
    let active = true;
    const check = () => {
      // Returning from System Settings only observes permissions; it never opens settings or grants a session.
      runtime.command({ type: 'local.status' }).catch((error) => {
        if (active) setError(runtimeError(error));
      });
    };
    window.addEventListener('focus', check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
    };
  }, [status?.platform, permissions, runtime.command]);
  useEffect(() => {
    const ticket = ++epoch.current;
    setFrame(undefined);
    if (sessionId && sessionRevision !== undefined)
      runtime
        .command({ type: 'local.preview', session: sessionId, revision: sessionRevision })
        .then((value) => {
          if (
            ticket === epoch.current &&
            isLocalComputerFrame(value) &&
            value.session === sessionId &&
            value.bot === target
          )
            setFrame(value);
        })
        .catch(() => {});
    return () => {
      epoch.current++;
    };
  }, [sessionId, sessionRevision, target, runtime.command]);
  async function perform(command: LocalComputerCommand) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await runtime.command(command);
      if (command.type === 'local.connect') setConsent(undefined);
    } catch (error) {
      setError(runtimeError(error));
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    const entry = modelCatalog(runtime.snapshot.model.connections).find(
      (item) => item.id === selected,
    );
    const connection = runtime.snapshot.model.connections?.find(
      (item) => item.id === entry?.provider,
    );
    let provider = connection?.name || runtime.snapshot.model.provider;
    if (connection?.baseURL) {
      try {
        provider += ` (${new URL(connection.baseURL).origin})`;
      } catch {
        /* Configuration validation owns endpoint correctness. */
      }
    }
    setError('');
    let windows: LocalComputerWindow[] | undefined;
    if (status?.platform === 'darwin') {
      setBusy(true);
      try {
        const value = await runtime.command({ type: 'local.windows' });
        windows = Array.isArray(value) ? value.filter(isLocalComputerWindow) : [];
      } catch (error) {
        windows = [];
        setError(runtimeError(error));
      } finally {
        setBusy(false);
      }
    }
    setConsent({
      command: {
        type: 'local.connect',
        id: crypto.randomUUID(),
        bot: target,
        model: selected,
        modelRevision: runtime.snapshot.model.revision ?? 0,
      },
      provider,
      model: modelName(selected, runtime.snapshot.model.connections),
      windows,
      scope: windows ? '' : 'desktop',
    });
  }
  if (!status) return <p className="panel-description">{t('localComputer.updateRequired')}</p>;
  return (
    <div className="panel-section local-computer">
      <div className="panel-heading">
        <h2>{status.platform === 'win32' ? t('localComputer.windows') : t('localComputer.mac')}</h2>
        <Monitor size={18} />
      </div>
      <p className="panel-description">{t('localComputer.description')}</p>
      {status.platform === 'darwin' && (
        <Permissions
          status={status}
          busy={busy}
          request={() => perform({ type: 'local.permissions' })}
          check={() => perform({ type: 'local.status' })}
        />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {status.error && <p className="inline-note">{runtimeError(new Error(status.error))}</p>}
      {session ? (
        <>
          <div className="local-computer-state">
            <span className={`status-dot ${session.owner === 'agent' ? 'ready' : ''}`} />
            {session.owner === 'human'
              ? t('localComputer.paused')
              : session.window
                ? t('localComputer.windowConnected', { 0: session.window })
                : t('localComputer.connected')}
            <span className="spacer" />
            <IconButton
              label={t('localComputer.disconnect')}
              disabled={busy}
              onClick={() =>
                perform({
                  type: 'local.disconnect',
                  session: session.id,
                  revision: session.revision,
                })
              }
            >
              <Power />
            </IconButton>
          </div>
          <button
            type="button"
            className="primary"
            disabled={
              busy || (session.owner === 'human' && (!task?.running || task.phase === 'waiting'))
            }
            onClick={() =>
              perform({
                type: session.owner === 'agent' ? 'local.pause' : 'local.resume',
                session: session.id,
                revision: session.revision,
              })
            }
          >
            {session.owner === 'agent' ? <Pause size={15} /> : <Play size={15} />}
            {session.owner === 'agent' ? t('localComputer.pause') : t('localComputer.resume')}
          </button>
          <p className="field-help">{shortcutHint(session.window)}</p>
          {frame ? (
            <figure className="local-observation">
              <img src={frame.image} alt={t('localComputer.lastObservation')} />
              <figcaption>{t('localComputer.lastObservation')}</figcaption>
            </figure>
          ) : (
            <div className="local-computer-empty">
              <Monitor />
              <p>{t('localComputer.noObservation')}</p>
            </div>
          )}
        </>
      ) : (
        <>
          {other && <p className="inline-note">{t('localComputer.occupied')}</p>}
          {!vision && <p className="inline-note">{t('localComputer.requiresVision')}</p>}
          {task?.running && <p className="inline-note">{t('localComputer.taskBusy')}</p>}
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              !status.available ||
              !permissions ||
              !status.shortcut ||
              !vision ||
              !!other ||
              !!task?.running ||
              !!bot.archived ||
              runtime.snapshot.phase !== 'ready'
            }
            onClick={review}
          >
            <Monitor size={15} />
            {t('localComputer.connect')}
          </button>
          {status.platform !== 'darwin' && <p className="field-help">{shortcutHint()}</p>}
        </>
      )}
      {consent && (
        <Dialog
          title={t('localComputer.consentTitle', { 0: bot.name })}
          closeDisabled={busy}
          onClose={() => setConsent(undefined)}
        >
          <div className="local-consent">
            <ShieldCheck size={24} />
            {consent.windows && (
              <Select
                label={t('localComputer.scope')}
                value={consent.scope}
                disabled={busy}
                onValueChange={(scope) => setConsent({ ...consent, scope })}
                options={[
                  ...consent.windows.map(({ id, name }) => ({ value: id, label: name })),
                  { value: 'desktop', label: t('localComputer.fullDesktop') },
                ]}
              />
            )}
            {consent.scope && (
              <p>
                {t(
                  consent.scope === 'desktop'
                    ? 'localComputer.consentScope'
                    : 'localComputer.windowScope',
                )}
              </p>
            )}
            <p>{t('localComputer.consentRecipient', { 0: consent.provider, 1: consent.model })}</p>
            {consent.scope && (
              <p className="field-help">
                {shortcutHint(consent.scope === 'desktop' ? undefined : consent.scope)}
              </p>
            )}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConsent(undefined)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !consent.scope}
              onClick={() =>
                perform({
                  ...consent.command,
                  ...(consent.scope === 'desktop' ? {} : { window: consent.scope }),
                })
              }
            >
              {busy ? t('common.connectingComputer') : t('localComputer.allow')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
