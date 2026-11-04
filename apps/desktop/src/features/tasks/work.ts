import {
  isWorkCompleted,
  isWorkItem,
  isWorkList,
  isWorkReceipt,
  recoveryBlocked,
  type WorkItem,
  type WorkQuery,
  type WorkSummary,
  type WorkWrite,
  workKey,
  workQueryKey,
} from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCache } from '../../app/CacheProvider';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Action, reduce, type State } from '../../app/state';
import { serialize, storageKey } from '../../app/storage';
import { t } from '../../i18n/locale';
import { commentCard } from './comments-state';
import {
  sameWorkContent,
  sameWorkDraft,
  type WorkPending,
  workDirty,
  workDraft,
  workInitial,
  workInput,
} from './work-state';

const keyOf = (request: WorkWrite) => workKey(request, { kind: 'human' });
const rejected = new Set([
  'WORK_CONFLICT',
  'WORK_TRASHED',
  'WORK_NOT_FOUND',
  'WORK_ID_CONFLICT',
  'WORK_LIMIT',
  'WORK_OPERATION_LIMIT',
  'INVALID_WORK_WRITE',
  'WORK_REOPEN_REQUIRED',
  'WORK_REOPEN_FORBIDDEN',
  'WORK_STATE_CONFLICT',
  'UNKNOWN_BOT',
  'BOT_ARCHIVED',
]);
const notSent = new Set(['INVALID_COMMAND', 'RUNTIME_TOO_OLD', 'RUNTIME_RECOVERY_PENDING']);
const summary = (item: WorkItem): WorkSummary => {
  const { description: _description, progress, ...fields } = item;
  return {
    ...fields,
    progress: Array.from(progress).slice(0, 200).join(''),
    progressTruncated: Array.from(progress).length > 200,
  };
};
function matches(item: WorkItem, query: WorkQuery) {
  // SQLite LIKE folds ASCII only; local acknowledgement updates must follow the same search semantics.
  const fold = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return (
    item.deleted === (query.filter === 'trash') &&
    (query.filter !== 'open' || !isWorkCompleted(item.status)) &&
    (query.filter !== 'done' || isWorkCompleted(item.status)) &&
    (query.status === undefined || query.status === item.status) &&
    (query.priority === undefined || query.priority === (item.priority ?? 'normal')) &&
    (!Object.hasOwn(query, 'assignee') || query.assignee === (item.assignee ?? null)) &&
    (!query.text ||
      [item.title, item.description, item.progress].some((text) =>
        fold(text).includes(fold(query.text!)),
      ))
  );
}
export function useWork(
  state: State,
  dispatch: Dispatch<Action>,
  notify: (text: string) => unknown,
) {
  const storage = useCache();
  const runtime = useRuntime();
  const cache = state.work ?? workInitial();
  const current = useRef(state);
  current.current = state;
  const pending = useRef(cache.pending);
  pending.current = cache.pending;
  const mounted = useRef(true);
  const writer = useRef<string | undefined>(undefined),
    checker = useRef<string | undefined>(undefined);
  const reader = useRef(0),
    listing = useRef(0);
  const [working, setWorking] = useState(false),
    [checking, setChecking] = useState(false),
    [loading, setLoading] = useState(false),
    [reading, setReading] = useState(false);
  const [error, setError] = useState(''),
    [listError, setListError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [items, setItems] = useState<WorkSummary[]>([]),
    [next, setNext] = useState<number>();
  const [revision, setRevision] = useState<number>(),
    [latest, setLatest] = useState<{ key: string; item: WorkItem }>();
  const [editorVisible, setEditorVisible] = useState(!!cache.draft);
  const query = useMemo<WorkQuery>(
    () => ({ filter: cache.filter, text: cache.text.trim(), limit: 50 }),
    [cache.filter, cache.text],
  );
  const queryKey = workQueryKey(query),
    queryRef = useRef(query);
  queryRef.current = query;
  const data = useRef<{ items: WorkSummary[]; key: string; next?: number }>({ items: [], key: '' });
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 36 &&
    runtime.snapshot.work?.available === true;
  const blocked = recoveryBlocked(runtime.snapshot);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reader.current++;
      listing.current++;
    };
  }, []);
  useEffect(() => {
    setLatest((previous) => (previous?.key === cache.draft?.key ? previous : undefined));
  }, [cache.draft?.key]);
  const load = useCallback(
    async (append = false) => {
      if (!available) return;
      const selected = structuredClone(queryRef.current),
        key = workQueryKey(selected);
      const before = append && data.current.key === key ? data.current.next : undefined;
      if (append && before === undefined) return;
      const requested = { ...selected, ...(before === undefined ? {} : { before }) },
        token = ++listing.current;
      setLoading(true);
      setListError('');
      try {
        const value = await runtime.command({ type: 'work.list', query: requested });
        if (!mounted.current || listing.current !== token || workQueryKey(queryRef.current) !== key)
          return;
        if (!isWorkList(value) || workQueryKey(value.query) !== workQueryKey(requested))
          throw Error('INVALID_WORK_PAGE');
        const merged = new Map((append ? data.current.items : []).map((item) => [item.id, item]));
        for (const item of value.page.items)
          if ((merged.get(item.id)?.revision ?? 0) <= item.revision) merged.set(item.id, item);
        const rows = [...merged.values()];
        data.current = { items: rows, key, next: value.page.nextBefore };
        setItems(rows);
        setNext(value.page.nextBefore);
        // A later page does not refresh earlier rows; only a full refresh can advance their revision baseline.
        setRevision((previous) =>
          append && previous !== undefined ? previous : value.page.revision,
        );
      } catch (error) {
        if (mounted.current && listing.current === token) setListError(runtimeError(error));
      } finally {
        if (mounted.current && listing.current === token) setLoading(false);
      }
    },
    [available, runtime.command],
  );
  useEffect(() => {
    if (state.view !== 'tasks' || !available) return;
    data.current = { items: [], key: queryKey };
    setItems([]);
    setLoading(true);
    setNext(undefined);
    setRevision(undefined);
    const timer = setTimeout(() => {
      load().catch(() => setListError(t('work.taskCannotReadRightNow')));
    }, 150);
    return () => {
      clearTimeout(timer);
      listing.current++;
      setLoading(false);
    };
  }, [state.view, available, queryKey, load]);
  const owns = useCallback(
    (input: WorkPending) =>
      mounted.current &&
      !!pending.current &&
      keyOf(input.request) === keyOf(pending.current.request),
    [],
  );
  const remember = useCallback((item: WorkItem, created = false) => {
    const selected = queryRef.current;
    if (data.current.key !== workQueryKey(selected)) return;
    const old = data.current.items.find((row) => row.id === item.id);
    if (old && old.revision > item.revision) return;
    let rows = data.current.items.filter((row) => row.id !== item.id);
    if (matches(item, selected)) {
      if (old) rows = data.current.items.map((row) => (row.id === item.id ? summary(item) : row));
      else if (created) rows = [summary(item), ...rows];
    }
    data.current = { ...data.current, items: rows };
    setItems(rows);
  }, []);
  const observe = useCallback(
    (item: WorkItem) => {
      if (!isWorkItem(item)) return;
      remember(item);
      const draft = current.current.work?.draft;
      if (
        !draft?.base ||
        draft.base.id !== item.id ||
        item.revision <= draft.base.revision ||
        current.current.work?.pending?.request.item === item.id
      )
        return;
      if (workDirty(draft) && !sameWorkContent(draft.base, item)) {
        setLatest((previous) =>
          previous?.key === draft.key && previous.item.revision > item.revision
            ? previous
            : { key: draft.key, item },
        );
      } else {
        dispatch({ type: 'work-observe', key: draft.key, item });
        setLatest((previous) =>
          previous?.key === draft.key && previous.item.revision <= item.revision
            ? undefined
            : previous,
        );
      }
    },
    [dispatch, remember],
  );
  const accept = useCallback(
    (value: unknown, input: WorkPending, readingOnly: boolean) => {
      if (!owns(input)) return;
      if (
        !isWorkReceipt(value) ||
        value.actor.kind !== 'human' ||
        keyOf(value.request) !== keyOf(input.request) ||
        (!readingOnly && value.state !== 'complete')
      )
        throw Error('INVALID_WORK_ACK');
      if (value.state === 'unknown') return;
      const key = keyOf(input.request);
      pending.current = undefined;
      if (writer.current === key) {
        writer.current = undefined;
        setWorking(false);
      }
      if (checker.current === key) {
        checker.current = undefined;
        setChecking(false);
      }
      dispatch({ type: 'work-settle', receipt: value });
      setOperationError('');
      if (sameWorkDraft(current.current.work?.draft, input.draft)) {
        setError('');
        setLatest(undefined);
      }
      remember(value.item, input.request.action === 'create');
      notify(
        input.request.action === 'create'
          ? t('work.taskCreatedHasNotRunAutomatically')
          : t('work.taskActionConfirmed'),
      );
    },
    [dispatch, notify, owns, remember],
  );
  const check = useCallback(async () => {
    const input = pending.current;
    if (!available || !input || checker.current) return;
    const key = keyOf(input.request);
    checker.current = key;
    setChecking(true);
    try {
      accept(
        await runtime.command({ type: 'work.receipt', request: structuredClone(input.request) }),
        input,
        true,
      );
    } catch (error) {
      if (owns(input)) setOperationError(runtimeError(error));
    } finally {
      if (checker.current === key) {
        checker.current = undefined;
        if (mounted.current) setChecking(false);
      }
    }
  }, [available, runtime.command, accept, owns]);
  useEffect(() => {
    if (!cache.pending || !available) return;
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      await check();
      if (live && pending.current)
        timer = setTimeout(() => {
          tick().catch(() => {});
        }, 1000);
    }
    tick().catch(() => {});
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cache.pending, available, check]);
  async function send(input: WorkPending, resuming: boolean) {
    if (
      !available ||
      blocked ||
      writer.current ||
      (pending.current && keyOf(pending.current.request) !== keyOf(input.request))
    )
      return;
    const action: Action = { type: 'work-pending', pending: input };
    const updated = resuming ? current.current : reduce(current.current, action);
    if (!updated.work?.pending || keyOf(updated.work.pending.request) !== keyOf(input.request))
      return;
    try {
      storage.setItem(storageKey, serialize(updated));
    } catch {
      (resuming ? setOperationError : setError)(
        t('common.operationRecordsCouldNotSavedLocallyFree'),
      );
      return;
    }
    if (!resuming) dispatch(action);
    pending.current = structuredClone(input);
    const key = keyOf(input.request);
    writer.current = key;
    setWorking(true);
    setOperationError('');
    if (sameWorkDraft(current.current.work?.draft, input.draft)) setError('');
    try {
      accept(
        await runtime.command({ type: 'work.write', request: structuredClone(input.request) }),
        input,
        false,
      );
    } catch (error) {
      if (owns(input)) {
        setOperationError(runtimeError(error));
        if (
          error instanceof Error &&
          (rejected.has(error.message) || (!resuming && notSent.has(error.message)))
        ) {
          pending.current = undefined;
          dispatch({ type: 'work-release', request: input.request });
          if (sameWorkDraft(current.current.work?.draft, input.draft))
            setError(runtimeError(error));
          else setListError(runtimeError(error));
        }
      }
    } finally {
      if (writer.current === key) {
        writer.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  }
  async function save() {
    const draft = current.current.work?.draft;
    if (
      !draft ||
      pending.current ||
      (draft.base && commentCard(current.current.comments, draft.base.id).pending)
    )
      return;
    const request = workInput(draft);
    if (!request) {
      setError(t('work.enterTaskTitleUpCharactersDescriptionProgress'));
      return;
    }
    await send({ request, draft: structuredClone(draft) }, false);
  }
  async function changeStatus(action: 'trash' | 'restore') {
    const draft = current.current.work?.draft;
    if (
      !draft?.base ||
      pending.current ||
      commentCard(current.current.comments, draft.base.id).pending ||
      (action === 'trash' && workDirty(draft))
    )
      return;
    await send(
      {
        request: {
          id: crypto.randomUUID(),
          item: draft.base.id,
          revision: draft.base.revision,
          action,
        },
        draft: structuredClone(draft),
      },
      false,
    );
  }
  function fresh() {
    const previous = current.current.work?.draft;
    if (workDirty(previous) && pending.current?.draft.key !== previous?.key) {
      setError(t('work.saveDiscardCurrentEditsCreatingTask'));
      setEditorVisible(true);
      return;
    }
    reader.current++;
    setReading(false);
    setLatest(undefined);
    setError('');
    setEditorVisible(true);
    dispatch({ type: 'work-draft', previous, draft: workDraft() });
  }
  async function open(id: string, review = false) {
    if (!available) return;
    const previous = current.current.work?.draft;
    setEditorVisible(true);
    if (!review && previous?.base?.id === id && workDirty(previous)) return;
    if (!review && workDirty(previous) && pending.current?.draft.key !== previous?.key) {
      setError(t('work.saveDiscardCurrentEditsOpeningAnotherTask'));
      return;
    }
    const token = ++reader.current;
    setReading(true);
    setError('');
    try {
      const value = await runtime.command({ type: 'work.read', id });
      if (
        !mounted.current ||
        reader.current !== token ||
        !sameWorkDraft(current.current.work?.draft, previous)
      )
        return;
      if (
        !isWorkItem(value) ||
        value.id !== id ||
        (previous?.base?.id === id && value.revision < previous.base.revision)
      )
        throw Error('INVALID_WORK_ITEM');
      if (review && previous) setLatest({ key: previous.key, item: value });
      else dispatch({ type: 'work-draft', previous, draft: workDraft(value) });
    } catch (error) {
      if (mounted.current && reader.current === token) setError(runtimeError(error));
    } finally {
      if (mounted.current && reader.current === token) setReading(false);
    }
  }
  function discard() {
    const previous = current.current.work?.draft;
    if (!previous || pending.current?.draft.key === previous.key) return;
    reader.current++;
    setReading(false);
    setLatest(undefined);
    setError('');
    dispatch({
      type: 'work-draft',
      previous,
      draft: previous.base ? workDraft(previous.base, previous.key) : workDraft(),
    });
  }
  function merge(keep: boolean) {
    if (!latest) return;
    dispatch({ type: 'work-merge', key: latest.key, latest: latest.item, keep });
    setLatest(undefined);
    setError('');
  }
  return {
    available,
    blocked,
    items,
    next,
    revision,
    changed:
      revision !== undefined &&
      runtime.snapshot.work?.available &&
      runtime.snapshot.work.revision !== revision,
    working,
    checking,
    loading,
    reading,
    error,
    operationError,
    listError,
    latest,
    editorVisible,
    setEditorVisible,
    load,
    check,
    save,
    changeStatus,
    fresh,
    open,
    discard,
    merge,
    observe,
    retry: async () => {
      if (pending.current) await send(pending.current, true);
    },
  };
}
export type WorkController = ReturnType<typeof useWork>;
