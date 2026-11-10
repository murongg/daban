import {
  agentId,
  agentTask,
  browserApprovalProtocol,
  type HostBrowserRequest,
  recoveryBlocked,
} from '@daban/protocol';
import {
  ArrowLeft,
  ArrowRight,
  Bot as BotIcon,
  Globe,
  Hand,
  Maximize2,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { Tooltip } from '../../components/controls/Tooltip';
import { t } from '../../i18n/locale';
import { Browser } from './Browser';

export function HostBrowser({
  bot,
  notify,
  expanded = false,
  expand,
}: {
  bot: Bot;
  notify: (message: string) => unknown;
  expanded?: boolean;
  expand?: () => unknown;
}) {
  const runtime = useRuntime();
  const target = agentId(bot.id);
  const status = runtime.snapshot.hostBrowser;
  const connection = status?.connections.find((item) => item.bot === target);
  const task = agentTask(runtime.snapshot, bot.id);
  const onDemand = runtime.snapshot.computerAccess === true;
  const { command } = runtime;
  const canReadPermission =
    !onDemand &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= browserApprovalProtocol &&
    !!status?.available &&
    !bot.archived;
  const [permission, setPermission] = useState<{ bot: string; enabled: boolean }>();
  const permissionHelp = useId();
  useEffect(() => {
    if (!canReadPermission) return;
    let current = true;
    command<{ bot: string; enabled: boolean }>({
      type: 'hostBrowser',
      request: { action: 'autoStart', bot: target },
    })
      .then((value) => {
        if (current) setPermission(value);
      })
      .catch(() => {
        // Older hosts do not support reading this setting.
        if (current) setPermission(undefined);
      });
    return () => {
      current = false;
    };
  }, [canReadPermission, command, target]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocked =
    busy ||
    runtime.snapshot.phase !== 'ready' ||
    !status?.available ||
    !!bot.archived ||
    recoveryBlocked(runtime.snapshot);
  async function perform(request: HostBrowserRequest) {
    if (blocked) return;
    setBusy(true);
    setError('');
    try {
      if (request.action === 'autoStart') {
        const saved = await command<{ bot: string; enabled: boolean }>({
          type: 'hostBrowser',
          request,
        });
        setPermission((current) => (current?.bot === saved.bot ? saved : current));
      } else await command({ type: 'hostBrowser', request });
    } catch (error) {
      setError(runtimeError(error));
    } finally {
      setBusy(false);
    }
  }
  const human = connection?.owner === 'human';
  const controlLabel = t(human ? 'common.handBackBot' : 'hostBrowser.takeOver');
  const controls = connection && (
    <>
      <Tooltip label={controlLabel}>
        <button
          type="button"
          className="host-control-button"
          aria-label={controlLabel}
          disabled={blocked || connection.owner === 'handoff'}
          onClick={() =>
            perform({
              action: 'control',
              bot: target,
              instance: connection.state.instance,
              epoch: connection.epoch,
              owner: human ? 'agent' : 'human',
            })
          }
        >
          {human ? <BotIcon size={15} /> : <Hand size={15} />}
          <span>{t(human ? 'hostBrowser.handBackShort' : 'hostBrowser.takeOverShort')}</span>
        </button>
      </Tooltip>
      {expand && (
        <IconButton label={t('common.expand')} onClick={expand}>
          <Maximize2 />
        </IconButton>
      )}
      <IconButton
        label={t('hostBrowser.disconnect')}
        disabled={blocked || !!task?.running}
        onClick={() =>
          perform({
            action: 'close',
            bot: target,
            instance: connection.state.instance,
            epoch: connection.epoch,
          })
        }
      >
        <Power />
      </IconButton>
    </>
  );
  return (
    <section
      className={`host-browser ${expanded ? 'expanded' : ''}`}
      aria-label={t('hostBrowser.title')}
    >
      {connection ? (
        <Browser
          key={connection.state.instance}
          bot={target}
          name={bot.name}
          host
          notify={notify}
          expanded={expanded}
          toolbar={controls}
        />
      ) : (
        <>
          <div className="browser-tabs host-empty-tabs">
            <div className="browser-tab active">
              <Globe size={13} />
              <span>{t('common.newTab')}</span>
            </div>
            <IconButton label={t('browser.newBrowserTab')} disabled>
              <Plus />
            </IconButton>
            <span className="host-tab-caption">Daban</span>
          </div>
          <form
            className="browser-address"
            aria-label={t('hostBrowser.navigation')}
            onSubmit={(event) => event.preventDefault()}
          >
            <IconButton label={t('browser.previousPage')} disabled>
              <ArrowLeft />
            </IconButton>
            <IconButton label={t('browser.nextPage')} disabled>
              <ArrowRight />
            </IconButton>
            <IconButton label={t('browser.reloadWebpage')} disabled>
              <RefreshCw />
            </IconButton>
            <div className="browser-location">
              <Search size={14} />
              <input
                aria-label={t('browser.webpageUrl')}
                placeholder={t('browser.enterUrl')}
                disabled
              />
            </div>
          </form>
          <div className="host-browser-new-tab">
            <div className="host-browser-wordmark">Daban</div>
            <p className="host-browser-tagline">{t('hostBrowser.startTitle')}</p>
            {onDemand ? (
              <p className="host-browser-scope">{t('localComputer.onDemand')}</p>
            ) : (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={blocked || !!task?.running}
                  onClick={() => perform({ action: 'open', bot: target })}
                >
                  <Globe size={15} />
                  {busy ? t('common.connectingComputer') : t('hostBrowser.open')}
                </button>
                <p className="host-browser-scope">{t('hostBrowser.consentBrief')}</p>
              </>
            )}
          </div>
        </>
      )}
      {(error || (!connection && status?.error)) && (
        <p role="alert" className="browser-feedback host-browser-error">
          {error || runtimeError(new Error(status?.error))}
        </p>
      )}
      <footer className="host-browser-statusbar">
        <span role="status">
          {connection ? (
            <>
              <span className="status-dot" />
              {t(human ? 'hostBrowser.humanShort' : 'hostBrowser.connected')}
            </>
          ) : (
            <>
              <ShieldCheck size={13} />
              {t('hostBrowser.profileLabel')}
            </>
          )}
        </span>
        <details className="host-browser-about">
          <summary>{t('hostBrowser.about')}</summary>
          {!onDemand && permission?.bot === target && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={permission.enabled}
                  disabled={blocked || !!task?.running}
                  aria-describedby={permissionHelp}
                  onChange={(event) =>
                    perform({ action: 'autoStart', bot: target, enabled: event.target.checked })
                  }
                />{' '}
                {t('hostBrowser.autoStart')}
              </label>
              <p id={permissionHelp}>{t('hostBrowser.autoStartHelp')}</p>
            </>
          )}
          <p>{t('hostBrowser.signInHelp')}</p>
          <p>{t('hostBrowser.consent')}</p>
          <p>{t('hostBrowser.handbackHelp')}</p>
        </details>
      </footer>
    </section>
  );
}
