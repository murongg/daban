import { agentId, type BotProfile, runtimeTargets } from '@daban/protocol';
import {
  BookOpen,
  Brain,
  Check,
  Clock3,
  Download,
  FileText,
  Folder,
  Info,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  RotateCcw,
  ShieldCheck,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { type Dispatch, type KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { IconButton } from '../components/controls/Button';
import { Pane } from '../components/controls/Pane';
import { Select } from '../components/controls/Select';
import { TimeField } from '../components/controls/TimeField';
import { Avatar } from '../features/bots/Avatar';
import { Capabilities } from '../features/capabilities/Capabilities';
import { Computer, type ComputerSurface } from '../features/computer/Computer';
import { Desktop } from '../features/computer/Desktop';
import { download } from '../features/files/files';
import { RuntimeFiles } from '../features/files/RuntimeFiles';
import { Knowledge } from '../features/knowledge/Knowledge';
import { MemoryHistory } from '../features/memory/MemoryHistory';
import { Notes } from '../features/notes/Notes';
import { Schedules } from '../features/schedules/Schedules';
import { type MessageKey, t, useLocale } from '../i18n/locale';
import { profileInput } from './profiles';
import { runtimeError, useRuntime } from './Runtime';
import {
  type Action,
  type Bot,
  lifecycleRequest,
  type Panel,
  type State,
  type WorkspaceFile,
} from './state';

const allTabs = [
  ['computer', Monitor, 'workspace.computer'],
  ['files', Folder, 'common.files'],
  ['knowledge', FileText, 'workspace.documents'],
  ['skills', BookOpen, 'capabilities.title'],
  ['memory', Brain, 'workspace.memory'],
  ['notes', StickyNote, 'common.notes'],
  ['routines', Clock3, 'workspace.schedules'],
] as const;
export function Workspace({
  state,
  bot,
  dispatch,
  notify,
  preview,
  expand,
  openMember,
  onRecovery,
  readOnly = false,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
  preview: (file: WorkspaceFile) => unknown;
  expand: (view: ComputerSurface) => unknown;
  openMember?: (id: string) => unknown;
  onRecovery?: () => unknown;
  readOnly?: boolean;
}) {
  useLocale();
  const runtime = useRuntime();
  const [expandedBot, setExpandedBot] = useState<string>();
  const expanded = expandedBot === bot.id;
  const restricted = (id: string) => readOnly && !['computer', 'files', 'notes'].includes(id);
  const purposes: Record<Panel, MessageKey> = {
    computer: 'workspace.computerPurpose',
    files: 'workspace.filesPurpose',
    knowledge: 'workspace.documentsPurpose',
    skills: 'workspace.skillsPurpose',
    memory: 'workspace.memoryPurpose',
    notes: 'workspace.notesPurpose',
    routines: 'workspace.schedulesPurpose',
  };
  const tabs =
    bot.members || bot.kind === 'chat'
      ? allTabs.filter(([id]) => id === 'computer' || id === 'files')
      : allTabs;
  const panel =
    (bot.members || bot.kind === 'chat') && !['computer', 'files'].includes(state.panel || '')
      ? 'computer'
      : state.panel;
  const [memoryStatus, setMemoryStatus] = useState<
    Record<string, { saving?: boolean; error?: string; conflict?: BotProfile }>
  >({});
  const memorySaving = memoryStatus[bot.id]?.saving;
  const memoryError = memoryStatus[bot.id]?.error;
  const memoryConflict = memoryStatus[bot.id]?.conflict;
  const [historyBot, setHistoryBot] = useState<string>();
  const closeHistory = useCallback(() => setHistoryBot(undefined), []);
  const profile = runtime.snapshot.profiles.find((profile) => profile.id === agentId(bot.id));
  const memoryBlocked = memorySaving
    ? t('workspace.preferencesBeingSavedWaitCompletion')
    : memoryConflict
      ? t('workspace.resolveRevisionConflictEditorFirst')
      : bot.archived || profile?.archived || lifecycleRequest(state, bot.id, profile)
        ? t('workspace.botBeingArchivedRestoredHistoryReadOnly')
        : state.memoryDrafts[bot.id] !== state.memories[bot.id]
          ? t('workspace.saveRevertEditorDraftLoadingHistoricalRevision')
          : undefined;
  useEffect(() => {
    if (historyBot !== bot.id || panel !== 'memory') setHistoryBot(undefined);
  }, [bot.id, panel, historyBot]);
  const form = state.routineDrafts[bot.id];
  const { open: adding, title: routineTitle, instruction, frequency, time } = form;
  const setForm = (draft: Partial<typeof form>) =>
    dispatch({ type: 'routine-draft', bot: bot.id, draft });
  const human = state.controls[bot.id] === 'human';
  const memory = state.memoryDrafts[bot.id];
  function changeTab(panel: Panel) {
    if (!panel || restricted(panel)) return;
    dispatch({ type: 'panel', panel });
  }
  function keyTab(e: KeyboardEvent, index: number) {
    const enabled = tabs.filter(([id]) => !restricted(id));
    const current = enabled.findIndex(([id]) => id === tabs[index][0]);
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (current + enabled.length - 1) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else return;
    e.preventDefault();
    changeTab(enabled[next][0]);
    document.getElementById(`tab-${enabled[next][0]}`)?.focus();
  }
  useEffect(() => {
    document
      .getElementById(`tab-${panel}`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [panel]);
  return (
    <Pane
      id="bot-workspace"
      className={`workspace ${expanded ? 'expanded' : ''}`}
      label={t('workspace.botWorkspace')}
      resizable={!expanded}
    >
      <div className="workspace-tabs">
        <div
          className="workspace-tablist"
          role="tablist"
          aria-label={t('workspace.workspacePanel')}
        >
          {tabs.map(([id, Icon, label], i) => (
            <button
              type="button"
              id={`tab-${id}`}
              key={id}
              role="tab"
              aria-selected={panel === id}
              disabled={restricted(id)}
              aria-controls={`panel-${id}`}
              tabIndex={panel === id ? 0 : -1}
              className="workspace-tab"
              onKeyDown={(e) => keyTab(e, i)}
              onClick={() => changeTab(id)}
            >
              <Icon />
              {t(label)}
            </button>
          ))}
        </div>
        <IconButton
          label={t(expanded ? 'workspace.collapsePanel' : 'workspace.expandPanel')}
          aria-pressed={expanded}
          onClick={() => setExpandedBot(expanded ? undefined : bot.id)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton
          label={t('workspace.closeWorkspacePanel')}
          onClick={() => {
            document.getElementById('workspace-toggle')?.focus({ preventScroll: true });
            dispatch({ type: 'panel', panel: null });
          }}
        >
          <X />
        </IconButton>
      </div>
      {panel && (
        <div className="workspace-context">
          <strong>
            {panel === 'files'
              ? t('workspace.sharedScope')
              : panel === 'skills'
                ? t('workspace.skillsScope', { 0: bot.name })
                : t('workspace.botScope', { 0: bot.name })}
          </strong>
          <span>{t(purposes[panel])}</span>
        </div>
      )}
      <div
        className="workspace-body"
        id={`panel-${panel}`}
        role="tabpanel"
        aria-labelledby={`tab-${panel}`}
      >
        {panel === 'notes' && !bot.members && (
          <Notes key={bot.id} state={state} bot={bot} dispatch={dispatch} notify={notify} />
        )}
        {panel === 'computer' && runtime.enabled && !bot.members && (
          <Computer bot={bot} notify={notify} expand={expand} onRecovery={onRecovery} />
        )}
        {panel === 'computer' &&
          (!runtime.enabled || !!bot.members) &&
          (bot.members ? (
            <div className="panel-section">
              <h2>{t('workspace.everyBotHasOwnComputer')}</h2>
              <p className="panel-description">
                {t('workspace.selectGroupMemberViewIndependentWorkspace')}
              </p>
              <div className="file-list">
                {bot.members.map((id) => {
                  const member = state.bots.find((b) => b.id === id);
                  return (
                    member && (
                      <button
                        type="button"
                        key={id}
                        className="bot-row"
                        onClick={() => openMember?.(id)}
                        disabled={
                          runtime.enabled &&
                          (runtime.snapshot.protocolVersion >= 19
                            ? !runtime.snapshot.profiles.some(
                                (profile) => profile.id === agentId(id),
                              )
                            : !runtime.snapshot.bots[runtimeTargets[id]])
                        }
                      >
                        <Avatar bot={member} />
                        <span>{member.name}</span>
                      </button>
                    )
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="computer-panel">
              <div className={`computer-info ${human ? 'human' : ''}`}>
                <span className="status-dot" />
                <span>{human ? t('common.control') : t('workspace.desktopPreview')}</span>
                <span className="spacer" />
                <span className="muted">
                  {bot.name}
                  {t('common.sScreen')}
                </span>
                <IconButton label={t('common.expand')} onClick={() => expand('desktop')}>
                  <Maximize2 />
                </IconButton>
              </div>
              <Desktop key={bot.id} name={bot.name} human={human} />
              <div className="computer-copy">
                <h2>{human ? t('common.computerYoursNow') : t('workspace.workHappensHere')}</h2>
                <p>
                  {human
                    ? t('workspace.botWaitsWhileControlComputerSwitchingBots')
                    : t('workspace.viewBotSComputerFilesAppsTake')}
                </p>
                <div className="computer-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      dispatch({ type: 'control', bot: bot.id, owner: human ? 'agent' : 'human' });
                      notify(
                        human
                          ? t('workspace.handedBackBotDemo')
                          : t('workspace.takeoverEnabledDemoNoRealComputerConnected'),
                      );
                    }}
                  >
                    {human ? <Check /> : <Monitor />}
                    {human ? t('common.handBackBot') : t('common.takeOverComputer')}
                  </button>
                  <span className="spacer" />
                  <IconButton
                    label={t('workspace.refreshDesktopPreview')}
                    onClick={() =>
                      notify(t('workspace.exampleDesktopLiveViewAppearsConnectingRuntime'))
                    }
                  >
                    <RotateCcw />
                  </IconButton>
                </div>
              </div>
              <div className="computer-footer">
                <ShieldCheck />
                <span>{t('workspace.exampleComputerScreenDoesNotConnectActual')}</span>
              </div>
            </div>
          ))}
        {panel === 'files' && runtime.enabled && (
          <RuntimeFiles
            notify={notify}
            preview={preview}
            attach={
              bot.members && runtime.snapshot.protocolVersion < 15
                ? undefined
                : (file) => dispatch({ type: 'attach', bot: bot.id, file })
            }
            attachBot={
              bot.members && runtime.snapshot.protocolVersion < 15 ? undefined : agentId(bot.id)
            }
            onAttaching={(uploading) =>
              dispatch({ type: 'attachment-uploading', bot: bot.id, uploading })
            }
            attachmentLimit={
              state.attachments[bot.id].length >= 4 || !!state.attachmentUploads[bot.id]
            }
          />
        )}
        {panel === 'files' && !runtime.enabled && (
          <div className="panel-section">
            <h2>{t('common.workspaceFiles')}</h2>
            <p className="panel-description">
              {t('workspace.botsShareFilesPreviewFileDownloadComputer')}
            </p>
            <div className="file-list">
              {state.files.map((file) => (
                <div className="file-row" key={file.id}>
                  <button type="button" className="file-open" onClick={() => preview(file)}>
                    <span className="file-symbol">
                      <FileText />
                    </span>
                    <div>
                      <div className="artifact-name">{file.name}</div>
                      <div className="artifact-meta">
                        {file.size} · {file.modified}
                      </div>
                    </div>
                  </button>
                  <IconButton
                    label={`${file.upload ? t('common.downloadExtractedText') : t('workspace.download')} ${file.name}`}
                    onClick={() => download(file)}
                  >
                    <Download />
                  </IconButton>
                </div>
              ))}
            </div>
            <p className="inline-note" style={{ marginTop: 20 }}>
              {t('workspace.exampleFilesDisplayOnlyAddedTextAttachments')}
            </p>
          </div>
        )}
        {panel === 'knowledge' && (
          <Knowledge state={state} bot={bot} dispatch={dispatch} notify={notify} />
        )}
        {panel === 'skills' && (
          <Capabilities state={state} bot={bot} dispatch={dispatch} notify={notify} />
        )}
        {panel === 'memory' && (
          <div className="panel-section">
            <div className="panel-heading">
              <h2>{t('workspace.workBetterTogether')}</h2>
              <button
                className="text-button"
                type="button"
                disabled={
                  !runtime.enabled ||
                  runtime.snapshot.phase !== 'ready' ||
                  runtime.snapshot.protocolVersion < 32 ||
                  !profile
                }
                onClick={() => setHistoryBot(bot.id)}
              >
                {t('workspace.revisions')}
              </button>
            </div>
            <p className="panel-description">
              {runtime.enabled && runtime.snapshot.protocolVersion >= 7
                ? t('workspace.saveWorkPreferencesSoDoNotNeedRepeat')
                : t('workspace.saveWorkPreferencesSoDoNotNeed')}
            </p>
            <div className="memory-intro">
              <Avatar bot={bot} />
              <span>{t('workspace.memoryPrivateHint', { 0: bot.name })}</span>
            </div>
            {memoryError && (
              <p className="form-error" role="alert">
                {memoryError}
              </p>
            )}
            <form
              className="memory-editor"
              onSubmit={async (e) => {
                e.preventDefault();
                if (memorySaving || memoryConflict) return;
                const target = bot.id,
                  value = memory;
                const feedback = (value: (typeof memoryStatus)[string]) =>
                  setMemoryStatus((current) => ({ ...current, [target]: value }));
                feedback({ saving: true });
                try {
                  if (runtime.enabled) {
                    const profile = await runtime.command<BotProfile>({
                      type: 'bot.register',
                      profile: profileInput(bot, state.memories[target]),
                    });
                    // Zero marks a migrated/offline draft with no verified backend base; review before replacing it.
                    if (state.memoryVersions[target] === 0) throw new Error('BOT_PROFILE_CONFLICT');
                    const saved = await runtime.command<BotProfile>({
                      type: 'bot.update',
                      bot: profile.id,
                      revision: state.memoryVersions[target] ?? profile.revision,
                      patch: { memory: value },
                    });
                    dispatch({
                      type: 'memory-saved',
                      bot: target,
                      profile: saved,
                      submitted: value,
                    });
                  } else dispatch({ type: 'memory', bot: target, text: value, submitted: value });
                  notify(
                    runtime.enabled
                      ? t('workspace.memorySavedLocalRuntime')
                      : t('workspace.memorySavedLocally'),
                  );
                  feedback({});
                } catch (error) {
                  const conflict =
                    error instanceof Error && error.message === 'BOT_PROFILE_CONFLICT';
                  feedback({ error: runtimeError(error), saving: conflict });
                  if (conflict) {
                    try {
                      const latest = await runtime.command<BotProfile>({
                        type: 'bot.register',
                        profile: profileInput(bot, state.memories[target]),
                      });
                      dispatch({ type: 'profiles', profiles: [latest] });
                      feedback({ error: runtimeError(error), conflict: latest });
                    } catch (refreshError) {
                      feedback({ error: runtimeError(refreshError) });
                    }
                  }
                }
              }}
            >
              <label className="field-label">
                {t('workspace.workPreferences')}
                <textarea
                  className="field"
                  aria-label={t('workspace.workPreferences')}
                  maxLength={12000}
                  placeholder={t('workspace.exampleLeadConclusionsThenEvidenceLetMe')}
                  value={memory}
                  onChange={(e) =>
                    dispatch({ type: 'memory-draft', bot: bot.id, text: e.target.value })
                  }
                />
              </label>
              <div className="memory-actions">
                <span className="inline-note">
                  {memory === state.memories[bot.id]
                    ? t('workspace.savedLocally')
                    : t('common.unsavedChangesDraftRetained')}
                </span>
                <button
                  className="primary"
                  type="submit"
                  disabled={memorySaving || !!memoryConflict}
                >
                  {memorySaving ? t('common.saving') : t('workspace.saveMemory')}
                </button>
              </div>
            </form>
            {memoryConflict && (
              <div>
                <p className="inline-note">{t('workspace.currentlySavedWorkPreferences')}</p>
                <p className="panel-description">
                  {memoryConflict.memory || t('workspace.noWorkPreferencesSet')}
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    dispatch({
                      type: 'memory-rebase',
                      bot: bot.id,
                      revision: memoryConflict.revision,
                    });
                    setMemoryStatus((current) => ({ ...current, [bot.id]: {} }));
                  }}
                >
                  {t('common.keepDraftRetryRevision')}
                </button>
              </div>
            )}
            <p className="panel-description" style={{ marginTop: 25 }}>
              {runtime.enabled
                ? runtime.snapshot.protocolVersion >= 7
                  ? runtime.snapshot.protocolVersion >= 32
                    ? t('workspace.preferencesSharedChatNextTaskUsesOnly')
                    : t('workspace.preferencesSharedChatNextTaskUsesLatest')
                  : t('workspace.preferencesApplyNextRealTaskUpdateRuntime')
                : t('workspace.uiDemonstrationPreferencesApplyRealTasksModel')}
            </p>
            {historyBot === bot.id && (
              <MemoryHistory
                key={bot.id}
                bot={bot}
                revision={profile?.revision}
                blocked={memoryBlocked}
                close={closeHistory}
                stage={(version, revision) => {
                  // Stage against the reviewed current profile; the existing save keeps the CAS fence if a later model edit arrives.
                  if (
                    memoryBlocked ||
                    profile?.revision !== revision ||
                    state.profileRevisions[agentId(bot.id)] !== revision
                  )
                    return;
                  dispatch({ type: 'memory-draft', bot: bot.id, text: version.content });
                  closeHistory();
                  notify(t('workspace.loadedIntoEditorReviewSaveApply'));
                }}
              />
            )}
          </div>
        )}
        {panel === 'routines' && runtime.enabled && (
          <Schedules state={state} bot={bot} dispatch={dispatch} notify={notify} />
        )}
        {panel === 'routines' && !runtime.enabled && (
          <div className="panel-section">
            <div className="panel-heading">
              <h2>{t('common.scheduledTasks')}</h2>
              <IconButton
                label={t('common.newScheduledTask')}
                onClick={() => setForm({ open: true })}
              >
                <Plus />
              </IconButton>
            </div>
            <p className="panel-description">{t('workspace.setUpRecurringWorkOnceLetStart')}</p>
            {state.routines
              .filter((r) => r.bot === bot.id)
              .map((r) => (
                <div className="routine-row" key={r.id}>
                  <div className="routine-top">
                    <span className="routine-title">{r.title}</span>
                    <button
                      type="button"
                      className="toggle"
                      role="switch"
                      aria-label={`${r.enabled ? t('common.disable') : t('common.enable')} ${r.title}`}
                      aria-checked={r.enabled}
                      onClick={() => dispatch({ type: 'routine-toggle', id: r.id })}
                    />
                  </div>
                  <div className="routine-description">
                    <Clock3 />
                    {r.schedule}
                  </div>
                  <div className="routine-bottom">
                    <span>{r.enabled ? t('workspace.enabledDemo') : t('common.paused')}</span>
                    <IconButton
                      label={t('common.deleteSchedule', { 0: r.title })}
                      onClick={() => {
                        dispatch({ type: 'routine-remove', id: r.id });
                        notify(t('workspace.scheduledTaskRemoved'));
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                </div>
              ))}
            {!state.routines.some((r) => r.bot === bot.id) && !adding && (
              <div className="empty-panel">
                <Clock3 />
                <h3>{t('common.letBotStartTime')}</h3>
                <p>{t('common.exampleSummarizeProgressWeeklyDosDaily')}</p>
                <button type="button" className="secondary" onClick={() => setForm({ open: true })}>
                  <Plus />
                  {t('common.createSchedule')}
                </button>
              </div>
            )}
            {adding && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!routineTitle.trim() || !instruction.trim()) return;
                  dispatch({
                    type: 'routine-add',
                    routine: {
                      id: crypto.randomUUID(),
                      bot: bot.id,
                      title: routineTitle.trim(),
                      instruction: instruction.trim(),
                      schedule: `${frequency} · ${time}`,
                      enabled: true,
                    },
                  });
                  notify(t('workspace.scheduleSavedDemonstrationWillNotRunAutomatically'));
                }}
              >
                <label className="field-label">
                  {t('common.taskName')}
                  <input
                    className="field"
                    value={routineTitle}
                    onChange={(e) => setForm({ title: e.target.value })}
                    maxLength={60}
                    required
                    placeholder={t('workspace.exampleWeeklyWorkSummary')}
                  />
                </label>
                <label className="field-label">
                  {t('common.whatShouldBotDo')}
                  <textarea
                    className="field"
                    value={instruction}
                    onChange={(e) => setForm({ instruction: e.target.value })}
                    maxLength={2000}
                    required
                    rows={3}
                  />
                </label>
                <div className="field-label">
                  {t('common.repeat')}
                  <Select
                    label={t('common.repeat')}
                    value={frequency}
                    onValueChange={(value) => setForm({ frequency: value })}
                    options={[
                      t('common.daily'),
                      t('workspace.weekdays'),
                      t('workspace.everyFriday'),
                    ].map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </div>
                <div className="field-label">
                  {t('common.time')}
                  <TimeField
                    label={t('common.time')}
                    required
                    value={time}
                    onValueChange={(value) => setForm({ time: value })}
                  />
                </div>
                <div className="inline-form-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setForm({ open: false })}
                  >
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="primary">
                    {t('common.saveSchedule')}
                  </button>
                </div>
              </form>
            )}
            <p className="inline-note" style={{ marginTop: 25, display: 'flex', gap: 6 }}>
              <Info size={13} />
              {t('workspace.schedulesUiDemonstrationDoNotRunAutomatically')}
            </p>
          </div>
        )}
      </div>
    </Pane>
  );
}
