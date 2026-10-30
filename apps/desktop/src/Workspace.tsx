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
  Monitor,
  Plus,
  RotateCcw,
  ShieldCheck,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { type Dispatch, type KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { IconButton } from './Button';
import { Computer, type ComputerSurface } from './Computer';
import { Desktop } from './Desktop';
import { download } from './files';
import { Knowledge } from './Knowledge';
import { MemoryHistory } from './MemoryHistory';
import { Notes } from './Notes';
import { profileInput } from './profiles';
import { runtimeError, useRuntime } from './Runtime';
import { RuntimeFiles } from './RuntimeFiles';
import { Schedules } from './Schedules';
import { Skills } from './Skills';
import {
  type Action,
  type Bot,
  lifecycleRequest,
  type Panel,
  type State,
  type WorkspaceFile,
} from './state';

const allTabs = [
  ['computer', Monitor, '电脑'],
  ['files', Folder, '文件'],
  ['knowledge', FileText, '资料'],
  ['skills', BookOpen, '技能'],
  ['memory', Brain, '记忆'],
  ['notes', StickyNote, '便笺'],
  ['routines', Clock3, '定时'],
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
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
  preview: (file: WorkspaceFile) => unknown;
  expand: (view: ComputerSurface) => unknown;
  openMember?: (id: string) => unknown;
  onRecovery?: () => unknown;
}) {
  const runtime = useRuntime();
  const tabs = bot.members
    ? allTabs.filter(([id]) => id === 'computer' || id === 'files')
    : allTabs;
  const panel =
    bot.members && !['computer', 'files'].includes(state.panel || '') ? 'computer' : state.panel;
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
    ? '偏好正在保存，请等待完成。'
    : memoryConflict
      ? '请先处理编辑器中的版本冲突。'
      : bot.archived || profile?.archived || lifecycleRequest(state, bot.id, profile)
        ? 'Bot 正在归档或恢复，当前只能查看历史。'
        : state.memoryDrafts[bot.id] !== state.memories[bot.id]
          ? '请先保存或还原编辑器中的草稿，再载入历史版本。'
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
    dispatch({ type: 'panel', panel });
  }
  function keyTab(e: KeyboardEvent, index: number) {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    changeTab(tabs[next][0]);
    document.getElementById(`tab-${tabs[next][0]}`)?.focus();
  }
  useEffect(() => {
    document
      .getElementById(`tab-${panel}`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [panel]);
  return (
    <aside className="workspace" aria-label="Bot 工作区">
      <div className="workspace-tabs">
        <div className="workspace-tablist" role="tablist" aria-label="工作区面板">
          {tabs.map(([id, Icon, label], i) => (
            <button
              type="button"
              id={`tab-${id}`}
              key={id}
              role="tab"
              aria-selected={panel === id}
              aria-controls={`panel-${id}`}
              tabIndex={panel === id ? 0 : -1}
              className="workspace-tab"
              onKeyDown={(e) => keyTab(e, i)}
              onClick={() => changeTab(id)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </div>
        <IconButton label="关闭工作区面板" onClick={() => dispatch({ type: 'panel', panel: null })}>
          <X />
        </IconButton>
      </div>
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
              <h2>每位 Bot 都有自己的电脑</h2>
              <p className="panel-description">选择一位群成员，查看它的独立工作空间。</p>
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
                <span>{human ? '你正在接管' : '桌面预览'}</span>
                <span className="spacer" />
                <span className="muted">{bot.name}的屏幕</span>
              </div>
              <Desktop key={bot.id} name={bot.name} human={human} />
              <div className="computer-copy">
                <h2>{human ? '电脑暂时交给你' : '工作正在这里发生'}</h2>
                <p>
                  {human
                    ? '接管期间，这位 Bot 会等待你交还。切换到其他 Bot，不会改变这里的接管状态。'
                    : '查看 Bot 的电脑、文件和应用。需要时可以接管，完成后再交还，让协作继续。'}
                </p>
                <div className="computer-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      dispatch({ type: 'control', bot: bot.id, owner: human ? 'agent' : 'human' });
                      notify(
                        human ? '已交还给 Bot（演示）' : '已进入接管状态（演示），尚未连接真实电脑',
                      );
                    }}
                  >
                    {human ? <Check /> : <Monitor />}
                    {human ? '交还给 Bot' : '接管电脑'}
                  </button>
                  <button type="button" className="secondary" onClick={() => expand('desktop')}>
                    <Maximize2 />
                    展开
                  </button>
                  <span className="spacer" />
                  <IconButton
                    label="刷新桌面预览"
                    onClick={() => notify('这是示例桌面，实时画面将在接入运行环境后显示。')}
                  >
                    <RotateCcw />
                  </IconButton>
                </div>
              </div>
              <div className="computer-footer">
                <ShieldCheck />
                <span>示例电脑画面 · 不连接你的真实电脑</span>
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
            <h2>工作区文件</h2>
            <p className="panel-description">Bot 共享这里的文件。点击预览，也可以下载到本机。</p>
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
                    label={`${file.upload ? '下载提取文本' : '下载'} ${file.name}`}
                    onClick={() => download(file)}
                  >
                    <Download />
                  </IconButton>
                </div>
              ))}
            </div>
            <p className="inline-note" style={{ marginTop: 20 }}>
              示例文件仅用于展示。添加的文本附件保存在本机，不会上传到服务器。
            </p>
          </div>
        )}
        {panel === 'knowledge' && (
          <Knowledge state={state} bot={bot} dispatch={dispatch} notify={notify} />
        )}
        {panel === 'skills' && (
          <Skills state={state} bot={bot} dispatch={dispatch} notify={notify} />
        )}
        {panel === 'memory' && (
          <div className="panel-section">
            <div className="panel-heading">
              <h2>让协作更默契</h2>
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
                历史版本
              </button>
            </div>
            <p className="panel-description">
              {runtime.enabled && runtime.snapshot.protocolVersion >= 7
                ? '记下你的工作偏好，下次不用重复交代。也可以在对话里说“记住这个偏好”或“忘掉某条偏好”。'
                : '记下你的工作偏好，下次不用重复交代。'}
            </p>
            <div className="memory-intro">
              <Avatar bot={bot} />
              <span>仅用于{bot.name}的工作记忆</span>
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
                  notify(runtime.enabled ? '记忆已保存到本机运行环境。' : '记忆已保存在本机');
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
                工作偏好
                <textarea
                  className="field"
                  aria-label="工作偏好"
                  maxLength={12000}
                  placeholder="例如：先给结论，再补充依据；发送文件之前先让我确认。"
                  value={memory}
                  onChange={(e) =>
                    dispatch({ type: 'memory-draft', bot: bot.id, text: e.target.value })
                  }
                />
              </label>
              <div className="memory-actions">
                <span className="inline-note">
                  {memory === state.memories[bot.id] ? '已保存到本机' : '未保存修改 · 草稿已暂存'}
                </span>
                <button
                  className="primary"
                  type="submit"
                  disabled={memorySaving || !!memoryConflict}
                >
                  {memorySaving ? '正在保存…' : '保存记忆'}
                </button>
              </div>
            </form>
            {memoryConflict && (
              <div>
                <p className="inline-note">当前已保存的工作偏好：</p>
                <p className="panel-description">{memoryConflict.memory || '尚未设置工作偏好'}</p>
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
                  保留草稿，按此版本重试
                </button>
              </div>
            )}
            <p className="panel-description" style={{ marginTop: 25 }}>
              {runtime.enabled
                ? runtime.snapshot.protocolVersion >= 7
                  ? runtime.snapshot.protocolVersion >= 32
                    ? '这里和对话共用同一份偏好，下次任务只读取最新保存内容。移除偏好不会删除已有聊天或保留的历史。'
                    : '这里和对话共用同一份偏好，下次任务会读取最新保存内容。移除偏好不会删除已有聊天记录。更新本地环境后可查看历史版本。'
                  : '这些偏好会用于下一次真实任务；聊天记忆工具需要更新运行环境后使用。'
                : '当前为界面演示。接入模型后，这些偏好才能用于真实任务。'}
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
                  notify('已载入编辑器，请确认后保存。');
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
              <h2>定时任务</h2>
              <IconButton label="新建定时任务" onClick={() => setForm({ open: true })}>
                <Plus />
              </IconButton>
            </div>
            <p className="panel-description">把重复的事交代一次，在合适的时候开始。</p>
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
                      aria-label={`${r.enabled ? '停用' : '启用'} ${r.title}`}
                      aria-checked={r.enabled}
                      onClick={() => dispatch({ type: 'routine-toggle', id: r.id })}
                    />
                  </div>
                  <div className="routine-description">
                    <Clock3 />
                    {r.schedule}
                  </div>
                  <div className="routine-bottom">
                    <span>{r.enabled ? '已启用 · 演示' : '已暂停'}</span>
                    <IconButton
                      label={`删除定时任务 ${r.title}`}
                      onClick={() => {
                        dispatch({ type: 'routine-remove', id: r.id });
                        notify('已移除这项定时任务');
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
                <h3>让 Bot 记得按时开始</h3>
                <p>例如每周整理进展，或每天汇总待办。</p>
                <button type="button" className="secondary" onClick={() => setForm({ open: true })}>
                  <Plus />
                  创建定时任务
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
                  notify('定时任务已保存（演示），不会自动运行');
                }}
              >
                <label className="field-label">
                  任务名称
                  <input
                    className="field"
                    value={routineTitle}
                    onChange={(e) => setForm({ title: e.target.value })}
                    maxLength={60}
                    required
                    placeholder="例如：每周工作摘要"
                  />
                </label>
                <label className="field-label">
                  需要 Bot 做什么
                  <textarea
                    className="field"
                    value={instruction}
                    onChange={(e) => setForm({ instruction: e.target.value })}
                    maxLength={2000}
                    required
                    rows={3}
                  />
                </label>
                <label className="field-label">
                  重复
                  <select
                    className="field"
                    value={frequency}
                    onChange={(e) => setForm({ frequency: e.target.value })}
                  >
                    {['每天', '工作日', '每周五'].map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  时间
                  <input
                    className="field"
                    type="time"
                    required
                    value={time}
                    onChange={(e) => setForm({ time: e.target.value })}
                  />
                </label>
                <div className="inline-form-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setForm({ open: false })}
                  >
                    取消
                  </button>
                  <button type="submit" className="primary">
                    保存定时任务
                  </button>
                </div>
              </form>
            )}
            <p className="inline-note" style={{ marginTop: 25, display: 'flex', gap: 6 }}>
              <Info size={13} />
              定时任务为界面演示，目前不会自动运行。
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
