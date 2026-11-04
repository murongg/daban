import {
  Archive,
  Database,
  Download,
  Info,
  Monitor,
  Moon,
  Plug,
  Settings2,
  Sun,
  Waypoints,
} from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';
import { serialize } from '../../app/storage';
import { Dialog } from '../../components/controls/Dialog';
import { isMessageKey, t, useLocale } from '../../i18n/locale';
import { ArchiveList } from '../bots/Archive';
import { Diagnostics } from '../computer/Diagnostics';
import { RecoveryEntry } from '../computer/Recovery';
import { download } from '../files/files';
import { Integrations } from '../integrations/Integrations';
import { Models } from '../models/Models';
import { Notifications } from '../notifications/Notifications';
import { LinuxSetup } from '../onboarding/LinuxSetup';
import { AgentUpgradePanel } from './AgentUpgrade';
import { Language } from './Language';
import { UpdatesPanel } from './Updates';
import { VirtualMachine } from './VirtualMachine';
import '../../styles/settings.css';

export function Settings({
  state,
  dispatch,
  onClose,
  active = true,
  onLifecycle,
  onRecovery,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  onClose: () => unknown;
  active?: boolean;
  onLifecycle?: (bot: string) => unknown;
  onRecovery?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const nativeOnly = runtime.snapshot.agent?.execution === 'local-workspace';
  const [category, setCategory] = useState('general');
  const [error, setError] = useState('');
  const [connectionDialog, setConnectionDialog] = useState(false);
  const [updateDialog, setUpdateDialog] = useState(false);
  const sections = [
    {
      id: 'general',
      label: t('settings.general'),
      icon: Settings2,
      description: t('settings.adjustAppearanceNotificationsSuitWorkflow'),
      content: (
        <>
          <div className="settings-section">
            <h2>{t('settings.appearance')}</h2>
            <div className="setting-row">
              <div>
                <div className="setting-label">{t('settings.theme')}</div>
                <p className="setting-description">{t('settings.chooseAppearanceWorkspace')}</p>
              </div>
              <fieldset className="theme-options" aria-label={t('settings.theme')}>
                <button
                  type="button"
                  aria-pressed={state.theme === 'light'}
                  onClick={() => dispatch({ type: 'theme', theme: 'light' })}
                >
                  <Sun />
                  {t('settings.light')}
                </button>
                <button
                  type="button"
                  aria-pressed={state.theme === 'dark'}
                  onClick={() => dispatch({ type: 'theme', theme: 'dark' })}
                >
                  <Moon />
                  {t('settings.dark')}
                </button>
              </fieldset>
            </div>
          </div>
          <div className="settings-section">
            <h2>{t('settings.languageSection')}</h2>
            <div className="setting-row">
              <div>
                <div className="setting-label">{t('settings.language')}</div>
                <p className="setting-description">
                  {t('settings.appliesImmediatelySavedComputer')}
                </p>
              </div>
              <Language />
            </div>
          </div>
          <Notifications />
        </>
      ),
    },
    {
      id: 'models',
      label: t('models.title'),
      icon: Waypoints,
      description: t('settings.connectModelServicesChooseWorkspacePerBot'),
      content: <Models />,
    },
    {
      id: 'computer',
      label: t('settings.computerPermissions'),
      icon: Monitor,
      description: nativeOnly
        ? t('localComputer.description')
        : t('settings.manageLocalLinuxConnectionStateActionPermissions'),
      content: (
        <>
          {runtime.snapshot.agent?.execution === 'linux-vm' && (
            <div className="settings-section">
              <h2>{t('settings.executionEnvironmentPermissions')}</h2>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.fullPermissionsInsideVm')}</div>
                  <p className="setting-description">
                    {t('settings.botsCanManageLinuxUseSudoNetwork')}
                  </p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.hostAgentService')}</div>
                  <p className="setting-description">
                    {t('settings.modelsKeysApprovalsStayOutsideVmBackground')}
                  </p>
                </div>
              </div>
            </div>
          )}
          <div className="settings-section">
            <h2>{nativeOnly ? t('localComputer.computer') : t('settings.localLinux')}</h2>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="setting-row">
              <div>
                <div className="setting-label">
                  {nativeOnly ? t('localComputer.computer') : t('settings.localLinuxRuntime')}
                </div>
                <p className="setting-description">
                  {runtime.enabled
                    ? (isMessageKey(runtime.snapshot.error)
                        ? t(runtime.snapshot.error)
                        : runtime.snapshot.error) ||
                      (nativeOnly
                        ? t('localComputer.settingsDescription')
                        : t('settings.botDesktopsTasksFilesRunLocalVirtual'))
                    : t('settings.computerPanelExamplePreviewNoRealTerminal')}
                </p>
              </div>
              {runtime.enabled ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    setError('');
                    try {
                      await runtime.command({ type: 'connect' });
                    } catch (error) {
                      setError(runtimeError(error));
                    }
                  }}
                >
                  {runtime.snapshot.phase === 'ready'
                    ? t('settings.reconnect')
                    : t('settings.retryConnection')}
                </button>
              ) : (
                <span className="badge">{t('settings.notConnected')}</span>
              )}
            </div>
          </div>
          <AgentUpgradePanel onDialogChange={setConnectionDialog} />
          <LinuxSetup />
          <VirtualMachine />
          {!nativeOnly && (
            <div className="settings-section">
              <h2>{t('settings.runtime')}</h2>
              <Diagnostics />
              <RecoveryEntry open={onRecovery} />
            </div>
          )}
        </>
      ),
    },
    {
      id: 'integrations',
      label: t('common.externalTools'),
      icon: Plug,
      description: t('settings.connectMcpServicesManageExternalToolsBots'),
      content: <Integrations bots={state.bots} onDialogChange={setConnectionDialog} />,
    },
    {
      id: 'archive',
      label: t('settings.archives'),
      icon: Archive,
      description: t('settings.viewArchivedBotsGroupsRestoreThemWhen'),
      content: <ArchiveList state={state} dispatch={dispatch} onAction={onLifecycle} />,
    },
    {
      id: 'data',
      label: t('settings.dataStorage'),
      icon: Database,
      description: t('settings.seeWhatStoredLocallyExportWorkspaceCopy'),
      content: (
        <div className="settings-section">
          <h2>{t('settings.workspaceData')}</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">{t('settings.localWorkspaceData')}</div>
              <p className="setting-description">
                {t('settings.appStoresChatCachesDraftsPreferenceCopies')}
              </p>
            </div>
            <span className="badge">{t('settings.localStorage')}</span>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">{t('settings.exportWorkspace')}</div>
              <p className="setting-description">
                {t('settings.exportJsonCopyPrivateChatCachesDrafts')}
              </p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                download({
                  id: 'workspace-export',
                  name: 'daban-workspace.json',
                  kind: 'JSON',
                  size: '',
                  modified: '',
                  content: serialize(state),
                })
              }
            >
              <Download />
              {t('settings.export')}
            </button>
          </div>
        </div>
      ),
    },
    {
      id: 'about',
      label: t('settings.about'),
      icon: Info,
      description: t('settings.versionInformationFuturePlans'),
      content: (
        <div className="settings-section">
          <h2>{t('common.aboutDaban')}</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">Daban</div>
              <p className="setting-description">{t('settings.aiWorkCompanion')}</p>
            </div>
          </div>
          <p className="inline-note">
            {runtime.enabled
              ? nativeOnly
                ? t('localComputer.settingsDescription')
                : t('settings.localLinuxDshConnectedMobileCrossDevice')
              : t('settings.previewIncludesOnlyAppInterfaceMobileCross')}
          </p>
          <UpdatesPanel onDialogChange={setUpdateDialog} />
        </div>
      ),
    },
  ];
  return (
    <Dialog
      title={t('settings.title')}
      onClose={onClose}
      active={active && !connectionDialog && !updateDialog}
      className="settings-dialog"
      motion
    >
      <Tabs
        orientation="vertical"
        selectedKey={category}
        onSelectionChange={(key) => setCategory(String(key))}
        className="settings-layout"
      >
        <TabList
          aria-label={t('settings.settingsCategories')}
          className="settings-nav"
          items={sections}
        >
          {(section) => (
            <Tab
              id={section.id}
              className="settings-tab"
              data-autofocus={category === section.id || undefined}
            >
              <section.icon aria-hidden="true" />
              <span>{section.label}</span>
            </Tab>
          )}
        </TabList>
        {/* Keep editors mounted while switching categories; closing this dialog still clears private key drafts. */}
        {sections.map((section) => (
          <TabPanel
            key={section.id}
            id={section.id}
            shouldForceMount
            hidden={category !== section.id}
            className="settings-panel"
          >
            <header className="settings-heading">
              <h3>{section.label}</h3>
              <p>{section.description}</p>
            </header>
            {section.content}
          </TabPanel>
        ))}
      </Tabs>
    </Dialog>
  );
}
