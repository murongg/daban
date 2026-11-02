import { Check, FileText, Folder, Globe, Monitor, ShieldCheck, Terminal, Wifi } from 'lucide-react';
import { useState } from 'react';
import { Tooltip } from '../../components/controls/Tooltip';
import { t, useLocale } from '../../i18n/locale';

type App = 'document' | 'files' | 'terminal' | 'browser';
export function Desktop({
  name,
  human,
  expanded = false,
}: {
  name: string;
  human: boolean;
  expanded?: boolean;
}) {
  useLocale();
  const [app, setApp] = useState<App>('document');
  const apps = [
    ['files', Folder, t('common.fileManager')],
    ['browser', Globe, t('common.browser')],
    ['terminal', Terminal, t('common.terminal')],
    ['document', FileText, t('desktop.document')],
  ] as const;
  return (
    <section
      className={`desktop-preview ${expanded ? 'fullscreen-desktop' : ''}`}
      aria-label={t('desktop.exampleLinuxDesktop', { 0: name })}
    >
      <div className="desktop-topbar">
        <Monitor />
        <span>Daban</span>
        <span className="spacer" />
        <span>{t('desktop.exampleDesktop')}</span>
        <Wifi />
        <span>10:28</span>
      </div>
      <div className="desktop-wallpaper" />
      {human && <div className="desktop-control-state">{t('desktop.controlDemo')}</div>}
      <div className="desktop-window">
        <div className="window-bar">
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-path">
            <ShieldCheck />
            {app === 'terminal'
              ? t('desktop.terminalPreview', { 0: name })
              : app === 'files'
                ? t('desktop.workspaceSharedFiles')
                : app === 'browser'
                  ? t('desktop.workspaceExampleTestExamplePage')
                  : t('desktop.workspaceWeeklyReportDraft')}
          </span>
        </div>
        {app === 'terminal' ? (
          <div className="desktop-terminal">
            <span className="terminal-prompt">bot@daban:~$</span> ls /workspace
            <br />
            {t('desktop.weeklyWorkSummaryMd')}
            <br />
            {t('desktop.projectNotesMd')}
            <br />
            {t('desktop.doListCsv')}
            <br />
            {t('desktop.productIntroductionMd')}
            <br />
            <br />
            <span className="terminal-prompt">bot@daban:~$</span> <span>▏</span>
            <p className="terminal-note">
              {t('desktop.terminalInterfacePreview')}
              <br />
              {t('desktop.linuxRuntimeNotConnected')}
            </p>
          </div>
        ) : app === 'files' ? (
          <div className="desktop-folder">
            <div className="desktop-folder-title">{t('desktop.sharedWorkspaceWorkspace')}</div>
            {[
              t('desktop.weeklyWorkSummaryMd'),
              t('desktop.projectNotesMd'),
              t('desktop.doListCsv'),
              t('desktop.productIntroductionMd'),
            ].map((text, i) => (
              <div className="desktop-folder-row" key={text}>
                <FileText />
                <span>{text}</span>
                <small>{['2.4 KB', '1.8 KB', '0.6 KB', '1.2 KB'][i]}</small>
              </div>
            ))}
          </div>
        ) : (
          <div className="document">
            <h2>{t('desktop.weeklyWorkSummary')}</h2>
            <p className="document-meta">{t('desktop.weekDraftExampleContent')}</p>
            <h3>{t('desktop.weekSProgress')}</h3>
            {[
              t('desktop.projectReferenceOrganizationArchiving'),
              t('desktop.productReferencesInitialProposal'),
              t('desktop.firstVersionContentDocumentation'),
            ].map((text) => (
              <div className="document-row" key={text}>
                <span>{text}</span>
                <small>{t('common.completed')}</small>
              </div>
            ))}
            <h3>{t('desktop.needsConfirmation')}</h3>
            {[t('desktop.nextReviewDate'), t('desktop.prioritiesNextWeek')].map((text) => (
              <div className="document-row pending" key={text}>
                <span>{text}</span>
                <small>{t('common.awaitingConfirmation')}</small>
              </div>
            ))}
            <p className="document-foot">
              <Check />
              {t('desktop.organizedDocumentsNothingSentExternally')}
            </p>
          </div>
        )}
      </div>
      <fieldset className="desktop-dock" aria-label={t('desktop.desktopApplicationPreview')}>
        {apps.map(([id, Icon, label]) => (
          <Tooltip label={t('desktop.preview', { 0: label })} key={id}>
            <button
              type="button"
              className={app === id ? 'active' : ''}
              aria-label={t('desktop.preview', { 0: label })}
              aria-pressed={app === id}
              onClick={() => setApp(id)}
            >
              <Icon />
            </button>
          </Tooltip>
        ))}
      </fieldset>
    </section>
  );
}
