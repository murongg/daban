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
import { type Dispatch, type ReactNode, useId, useState } from 'react';
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
import { hasComputerPermissions, Permissions } from '../computer/Permissions';
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
  const local = runtime.snapshot.localComputer;
  const permissionGuide = useId();
  const [showPermissions, setShowPermissions] = useState(false);
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
      content: (
        <>
          <div className="settings-section">
            <h2>{t('settings.interfacePreferences')}</h2>
            <div className="settings-group">
              <div className="setting-row">
                <div className="setting-label">{t('settings.theme')}</div>
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
              <div className="setting-row">
                <div className="setting-label">{t('settings.language')}</div>
                <Language />
              </div>
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
      content: (
        <div className="settings-group">
          <Models />
        </div>
      ),
    },
    {
      id: 'search',
      label: t('search.title'),
      icon: SearchIcon,
      content: <Search />,
    },
    {
      id: 'computer',
      label: t('settings.computerPermissions'),
      icon: Monitor,
      content: (
        <>
          {(runtime.snapshot.agent?.execution === 'linux-vm' ||
            runtime.snapshot.linux?.available) && (
            <div className="settings-section">
              <h2>{t('settings.executionEnvironmentPermissions')}</h2>
              <div className="settings-group">
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
            </div>
          )}
          <div className="settings-section">
            <h2>{nativeOnly ? t('localComputer.computer') : t('settings.localLinux')}</h2>
            <div className="settings-group">
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
              {local?.platform === 'darwin' && local.available && (
                <>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">{t('localComputer.permissionsLabel')}</div>
                      <p className="setting-description">
                        {t(
                          hasComputerPermissions(local)
                            ? 'localComputer.permissionsReady'
                            : 'localComputer.permissionsNeeded',
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      aria-expanded={showPermissions}
                      aria-controls={permissionGuide}
                      onClick={() => setShowPermissions((shown) => !shown)}
                    >
                      {t('localComputer.permissions')}
                    </button>
                  </div>
                  <div id={permissionGuide} hidden={!showPermissions}>
                    {showPermissions && category === 'computer' && (
                      <Permissions status={local} showTitle={false} />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <AgentUpgradePanel onDialogChange={setConnectionDialog} />
          <LinuxSetup />
          <VirtualMachine />
          {(!nativeOnly || runtime.snapshot.linux?.available) && (
            <div className="settings-section">
              <h2>{t('settings.runtime')}</h2>
              <div className="settings-group">
                <Diagnostics />
                <RecoveryEntry open={onRecovery} />
              </div>
            </div>
          )}
        </>
      ),
    },
    {
      id: 'integrations',
      label: t('common.externalTools'),
      icon: Plug,
      content: (
        <div className="settings-group">
          <Integrations bots={state.bots} onDialogChange={setConnectionDialog} />
        </div>
      ),
    },
    {
      id: 'archive',
      label: t('settings.archives'),
      icon: Archive,
      content: <ArchiveList state={state} dispatch={dispatch} onAction={onLifecycle} />,
    },
    ...(trash
      ? [
          {
            id: 'trash',
            label: t('trash.title'),
            icon: Trash2,
            content: <TrashList state={state} trash={trash} onLifecycle={onLifecycle} />,
          },
        ]
      : []),
    {
      id: 'data',
      label: t('settings.dataStorage'),
      icon: Database,
      content: (
        <div className="settings-section">
          <h2>{t('settings.workspaceData')}</h2>
          <div className="settings-group">
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
        </div>
      ),
    },
    {
      id: 'about',
      label: t('settings.about'),
      icon: Info,
      content: (
        <div className="settings-section">
          <h2>{t('common.aboutDaban')}</h2>
          <div className="settings-group">
            <UpdatesPanel onDialogChange={setUpdateDialog} />
          </div>
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
