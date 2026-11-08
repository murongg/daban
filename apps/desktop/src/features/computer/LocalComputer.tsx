import {
  agentId,
  agentTask,
  isLocalComputerFrame,
  type LocalComputerCommand,
  type LocalComputerFrame,
  modelCatalog,
  modelHasVision,
} from '@daban/protocol';
import { Monitor, Pause, Play, Power, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { t } from '../../i18n/locale';
import { modelName } from '../models/model-options';
import { Permissions } from './Permissions';

type Consent = {
  command: Extract<LocalComputerCommand, { type: 'local.connect' }>;
  provider: string;
  model: string;
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
  function review() {
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
            {session.owner === 'human' ? t('localComputer.paused') : t('localComputer.connected')}
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
          <p className="field-help">{t('localComputer.shortcut', { 0: shortcut })}</p>
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
          <p className="field-help">{t('localComputer.shortcut', { 0: shortcut })}</p>
        </>
      )}
      {consent && (
        <Dialog
          title={t('localComputer.consentTitle', { 0: bot.name })}
          onClose={() => {
            if (!busy) setConsent(undefined);
          }}
          motion
        >
          <div className="local-consent">
            <ShieldCheck size={24} />
            <p>{t('localComputer.consentScope')}</p>
            <p>{t('localComputer.consentRecipient', { 0: consent.provider, 1: consent.model })}</p>
            <p className="field-help">{t('localComputer.shortcut', { 0: shortcut })}</p>
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
              disabled={busy}
              onClick={() => perform(consent.command)}
            >
              {busy ? t('common.connectingComputer') : t('localComputer.allow')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
