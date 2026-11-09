import {
  Archive,
  Database,
  Download,
  Info,
  Monitor,
  Moon,
  Plug,
  Search as SearchIcon,
  Settings2,
  Sun,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { type Dispatch, type ReactNode, useState } from 'react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';
import { serialize } from '../../app/storage';
import { Dialog } from '../../components/controls/Dialog';
import { Help } from '../../components/controls/Help';
import { isMessageKey, t, useLocale } from '../../i18n/locale';
import { ArchiveList } from '../bots/Archive';
import { TrashList } from '../chat/ConversationTrash';
import type { TrashController } from '../chat/useTrash';
import { Diagnostics } from '../computer/Diagnostics';
import { RecoveryEntry } from '../computer/Recovery';
import { download } from '../files/files';
import { Integrations } from '../integrations/Integrations';
import { Models } from '../models/Models';
import { Notifications } from '../notifications/Notifications';
import { LinuxSetup } from '../onboarding/LinuxSetup';
import { Search } from '../search/Search';
import { AgentUpgradePanel } from './AgentUpgrade';
import { Language } from './Language';
import { UpdatesPanel } from './Updates';
import { VirtualMachine } from './VirtualMachine';
import '../../styles/settings.css';

function SettingLabel({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="setting-title">
      <span className="setting-label">{label}</span>
      {children && <Help topic={label}>{children}</Help>}
    </div>
  );
}

export function Settings({
  state,
  dispatch,
  onClose,
  inline = false,
  active = true,
  onLifecycle,
  onRecovery,
  trash,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  onClose: () => unknown;
  inline?: boolean;
  active?: boolean;
  onLifecycle?: (bot: string) => unknown;
  onRecovery?: () => unknown;
  trash?: TrashController;
}) {
  useLocale();
  const runtime = useRuntime();
  const preparation =
    runtime.snapshot.setup?.target === 'agent' && runtime.snapshot.setup.required
      ? runtime.snapshot.setup
      : undefined;
  const preparing =
    !!preparation &&
    ['downloading', 'extracting', 'verifying', 'cancelling'].includes(preparation.phase);
  const nativeOnly = runtime.snapshot.agent?.execution === 'local-workspace';
  const computerLabel = nativeOnly ? t('localComputer.computer') : t('settings.localLinuxRuntime');
  const connectionError = runtime.snapshot.error;
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
              <SettingLabel label={t('settings.theme')}>
                {t('settings.chooseAppearanceWorkspace')}
              </SettingLabel>
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
              <SettingLabel label={t('settings.language')}>
                {t('settings.appliesImmediatelySavedComputer')}
              </SettingLabel>
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
      id: 'search',
      label: t('search.title'),
      icon: SearchIcon,
      description: t('search.description'),
      content: <Search />,
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
          {(runtime.snapshot.agent?.execution === 'linux-vm' ||
            runtime.snapshot.linux?.available) && (
            <div className="settings-section">
              <h2>{t('settings.executionEnvironmentPermissions')}</h2>
              <div className="setting-row">
                <SettingLabel label={t('settings.fullPermissionsInsideVm')}>
                  {t('settings.botsCanManageLinuxUseSudoNetwork')}
                </SettingLabel>
              </div>
              <div className="setting-row">
                <SettingLabel label={t('settings.hostAgentService')}>
                  {t('settings.modelsKeysApprovalsStayOutsideVmBackground')}
                </SettingLabel>
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
                <SettingLabel label={computerLabel}>
                  {runtime.enabled &&
                    (nativeOnly
                      ? t('localComputer.settingsDescription')
                      : t('settings.botDesktopsTasksFilesRunLocalVirtual'))}
                </SettingLabel>
                {runtime.enabled ? (
                  connectionError && (
                    <p className="setting-description">
                      {isMessageKey(connectionError) ? t(connectionError) : connectionError}
                    </p>
                  )
                ) : (
                  <p className="setting-description">
                    {t('settings.computerPanelExamplePreviewNoRealTerminal')}
                  </p>
                )}
              </div>
              {runtime.enabled ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    preparation?.phase === 'cancelling' || preparation?.phase === 'unavailable'
                  }
                  onClick={async () => {
                    setError('');
                    try {
                      await runtime.command({
                        type: preparation
                          ? preparing
                            ? 'setup.cancel'
                            : 'setup.start'
                          : 'connect',
                      });
                    } catch (error) {
                      setError(runtimeError(error));
                    }
                  }}
                >
                  {preparation
                    ? t(preparing ? 'setup.pauseSetup' : 'setup.continueSetup')
                    : runtime.snapshot.phase === 'ready'
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
          {(!nativeOnly || runtime.snapshot.linux?.available) && (
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
    ...(trash
      ? [
          {
            id: 'trash',
            label: t('trash.title'),
            icon: Trash2,
            description: t('trash.description'),
            content: <TrashList state={state} trash={trash} onLifecycle={onLifecycle} />,
          },
        ]
      : []),
    {
      id: 'data',
      label: t('settings.dataStorage'),
      icon: Database,
      description: t('settings.seeWhatStoredLocallyExportWorkspaceCopy'),
      content: (
        <div className="settings-section">
          <h2>{t('settings.workspaceData')}</h2>
          <div className="setting-row">
            <SettingLabel label={t('settings.localWorkspaceData')}>
              {t('settings.appStoresChatCachesDraftsPreferenceCopies')}
            </SettingLabel>
            <span className="badge">{t('settings.localStorage')}</span>
          </div>
          <div className="setting-row">
            <SettingLabel label={t('settings.exportWorkspace')}>
              {t('settings.exportJsonCopyPrivateChatCachesDrafts')}
            </SettingLabel>
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
            <SettingLabel label="Daban">
              <p>{t('settings.aiWorkCompanion')}</p>
              <p>
                {runtime.enabled
                  ? nativeOnly
                    ? t('localComputer.settingsDescription')
                    : t('settings.localLinuxDshConnectedMobileCrossDevice')
                  : t('settings.previewIncludesOnlyAppInterfaceMobileCross')}
              </p>
            </SettingLabel>
          </div>
          <UpdatesPanel onDialogChange={setUpdateDialog} />
        </div>
      ),
    },
  ];
  const content = (
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
      {/* Keep editors mounted across categories and clear private key drafts when leaving Settings. */}
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
            <Help topic={section.label}>{section.description}</Help>
          </header>
          {section.content}
        </TabPanel>
      ))}
    </Tabs>
  );
  if (inline) return content;
  return (
    <Dialog
      title={t('settings.title')}
      onClose={onClose}
      active={active && !connectionDialog && !updateDialog}
      className="settings-dialog"
      motion
    >
      {content}
    </Dialog>
  );
}
