import {
  agentId,
  isSkillContent,
  type SkillCatalog,
  type SkillDocument,
  type SkillEntry,
} from '@daban/protocol';
import { Download, Plus, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import { Dialog } from './Dialog';
import { downloadBlob, readUtf8 } from './files';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, type Bot, type State, skillDirty, skillDraft, skillEditor } from './state';

interface Status {
  busy?: boolean;
  error?: string;
  conflict?: SkillDocument;
}
export function Skills({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (text: string) => unknown;
}) {
  const runtime = useRuntime(),
    picker = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLFormElement>(null);
  const [catalogs, setCatalogs] = useState<Record<string, SkillCatalog>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [trash, setTrash] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [recycling, setRecycling] = useState<{ nonce: string; entry: SkillEntry }>();
  const draft = skillEditor(state, bot.id),
    status = Object.hasOwn(statuses, bot.id) ? statuses[bot.id] : {},
    catalog = Object.hasOwn(catalogs, bot.id) ? catalogs[bot.id] : undefined;
  const target = agentId(bot.id),
    registered = runtime.snapshot.profiles.some((profile) => profile.id === target);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 20 &&
    runtime.snapshot.skills?.available &&
    registered &&
    !bot.members;
  const feedback = useCallback(
    (id: string, patch: Status) =>
      setStatuses((current) => ({ ...current, [id]: { ...current[id], ...patch } })),
    [],
  );
  const closeRecycle = useCallback(() => setRecycling(undefined), []);
  const selection = draft ? `${bot.id}:${draft.id ?? 'new'}` : '';
  useEffect(() => {
    if (selection) editor.current?.scrollIntoView?.({ block: 'start' });
  }, [selection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Typing must not reload content. Bot/revision/refresh changes revalidate, and the reducer fences late reads against the captured draft.
  useEffect(() => {
    if (!available) return;
    let live = true;
    const id = bot.id,
      previous = draft;
    runtime
      .command<SkillCatalog>({ type: 'skill.list', bot: agentId(id), includeDeleted: trash })
      .then(async (value) => {
        if (!live) return;
        setCatalogs((current) => ({ ...current, [id]: value }));
        if (
          previous?.id &&
          !skillDirty(previous) &&
          value.items.some((item) => item.id === previous.id && item.revision !== previous.revision)
        ) {
          const document = await runtime.command<SkillDocument>({
            type: 'skill.read',
            bot: agentId(id),
            id: previous.id,
          });
          if (live) dispatch({ type: 'skill-load', bot: id, previous, document });
        }
      })
      .catch((error) => {
        if (live) feedback(id, { error: runtimeError(error) });
      });
    return () => {
      live = false;
    };
  }, [
    available,
    bot.id,
    trash,
    refresh,
    runtime.command,
    runtime.snapshot.skills?.revision,
    feedback,
  ]);
  const report = (id: string, cause: unknown) => {
    const message = runtimeError(cause);
    feedback(id, { error: message });
    notify(message);
  };
  async function open(entry: SkillEntry) {
    if (draft && skillDirty(draft)) {
      feedback(bot.id, { error: '请先保存或放弃当前修改，再打开另一份技能。' });
      return;
    }
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '', conflict: undefined });
    try {
      const document = await runtime.command<SkillDocument>({
        type: 'skill.read',
        bot: agentId(id),
        id: entry.id,
      });
      dispatch({ type: 'skill-load', bot: id, previous, document });
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
    }
  }
  async function save() {
    if (!draft || status.busy || !available) return;
    if (!isSkillContent(draft.content)) {
      report(bot.id, new Error('INVALID_SKILL'));
      return;
    }
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '', conflict: undefined });
    try {
      const document = await runtime.command<SkillDocument>(
        previous.id
          ? {
              type: 'skill.update',
              bot: agentId(id),
              id: previous.id,
              revision: previous.revision,
              content: previous.content,
            }
          : { type: 'skill.import', bot: agentId(id), content: previous.content },
      );
      dispatch({ type: 'skill-load', bot: id, previous, document });
      setRefresh((value) => value + 1);
      notify('技能已保存，启用设置分别保留，修改从下次任务生效。');
    } catch (cause) {
      report(id, cause);
      if (cause instanceof Error && cause.message === 'SKILL_CONFLICT' && previous.id) {
        try {
          feedback(id, {
            conflict: await runtime.command<SkillDocument>({
              type: 'skill.read',
              bot: agentId(id),
              id: previous.id,
            }),
          });
        } catch (readError) {
          report(id, readError);
        }
      }
    } finally {
      feedback(id, { busy: false });
    }
  }
  async function importFile(file?: File) {
    if (!file || !available || status.busy) return;
    if (draft && skillDirty(draft)) {
      feedback(bot.id, { error: '请先保存或放弃当前修改，再导入技能。' });
      return;
    }
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '', conflict: undefined });
    try {
      if (!/\.md$/i.test(file.name) || !file.size || file.size > 200000)
        throw new Error('INVALID_SKILL');
      const content = await readUtf8(file);
      if (!isSkillContent(content)) throw new Error('INVALID_SKILL');
      const document = await runtime.command<SkillDocument>({
        type: 'skill.import',
        bot: agentId(id),
        content,
      });
      dispatch({ type: 'skill-load', bot: id, previous, document });
      setRefresh((value) => value + 1);
      notify('技能已导入；请单独为需要的 Bot 启用。');
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
    }
  }
  async function toggle(entry: SkillEntry) {
    const id = bot.id;
    feedback(id, { busy: true, error: '' });
    try {
      await runtime.command({
        type: 'skill.bind',
        bot: agentId(id),
        binding: {
          id: entry.id,
          revision: entry.revision,
          bindingRevision: entry.bindingRevision,
          enabled: !entry.enabled,
        },
      });
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
      setRefresh((value) => value + 1);
    }
  }
  async function changeDeleted(entry: SkillEntry, deleted: boolean, nonce?: string) {
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '' });
    try {
      const document = await runtime.command<SkillDocument>({
        type: deleted ? 'skill.recycle' : 'skill.restore',
        bot: agentId(id),
        id: entry.id,
        revision: entry.revision,
      });
      if (previous?.id === entry.id) dispatch({ type: 'skill-load', bot: id, previous, document });
      setRecycling((current) => (current?.nonce === nonce ? undefined : current));
      notify(
        deleted
          ? '已移入回收站，所有 Bot 的启用设置已关闭。'
          : '已恢复到技能库，需要重新为 Bot 启用。',
      );
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
      setRefresh((value) => value + 1);
    }
  }
  function insert(entry: SkillEntry) {
    const current = state.drafts[bot.id] || '',
      text = `/${entry.name} ${current}`;
    if (text.length > 12000) {
      feedback(bot.id, { error: '聊天草稿过长，未加入技能指令；原内容保留。' });
      return;
    }
    dispatch({ type: 'draft', bot: bot.id, text });
    notify('已加入聊天草稿，发送后才会调用。');
  }
  const selected = catalog?.items.find((entry) => entry.id === draft?.id);
  return (
    <section className="panel-section skills" aria-label={`${bot.name}的技能`}>
      <div className="panel-heading">
        <h2>技能</h2>
        <span className="spacer" />
        <IconButton
          label="刷新技能"
          disabled={!available || status.busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
        </IconButton>
        <IconButton
          label="导入技能"
          disabled={!available || status.busy}
          onClick={() => picker.current?.click()}
        >
          <Upload size={16} />
        </IconButton>
        <IconButton
          label="新建技能"
          disabled={!available || status.busy}
          onClick={() => {
            if (draft && skillDirty(draft)) {
              feedback(bot.id, { error: '请先保存或放弃当前修改。' });
              return;
            }
            dispatch({ type: 'skill-set', bot: bot.id, draft: skillDraft() });
            feedback(bot.id, { error: '', conflict: undefined });
          }}
        >
          <Plus size={16} />
        </IconButton>
      </div>
      <p className="panel-description">
        所有 Bot 共用技能库，启用设置分别保存。技能提供可复用步骤，不会新增工具权限。
      </p>
      <p className="panel-description">
        当前支持单份 SKILL.md 说明；含脚本或附件的技能包尚不能导入。修改从下次任务生效。
      </p>
      <input
        ref={picker}
        type="file"
        accept=".md,text/markdown"
        aria-label="选择技能说明文件"
        hidden
        disabled={!available || status.busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          importFile(file).catch((cause) => report(bot.id, cause));
        }}
      />
      {!available && (
        <p role="status" className="panel-description">
          {runtime.snapshot.protocolVersion < 20
            ? '当前运行环境尚不支持技能管理，请连接支持此功能的本机版本。'
            : !registered
              ? '正在同步 Bot 资料，请稍候。'
              : '技能服务暂不可用；普通对话和已有工作区内容仍可使用。'}
        </p>
      )}
      {status.error && (
        <p role="alert" className="skill-error">
          {status.error}
        </p>
      )}
      <div className="skill-tools">
        <button
          type="button"
          className="text-button"
          disabled={status.busy}
          onClick={() => setTrash(!trash)}
        >
          {trash ? '返回技能库' : '查看回收站'}
        </button>
        <span className="muted">{trash ? '恢复后不会自动启用' : '最多保留 100 份，含回收站'}</span>
      </div>
      {draft && (
        <form
          ref={editor}
          className="skill-editor"
          onSubmit={(event) => {
            event.preventDefault();
            save().catch((cause) => report(bot.id, cause));
          }}
        >
          <h3>{draft.id ? '编辑技能说明' : '新建技能说明'}</h3>
          <p className="field-help">
            {skillDirty(draft) ? '有未保存的修改。' : '已保存。'}
            {draft.id ? `版本 ${draft.revision}。` : ''}
          </p>
          <p className="field-help">
            名称使用小写英文短名，例如 weekly-report；description 写用途，正文写具体步骤。
          </p>
          <label className="field-label">
            SKILL.md
            <textarea
              className="field skill-source"
              aria-label="技能说明"
              value={draft.content}
              readOnly={draft.deleted}
              maxLength={200000}
              spellCheck={false}
              onChange={(event) =>
                dispatch({ type: 'skill-change', bot: bot.id, content: event.target.value })
              }
            />
          </label>
          {draft.deleted && <p className="field-help">这份技能在回收站中，恢复后可继续编辑。</p>}
          {status.conflict && (
            <div className="skill-conflict" role="status">
              <p>后台当前版本如下，请核对后决定是否保留你的完整修改。</p>
              <pre>{status.conflict.content}</pre>
              <button
                type="button"
                className="secondary"
                disabled={status.busy || status.conflict.deleted}
                onClick={() => {
                  dispatch({
                    type: 'skill-stage',
                    bot: bot.id,
                    previous: draft,
                    draft: {
                      ...draft,
                      revision: status.conflict!.revision,
                      baseContent: status.conflict!.content,
                    },
                  });
                  feedback(bot.id, { error: '', conflict: undefined });
                }}
              >
                保留我的修改，采用当前版本号
              </button>
            </div>
          )}
          <div className="skill-controls">
            <button
              type="submit"
              className="primary"
              disabled={!available || status.busy || draft.deleted || !skillDirty(draft)}
            >
              {status.busy ? '正在保存…' : '保存技能'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={status.busy}
              onClick={() => {
                dispatch({ type: 'skill-set', bot: bot.id });
                feedback(bot.id, { error: '', conflict: undefined });
              }}
            >
              放弃编辑
            </button>
            <IconButton
              label="导出当前技能说明"
              onClick={() =>
                downloadBlob(
                  `${selected?.name || 'SKILL'}.md`,
                  new Blob([draft.content], { type: 'text/markdown;charset=utf-8' }),
                )
              }
            >
              <Download size={16} />
            </IconButton>
          </div>
        </form>
      )}
      <section className="skills-list" aria-label={trash ? '技能回收站' : '技能库'}>
        {catalog?.items.map((entry) => (
          <article className="skill-item" key={entry.id}>
            <div className="skill-title">
              <strong>{entry.name}</strong>
              <span className="spacer" />
              {!entry.deleted && (
                <label className="skill-toggle">
                  <input
                    type="checkbox"
                    aria-label={`为${bot.name}启用 ${entry.name}`}
                    checked={entry.enabled}
                    disabled={!available || status.busy}
                    onChange={() => {
                      toggle(entry).catch((cause) => report(bot.id, cause));
                    }}
                  />
                  {entry.enabled ? '已启用' : '未启用'}
                </label>
              )}
            </div>
            <p className="skill-description">{entry.description}</p>
            <p className="field-help">
              {entry.invocation.modelInvocable
                ? '可按任务自动加载'
                : entry.invocation.userInvocable
                  ? '仅手动调用'
                  : '不允许调用'}
              {!entry.invocation.userInvocable ? ' · 不接受手动指令' : ''}
            </p>
            <div className="skill-controls">
              <button
                type="button"
                className="secondary"
                disabled={!available || status.busy}
                aria-label={`编辑 ${entry.name}`}
                onClick={() => {
                  open(entry).catch((cause) => report(bot.id, cause));
                }}
              >
                查看与编辑
              </button>
              {!entry.deleted && (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`加入草稿 ${entry.name}`}
                  disabled={
                    !available || status.busy || !entry.enabled || !entry.invocation.userInvocable
                  }
                  onClick={() => insert(entry)}
                >
                  加入草稿
                </button>
              )}
              {entry.deleted ? (
                <IconButton
                  label={`恢复 ${entry.name}`}
                  disabled={!available || status.busy}
                  onClick={() => {
                    changeDeleted(entry, false).catch((cause) => report(bot.id, cause));
                  }}
                >
                  <RotateCcw size={16} />
                </IconButton>
              ) : (
                <IconButton
                  label={`移入回收站 ${entry.name}`}
                  disabled={!available || status.busy}
                  onClick={() => {
                    if (draft?.id === entry.id && skillDirty(draft)) {
                      feedback(bot.id, { error: '请先保存或放弃这份技能的修改。' });
                      return;
                    }
                    setRecycling({ nonce: crypto.randomUUID(), entry });
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              )}
            </div>
          </article>
        ))}
        {available && catalog?.items.length === 0 && (
          <p className="empty-state">
            {trash
              ? '回收站是空的。'
              : '还没有技能。导入一份 SKILL.md，或写下可重复使用的工作步骤。'}
          </p>
        )}
      </section>
      {recycling && (
        <Dialog title="移入技能回收站" onClose={closeRecycle}>
          <p className="dialog-description">
            将 {recycling.entry.name} 移入回收站，会关闭所有 Bot
            对它的启用设置；已有聊天保留。恢复后需要重新启用。
          </p>
          {status.error && (
            <p role="alert" className="skill-error">
              {status.error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={closeRecycle}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={!available || status.busy}
              onClick={() => {
                const captured = recycling;
                changeDeleted(captured.entry, true, captured.nonce).catch((cause) =>
                  report(bot.id, cause),
                );
              }}
            >
              移入回收站
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
