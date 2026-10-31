import { type NoteFields, noteStates } from '@daban/protocol';
import { ArrowLeft, Plus, RefreshCw, Search, StickyNote } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { IconButton } from './Button';
import { useNotes } from './note-controller';
import { noteDirty, noteInitial } from './notes-state';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';
import type { Action, Bot, State } from './state';

const states = { open: '待处理', parked: '暂存', done: '已完成' };
const filters = {
  active: '未完成',
  all: '全部',
  open: '待处理',
  parked: '暂存',
  done: '已完成',
  trash: '回收站',
} as const;
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

// Existing monochrome workspace extension: list → inline editor; drafts stay private to this Bot.
export function Notes({
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
  const runtime = useRuntime();
  const notes = useNotes(state, bot, dispatch, notify);
  const cache = state.notes?.[bot.id] ?? noteInitial();
  const { draft, pending } = cache;
  const [confirm, setConfirm] = useState<{ key: string; id: string; revision: number }>();
  const confirming =
    !!draft?.base &&
    confirm?.key === draft.key &&
    confirm.id === draft.base.id &&
    confirm.revision === draft.base.revision;
  const sealed = !!draft && pending?.draft.key === draft.key;
  const readOnly = !notes.available || notes.history || sealed || notes.reading;
  const latest = notes.latest?.key === draft?.key ? notes.latest?.item : undefined;
  const editor = notes.editorVisible && (!!draft || notes.reading);
  const run = (operation: Promise<unknown>) =>
    operation.catch((error) => notify(runtimeError(error)));
  const mutate = (patch: Partial<NoteFields>) => {
    if (draft && !readOnly) dispatch({ type: 'notes-change', bot: bot.id, key: draft.key, patch });
  };
  return (
    <section className="panel-section notes-panel" aria-label={`${bot.name}的便笺`}>
      <header className="notes-heading">
        <div>
          <h2>便笺</h2>
          <p>只供{bot.name}和你查看、修改。</p>
        </div>
        <div className="notes-actions">
          <IconButton
            label="刷新便笺"
            disabled={!notes.available || notes.loading}
            onClick={() => run(notes.load())}
          >
            <RefreshCw />
          </IconButton>
          <button
            type="button"
            className="secondary"
            disabled={!notes.available || notes.history || !!pending}
            onClick={() => {
              setConfirm(undefined);
              notes.fresh();
            }}
          >
            <Plus size={14} />
            新建便笺
          </button>
        </div>
      </header>
      <p className="inline-note">便笺用于记录事项；保存或标为完成都不会启动任务。</p>
      {!notes.available && (
        <div className="notes-notice" role="status">
          <strong>
            {runtime.enabled && runtime.snapshot.protocolVersion < 37
              ? '需要更新运行环境'
              : '便笺暂不可用'}
          </strong>
          <p>
            {runtime.snapshot.notes?.available === false
              ? runtimeError(Error(runtime.snapshot.notes.error))
              : '连接支持便笺的运行环境后可查看和保存，已有草稿仍保留。'}
          </p>
        </div>
      )}
      {notes.history && (
        <p className="notes-notice">这位 Bot 已归档或正在处理归档操作，便笺只能查看。</p>
      )}
      {notes.blocked && !notes.history && (
        <p className="notes-notice">运行环境正在恢复，暂时只能查看和编辑草稿。恢复完成后再保存。</p>
      )}
      {cache.damaged && (
        <p className="notes-notice" role="status">
          部分本机便笺缓存无法恢复。其余草稿和后台记录仍保留；请先核对列表，再继续编辑。
        </p>
      )}
      {pending && (
        <section className="notes-notice" aria-label="待确认的便笺操作">
          <strong>{notes.working ? '正在提交便笺…' : '这次操作的结果尚未确认'}</strong>
          <p>原请求已保存在本机。重新打开只会核对回执，手动重试会使用同一次操作。</p>
          {notes.operationError && <p role="status">{notes.operationError}</p>}
          <div className="notes-actions">
            <button
              type="button"
              className="secondary"
              disabled={!notes.available || notes.checking}
              onClick={() => run(notes.check())}
            >
              {notes.checking ? '正在核对…' : '核对操作结果'}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={!notes.available || notes.blocked || notes.working}
              onClick={() => run(notes.retry())}
            >
              重试同一次操作
            </button>
          </div>
        </section>
      )}
      {notes.error && (
        <p className="error-text" role="alert">
          {notes.error}
        </p>
      )}
      {editor ? (
        <section className="note-editor" aria-label="便笺编辑器">
          <button
            type="button"
            className="text-button note-back"
            onClick={() => {
              notes.setEditorVisible(false);
              setConfirm(undefined);
            }}
          >
            <ArrowLeft size={14} />
            返回便笺列表
          </button>
          {notes.reading && <p role="status">正在读取便笺…</p>}
          {draft && (
            <>
              <div className="note-meta" role="status">
                {sealed
                  ? '等待确认，原稿已锁定'
                  : noteDirty(draft)
                    ? '修改保留在本机，尚未保存到便笺'
                    : draft.base
                      ? '已保存到便笺'
                      : '尚未填写'}
                {draft.base && (
                  <span>
                    {draft.base.deleted ? '已在回收站' : `版本 ${draft.base.revision}`} ·{' '}
                    {draft.base.updatedBy.kind === 'human' ? '你' : bot.name}更新于{' '}
                    <time dateTime={draft.base.updatedAt}>{time(draft.base.updatedAt)}</time>
                  </span>
                )}
              </div>
              <label className="field-label">
                便笺标题
                <input
                  className="field"
                  value={draft.title}
                  readOnly={readOnly}
                  maxLength={200}
                  placeholder="需要记住的事项"
                  onChange={(event) => mutate({ title: event.target.value })}
                />
              </label>
              <label className="field-label">
                便笺正文
                <textarea
                  className="field note-body"
                  rows={8}
                  value={draft.body}
                  readOnly={readOnly}
                  maxLength={4000}
                  placeholder="补充信息、记录进展或留个想法"
                  onChange={(event) => mutate({ body: event.target.value })}
                />
              </label>
              <div className="field-label">
                便笺状态
                <Select
                  label="便笺状态"
                  value={draft.status}
                  disabled={readOnly}
                  onValueChange={(value) => mutate({ status: value as NoteFields['status'] })}
                  options={noteStates.map((status) => ({ value: status, label: states[status] }))}
                />
              </div>
              {draft.base?.completedAt && (
                <p className="inline-note">
                  完成于{' '}
                  <time dateTime={draft.base.completedAt}>{time(draft.base.completedAt)}</time>
                </p>
              )}
              {latest && (
                <section className="note-conflict" aria-label="便笺版本核对">
                  <h3>核对不同版本</h3>
                  <p>
                    你正在编辑的内容仍在上方。保留更改会把你改过的字段合入最新版本；采用最新版本会放弃这些本机更改。
                  </p>
                  {/* This bounded comparison needs keyboard scrolling without moving focus into the editor. */}
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Long version text needs keyboard scrolling. */}
                  <section className="note-versions" tabIndex={0} aria-label="修改前和最新便笺内容">
                    <h4>修改前 · 版本 {draft.base?.revision}</h4>
                    <strong>{draft.base?.title}</strong>
                    <p>{draft.base?.body || '没有正文'}</p>
                    <p>{draft.base && states[draft.base.status]}</p>
                    <h4>
                      最新 · 版本 {latest.revision}
                      {latest.deleted ? ' · 已在回收站' : ''}
                    </h4>
                    <strong>{latest.title}</strong>
                    <p>{latest.body || '没有正文'}</p>
                    <p>{states[latest.status]}</p>
                  </section>
                  <div className="notes-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!pending || notes.history}
                      onClick={() => notes.merge(true)}
                    >
                      保留我的更改
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!pending}
                      onClick={() => notes.merge(false)}
                    >
                      采用最新版本
                    </button>
                  </div>
                </section>
              )}
              <div className="notes-actions note-save">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    readOnly ||
                    notes.blocked ||
                    !!pending ||
                    !noteDirty(draft) ||
                    !!draft.base?.deleted ||
                    !!latest
                  }
                  onClick={() => run(notes.save())}
                >
                  保存便笺
                </button>
                {noteDirty(draft) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={sealed || notes.reading}
                    onClick={() => {
                      setConfirm(undefined);
                      notes.discard();
                    }}
                  >
                    放弃本次修改
                  </button>
                )}
              </div>
              {draft.base && (
                <div className="note-maintenance">
                  <button
                    type="button"
                    className="text-button"
                    disabled={!notes.available || !!pending || notes.reading}
                    onClick={() => run(notes.open(draft.base!.id, true))}
                  >
                    核对最新版本
                  </button>
                  {draft.base.deleted ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        notes.blocked || !notes.available || !!pending || notes.reading || !!latest
                      }
                      onClick={() => run(notes.changeStatus('restore'))}
                    >
                      恢复便笺
                    </button>
                  ) : confirming ? (
                    <fieldset className="note-trash-confirm" aria-label="确认移入回收站">
                      <p>便笺将移入回收站，之后可以恢复。</p>
                      <button
                        type="button"
                        className="secondary danger-text"
                        disabled={
                          notes.blocked ||
                          !!pending ||
                          !notes.available ||
                          noteDirty(draft) ||
                          !!latest
                        }
                        onClick={() => run(notes.changeStatus('trash'))}
                      >
                        确认移入
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setConfirm(undefined)}
                      >
                        取消
                      </button>
                    </fieldset>
                  ) : (
                    <button
                      type="button"
                      className="text-button danger-text"
                      disabled={
                        notes.blocked ||
                        !notes.available ||
                        !!pending ||
                        noteDirty(draft) ||
                        notes.reading ||
                        !!latest
                      }
                      onClick={() =>
                        setConfirm({
                          key: draft.key,
                          id: draft.base!.id,
                          revision: draft.base!.revision,
                        })
                      }
                    >
                      移入回收站
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <section className="notes-collection" aria-label="便笺列表">
          {draft && (
            <button
              type="button"
              className="text-button note-resume"
              onClick={() => notes.setEditorVisible(true)}
            >
              继续{noteDirty(draft) ? '未保存的编辑' : '上次查看的便笺'}
            </button>
          )}
          <div className="notes-filters">
            <label className="note-search">
              <Search size={14} />
              <input
                className="field"
                aria-label="搜索便笺"
                placeholder="搜索标题和正文"
                maxLength={200}
                value={cache.text}
                onChange={(event) =>
                  dispatch({
                    type: 'notes-options',
                    bot: bot.id,
                    patch: { text: event.target.value },
                  })
                }
              />
            </label>
            <Select
              label="便笺筛选"
              value={cache.filter}
              onValueChange={(value) =>
                dispatch({
                  type: 'notes-options',
                  bot: bot.id,
                  patch: { filter: value as typeof cache.filter },
                })
              }
              options={Object.entries(filters).map(([value, label]) => ({ value, label }))}
            />
          </div>
          {notes.listError && (
            <p className="error-text" role="alert">
              {notes.listError}
            </p>
          )}
          {(notes.loading || (notes.available && !notes.loaded && !notes.listError)) && (
            <p className="inline-note" role="status">
              正在读取便笺…
            </p>
          )}
          <ul className="notes-list">
            {notes.items.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="note-row"
                  disabled={!!pending}
                  aria-label={`查看便笺 ${row.title}`}
                  onClick={() => {
                    setConfirm(undefined);
                    run(notes.open(row.id));
                  }}
                >
                  <span className="note-row-heading">
                    <strong>{row.title}</strong>
                    <span>{states[row.status]}</span>
                  </span>
                  {row.body && (
                    <span className="note-preview">
                      {row.body}
                      {row.bodyTruncated ? '…' : ''}
                    </span>
                  )}
                  <time className="note-meta" dateTime={row.updatedAt}>
                    {time(row.updatedAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
          {notes.next !== undefined && (
            <button
              type="button"
              className="text-button"
              disabled={notes.loading}
              onClick={() => run(notes.load(true))}
            >
              加载更早便笺
            </button>
          )}
          {notes.available &&
            notes.loaded &&
            !notes.loading &&
            !notes.listError &&
            !notes.items.length && (
              <div className="empty-panel">
                <StickyNote />
                <h3>
                  {cache.text
                    ? '没有匹配的便笺'
                    : cache.filter === 'trash'
                      ? '回收站是空的'
                      : '这里还没有便笺'}
                </h3>
                <p>
                  {cache.text
                    ? '换个关键词或筛选再试。'
                    : '你可以在这里记录，也可以让这位 Bot 在对话中记下事项。'}
                </p>
              </div>
            )}
        </section>
      )}
    </section>
  );
}
