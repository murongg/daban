import { agentId, computerTarget, recoveryBlocked } from '@daban/protocol';
import {
  Check,
  FileText,
  Folder,
  Globe,
  Maximize2,
  Monitor,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { t, useLocale } from '../../i18n/locale';
import { Browser } from '../browser/Browser';
import { LinuxSetup } from '../onboarding/LinuxSetup';
import { Connection } from './Connection';
import { LiveDesktop } from './LiveDesktop';
import { LocalComputer } from './LocalComputer';
export type ComputerSurface = 'desktop' | 'browser';

function VirtualComputer({
  bot,
  notify,
  expand,
  expanded = false,
  initialView = 'desktop',
  onRecovery,
}: {
  bot: Bot;
  notify: (message: string) => unknown;
  expand?: (view: ComputerSurface) => unknown;
  expanded?: boolean;
  initialView?: ComputerSurface;
  onRecovery?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime(),
    target = computerTarget(runtime.snapshot, bot.id),
    [busy, setBusy] = useState(false),
    [view, setView] = useState<ComputerSurface>(initialView);
  const computer = target ? runtime.snapshot.bots[target] : undefined;
  const managed = runtime.snapshot.protocolVersion >= 19;
  if (
    bot.archived &&
    !computer &&
    !runtime.snapshot.computers?.items.some((entry) => entry.bot === target && entry.reserved)
  )
    return (
      <div className="panel-section">
        <h2>{t('computer.botArchived')}</h2>
        <p className="panel-description">
          {t('computer.reconnectComputerRestoringRetainedHistoryFilesRemain')}
        </p>
      </div>
    );
  if (managed && target && !computer)
    return <Connection bot={target} name={bot.name} notify={notify} onRecovery={onRecovery} />;
  if (runtime.snapshot.computerError)
    return (
      <div className="panel-section">
        <h2>{t('computer.computerUnavailable')}</h2>
        <p className="panel-description">{t('computer.canStillChatWorkWorkspaceFilesUse')}</p>
      </div>
    );
  if (!target)
    return (
      <div className="panel-section">
        <h2>{t('computer.botCanChatButHasNoComputer')}</h2>
        <p className="panel-description">{t('computer.botCanStillChatUseWorkspaceTools')}</p>
      </div>
    );
  const human = computer?.owner === 'human',
    ready = runtime.snapshot.phase === 'ready' && !recoveryBlocked(runtime.snapshot);
  const apps = [
    ['terminal', Terminal, t('common.terminal')],
    ['files', Folder, t('common.fileManager')],
    ['editor', FileText, t('computer.editor')],
    ['browser', Globe, t('computer.sharedBrowser')],
  ] as const;
  return (
    <div className="computer-panel">
      <div className={`computer-info ${human ? 'human' : ''}`}>
        <span className="status-dot" />
        <span>
          {ready
            ? human
              ? t('common.control')
              : t('computer.linuxDesktopConnected')
            : t('computer.connectingRuntime')}
        </span>
        <span className="spacer" />
        <span className="muted">
          {bot.name}
          {t('common.sScreen')}
        </span>
        <div className="computer-actions">
          <button
            type="button"
            className="primary"
            disabled={!ready || !computer || busy || computer.owner === 'handoff'}
            onClick={async () => {
              if (!computer) return;
              setBusy(true);
              try {
                await runtime.command({
                  type: 'control',
                  bot: target,
                  epoch: computer.epoch,
                  ...(computer.instance === undefined ? {} : { instance: computer.instance }),
                  owner: human ? 'agent' : 'human',
                });
              } catch (error) {
                notify(runtimeError(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {human ? <Check /> : <Monitor />}
            {busy
              ? t('computer.handingOver')
              : human
                ? t('common.handBackBot')
                : t('common.takeOverComputer')}
          </button>
          {managed && target && (
            <Connection bot={target} name={bot.name} notify={notify} onRecovery={onRecovery} />
          )}
        </div>
      </div>
      {(runtime.snapshot.protocolVersion >= 16 || expand) && (
        <fieldset className="computer-toolbar" aria-label={t('computer.computerView')}>
          {runtime.snapshot.protocolVersion >= 16 ? (
            <nav className="computer-views" aria-label={t('computer.computerView')}>
              <button
                type="button"
                aria-pressed={view === 'desktop'}
                onClick={() => setView('desktop')}
              >
                <Monitor size={15} />
                {t('computer.linuxDesktop')}
              </button>
              <button
                type="button"
                aria-pressed={view === 'browser'}
                onClick={() => setView('browser')}
              >
                <Globe size={15} />
                {t('common.browser')}
              </button>
            </nav>
          ) : (
            <span className="computer-surface-name">{t('computer.linuxDesktop')}</span>
          )}
          {expand && (
            <IconButton label={t('common.expand')} onClick={() => expand(view)}>
              <Maximize2 />
            </IconButton>
          )}
        </fieldset>
      )}
      {view === 'browser' && runtime.snapshot.protocolVersion >= 16 ? (
        <Browser key={target} bot={target} name={bot.name} notify={notify} expanded={expanded} />
      ) : (
        <>
          <LiveDesktop
            key={target}
            bot={target}
            name={bot.name}
            owner={computer?.owner || 'agent'}
            epoch={computer?.epoch || 0}
            notify={notify}
            expanded={expanded}
          />
          <div className="native-app-buttons">
            {apps.map(([app, Icon, label]) => (
              <button
                type="button"
                key={app}
                disabled={!ready || !human || busy}
                onClick={async () => {
                  try {
                    await runtime.command({
                      type: 'app',
                      bot: target,
                      epoch: computer!.epoch,
                      ...(computer!.instance === undefined ? {} : { instance: computer!.instance }),
                      app,
                    });
                  } catch (error) {
                    notify(runtimeError(error));
                  }
                }}
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="computer-copy">
        <h2>{human ? t('common.computerYoursNow') : t('computer.seeActualOperationsHere')}</h2>
        <p>
          {human
            ? t('computer.botWaitsHandbackWhileOtherBotsCan')
            : !ready
              ? t('computer.viewSharedLoginStateReconnecting')
              : runtime.snapshot.protocolVersion >= 16
                ? t('computer.eachBotHasIndependentDesktopsTabsShared')
                : t('computer.twoBotsHaveIndependentDesktopsShareBrowser', {
                    0: runtime.snapshot.sharedLogin
                      ? t('computer.signed')
                      : t('computer.notSigned'),
                  })}
        </p>
      </div>
      <div className="computer-footer">
        <ShieldCheck />
        <span>
          {runtime.snapshot.protocolVersion >= 16
            ? t('computer.localLinuxIndependentScreensSharedFilesBrowser')
            : t('computer.localLinuxIndependentScreensSharedFilesExample')}
        </span>
      </div>
    </div>
  );
}

export function Computer(props: Parameters<typeof VirtualComputer>[0]) {
  const runtime = useRuntime();
  const local = runtime.snapshot.localComputer;
  const optionalLinux = runtime.snapshot.setup?.target === 'linux';
  const nativeOnly = runtime.snapshot.agent?.execution === 'local-workspace';
  const canonical = agentId(props.bot.id);
  const [source, setSource] = useState<'vm' | 'local'>(nativeOnly ? 'local' : 'vm');
  useEffect(() => {
    if ((nativeOnly && !optionalLinux) || local?.session?.bot === canonical) setSource('local');
  }, [nativeOnly, optionalLinux, local?.session?.bot, canonical]);
  async function choose(next: 'vm' | 'local') {
    if (next === 'vm' && local?.session?.bot === canonical) {
      if (runtime.snapshot.agents[canonical]?.running) return;
      try {
        await runtime.command({
          type: 'local.disconnect',
          session: local.session.id,
          revision: local.session.revision,
        });
      } catch (error) {
        props.notify(runtimeError(error));
        return;
      }
    }
    setSource(next);
  }
  return (
    <>
      {local && (!nativeOnly || optionalLinux) && !props.expanded && (
        <nav className="computer-modes" aria-label={t('localComputer.source')}>
          {(!nativeOnly || optionalLinux) && (
            <button type="button" aria-pressed={source === 'vm'} onClick={() => choose('vm')}>
              {t('localComputer.virtual')}
            </button>
          )}
          <button type="button" aria-pressed={source === 'local'} onClick={() => choose('local')}>
            {local.platform === 'win32' ? t('localComputer.windows') : t('localComputer.mac')}
          </button>
        </nav>
      )}
      {source === 'local' && local ? (
        <LocalComputer bot={props.bot} />
      ) : nativeOnly && optionalLinux && runtime.snapshot.setup?.required ? (
        <LinuxSetup />
      ) : (
        <VirtualComputer {...props} />
      )}
    </>
  );
}
