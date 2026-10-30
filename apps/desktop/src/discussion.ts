import {
  isWorkCommentList,
  isWorkCommentReceipt,
  isWorkCommentWrite,
  isWorkItem,
  recoveryBlocked,
  type WorkComment,
  type WorkCommentQuery,
  type WorkItem,
  workCommentQueryKey,
} from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { type CommentPending, commentCard, commentKey } from './comments-state';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, reduce, type State } from './state';
import { serialize, storageKey } from './storage';
import { sameWorkContent } from './work-state';

const rejected = new Set([
  'WORK_CONFLICT',
  'WORK_TRASHED',
  'WORK_NOT_FOUND',
  'WORK_OPERATION_LIMIT',
  'INVALID_WORK_COMMENT',
]);
const notSent = new Set(['INVALID_COMMAND', 'RUNTIME_TOO_OLD', 'RUNTIME_RECOVERY_PENDING']);
function message(error: unknown) {
  if (error instanceof Error && error.message === 'WORK_CONFLICT')
    return '任务已更新，评论正文仍保留。核对最新任务后再发表评论。';
  if (error instanceof Error && error.message === 'WORK_TRASHED')
    return '任务已在回收站，评论正文仍保留。恢复任务后可继续发表。';
  return runtimeError(error);
}
export function useComments(
  state: State,
  dispatch: Dispatch<Action>,
  item: WorkItem,
  observe: (item: WorkItem) => unknown,
) {
  const runtime = useRuntime(),
    card = commentCard(state.comments, item.id);
  const current = useRef(state);
  current.current = state;
  const parent = useRef(item);
  parent.current = item;
  const pending = useRef(card.pending);
  pending.current = card.pending;
  const mounted = useRef(true),
    writer = useRef<string | undefined>(undefined),
    checker = useRef<string | undefined>(undefined),
    listing = useRef(0);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 38 &&
    runtime.snapshot.work?.available === true;
  const blocked = recoveryBlocked(runtime.snapshot);
  const busyParent = state.work?.pending?.request.item === item.id;
  const ready = useRef({ available, blocked, busyParent });
  ready.current = { available, blocked, busyParent };
  const [working, setWorking] = useState(false),
    [checking, setChecking] = useState(false),
    [loading, setLoading] = useState(available);
  const [rows, setRows] = useState<WorkComment[]>([]),
    [next, setNext] = useState<number>(),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''),
    [listError, setListError] = useState(''),
    [status, setStatus] = useState('');
  const data = useRef<{ rows: WorkComment[]; next?: number }>({ rows: [] });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listing.current++;
    };
  }, []);
  const load = useCallback(
    async (append = false) => {
      if (!available || (append && data.current.next === undefined)) return;
      const query: WorkCommentQuery = {
          item: item.id,
          limit: 10,
          ...(append ? { before: data.current.next } : {}),
        },
        token = ++listing.current;
      setLoading(true);
      setListError('');
      try {
        const value = await runtime.command({ type: 'work.comments', query });
        if (!mounted.current || token !== listing.current) return;
        if (
          !isWorkCommentList(value) ||
          workCommentQueryKey(value.query) !== workCommentQueryKey(query)
        )
          throw Error('INVALID_WORK_COMMENT_PAGE');
        const merged = new Map((append ? data.current.rows : []).map((row) => [row.id, row]));
        for (const row of value.page.comments) merged.set(row.id, row);
        const values = [...merged.values()];
        data.current = { rows: values, next: value.page.nextBefore };
        setRows(values);
        setNext(value.page.nextBefore);
        setLoaded(true);
      } catch (error) {
        if (mounted.current && token === listing.current)
          setListError(`讨论暂时无法读取。${runtimeError(error)}`);
      } finally {
        if (mounted.current && token === listing.current) setLoading(false);
      }
    },
    [available, item.id, runtime.command],
  );
  const revision = runtime.snapshot.work?.available ? runtime.snapshot.work.revision : undefined;
  useEffect(() => {
    if (available && revision !== undefined) load().catch(() => {});
  }, [available, revision, load]);
  const owns = useCallback(
    (input: CommentPending) =>
      mounted.current &&
      !!pending.current &&
      commentKey(pending.current.request) === commentKey(input.request),
    [],
  );
  const accept = useCallback(
    (value: unknown, input: CommentPending, readOnly: boolean) => {
      if (!owns(input)) return;
      if (
        !isWorkCommentReceipt(value) ||
        value.actor.kind !== 'human' ||
        commentKey(value.request) !== commentKey(input.request)
      )
        throw Error('INVALID_WORK_COMMENT_ACK');
      if (value.state === 'unknown') {
        if (!readOnly) throw Error('INVALID_WORK_COMMENT_ACK');
        setStatus('暂未查到发表记录。正文和原评论请求仍保留，可以继续核对或重试。');
        return;
      }
      pending.current = undefined;
      dispatch({ type: 'comment-settle', receipt: value });
      observe(value.item);
      setError('');
      setStatus('评论已发表。');
      load().catch(() => {});
    },
    [dispatch, observe, load, owns],
  );
  const check = useCallback(async () => {
    const input = pending.current;
    if (!available || !input || checker.current || writer.current) return;
    const key = commentKey(input.request);
    checker.current = key;
    setChecking(true);
    setError('');
    try {
      accept(
        await runtime.command({
          type: 'work.comment-receipt',
          request: structuredClone(input.request),
        }),
        input,
        true,
      );
    } catch (error) {
      if (owns(input)) setError(message(error));
    } finally {
      if (checker.current === key) {
        checker.current = undefined;
        if (mounted.current) setChecking(false);
      }
    }
  }, [available, accept, runtime.command, owns]);
  const pendingKey = card.pending ? commentKey(card.pending.request) : undefined;
  useEffect(() => {
    if (pendingKey && available) check().catch(() => {});
  }, [pendingKey, available, check]);
  async function perform(input: CommentPending, resuming: boolean) {
    if (
      !mounted.current ||
      !ready.current.available ||
      ready.current.blocked ||
      ready.current.busyParent
    )
      return;
    const action: Action = { type: 'comment-pending', pending: input },
      updated = resuming ? current.current : reduce(current.current, action);
    const saved = commentCard(updated.comments, input.request.item).pending;
    if (!saved || commentKey(saved.request) !== commentKey(input.request)) return;
    try {
      // Persist the exact intent before dispatch: an uncertain reply must recover this request rather than create another.
      localStorage.setItem(storageKey, serialize(updated));
    } catch {
      setError('本机无法保存操作记录，评论尚未发送。请释放存储空间后重试；正文仍保留。');
      return;
    }
    if (!resuming) dispatch(action);
    pending.current = structuredClone(input);
    const key = commentKey(input.request);
    writer.current = key;
    setWorking(true);
    setError('');
    setStatus('');
    try {
      accept(
        await runtime.command({ type: 'work.comment', request: structuredClone(input.request) }),
        input,
        false,
      );
    } catch (error) {
      if (!owns(input)) return;
      setError(message(error));
      if (
        error instanceof Error &&
        (rejected.has(error.message) || (!resuming && notSent.has(error.message)))
      ) {
        pending.current = undefined;
        dispatch({ type: 'comment-release', request: input.request });
        try {
          const value = await runtime.command({ type: 'work.read', id: input.request.item });
          if (mounted.current && isWorkItem(value) && value.id === input.request.item)
            observe(value);
        } catch {
          /* The draft remains editable even when the conflict read is unavailable. */
        }
      }
    } finally {
      if (writer.current === key) {
        writer.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  }
  async function publish() {
    if (!available || blocked || busyParent || pending.current || writer.current) return;
    const draft = commentCard(current.current.comments, item.id).draft;
    if (!draft?.body.trim() || draft.body.length > 10000 || draft.body.includes('\0')) {
      setError('请填写评论正文，最多 10,000 字符。');
      return;
    }
    const captured = structuredClone(draft),
      previous = structuredClone(parent.current),
      token = `preparing-${crypto.randomUUID()}`;
    writer.current = token;
    setWorking(true);
    setError('');
    setStatus('');
    try {
      const value = await runtime.command({ type: 'work.read', id: item.id });
      const latestDraft = commentCard(current.current.comments, item.id).draft;
      // A delayed full read cannot submit after navigation or on behalf of a later composition.
      if (
        !mounted.current ||
        writer.current !== token ||
        latestDraft?.key !== captured.key ||
        latestDraft.body !== captured.body
      )
        return;
      if (!isWorkItem(value) || value.id !== item.id || value.revision < previous.revision)
        throw Error('INVALID_WORK_ITEM');
      observe(value);
      if (value.deleted) {
        setError('任务已在回收站，恢复后可继续发表评论。');
        return;
      }
      if (!sameWorkContent(previous, value)) {
        setError('任务已有更新。请核对最新任务内容，再发表保留的评论。');
        return;
      }
      const request = {
        id: crypto.randomUUID(),
        item: item.id,
        revision: value.revision,
        body: captured.body,
      };
      if (!isWorkCommentWrite(request)) throw Error('INVALID_WORK_COMMENT');
      await perform({ request, draft: captured }, false);
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (writer.current === token) {
        writer.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  }
  function change(body: string) {
    if (pending.current || writer.current) return;
    const previous = commentCard(current.current.comments, item.id).draft;
    dispatch({
      type: 'comment-draft',
      item: item.id,
      draft: { key: previous?.key ?? crypto.randomUUID(), body },
    });
    setError('');
    setStatus('');
  }
  async function retry() {
    if (!pending.current || writer.current || !available || blocked || busyParent) return;
    await perform(structuredClone(pending.current), true);
  }
  return {
    available,
    blocked,
    busyParent,
    working,
    checking,
    loading,
    loaded,
    rows,
    next,
    error,
    listError,
    status,
    load,
    check,
    publish,
    change,
    retry,
  };
}
