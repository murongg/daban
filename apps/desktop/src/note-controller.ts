import {
  agentId,
  isNoteItem,
  isNoteList,
  isNoteReceipt,
  type NoteItem,
  type NoteQuery,
  type NoteSummary,
  type NoteWrite,
  noteKey,
  noteQueryKey,
  recoveryBlocked,
} from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientCache } from './cache';
import { t } from './locale';
import {
  type NotePending,
  noteDirty,
  noteDraft,
  noteInitial,
  noteInput,
  sameNoteDraft,
} from './notes-state';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, type Bot, lifecycleRequest, reduce, type State } from './state';
import { serialize, storageKey } from './storage';

const rejected = new Set([
  'NOTE_CONFLICT',
  'NOTE_TRASHED',
  'NOTE_NOT_FOUND',
  'NOTE_ID_CONFLICT',
  'NOTE_LIMIT',
  'NOTE_OPERATION_LIMIT',
  'INVALID_NOTE_WRITE',
]);
const notSent = new Set(['INVALID_COMMAND', 'RUNTIME_TOO_OLD', 'RUNTIME_RECOVERY_PENDING']);
const readError = (error: unknown, subject: string) =>
  error instanceof Error && ['RUNTIME_REQUEST_FAILED', 'RUNTIME_OFFLINE'].includes(error.message)
    ? t('notecontroller.temporarilyUnreadableCheckConnectionRefreshNotes', { 0: subject })
    : runtimeError(error);

// Notes is keyed by Bot in the workspace: unmounting invalidates reads/acks, never the durable intent.
export function useNotes(
  state: State,
  bot: Bot,
  dispatch: Dispatch<Action>,
  notify: (text: string) => unknown,
) {
  const runtime = useRuntime();
  const scope = agentId(bot.id);
  const keyOf = useCallback(
    (request: NoteWrite) => noteKey(scope, request, { kind: 'human' }),
    [scope],
  );
  const cache = state.notes?.[bot.id] ?? noteInitial();
  const current = useRef(state);
  current.current = state;
  const pending = useRef(cache.pending);
  pending.current = cache.pending;
  const mounted = useRef(true),
    reader = useRef(0),
    listing = useRef(0);
  const writer = useRef<string | undefined>(undefined),
    checker = useRef<string | undefined>(undefined);
  const [working, setWorking] = useState(false),
    [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(false),
    [reading, setReading] = useState(false);
  const [error, setError] = useState(''),
    [listError, setListError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [latest, setLatest] = useState<{ key: string; item: NoteItem }>();
  const [editorVisible, setEditorVisible] = useState(!!cache.draft);
  const [page, setPage] = useState<{
    key: string;
    items: NoteSummary[];
    next?: number;
    loaded?: true;
  }>({
    key: '',
    items: [],
  });
  const data = useRef(page);
  const query = useMemo<NoteQuery>(
    () => ({ filter: cache.filter, text: cache.text.trim(), limit: 50 }),
    [cache.filter, cache.text],
  );
  const queryKey = noteQueryKey(query),
    queryRef = useRef(query);
  queryRef.current = query;
  const profile = runtime.snapshot.profiles.find((profile) => profile.id === scope);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 37 &&
    runtime.snapshot.notes?.available === true &&
    !!profile &&
    !bot.members;
  const history =
    !!bot.archived || !!profile?.archived || !!lifecycleRequest(state, bot.id, profile);
  const blocked = history || recoveryBlocked(runtime.snapshot);
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
        key = noteQueryKey(selected);
      const before = append && data.current.key === key ? data.current.next : undefined;
      if (append && before === undefined) return;
      const requested = { ...selected, ...(before === undefined ? {} : { before }) };
      const token = ++listing.current;
      setLoading(true);
      setListError('');
      try {
        const value = await runtime.command({ type: 'notes.list', bot: scope, query: requested });
        if (!mounted.current || listing.current !== token || noteQueryKey(queryRef.current) !== key)
          return;
        if (
          !isNoteList(value) ||
          value.bot !== scope ||
          noteQueryKey(value.query) !== noteQueryKey(requested)
        )
          throw Error('INVALID_NOTE_PAGE');
        const merged = new Map((append ? data.current.items : []).map((item) => [item.id, item]));
        for (const item of value.page.items)
          if ((merged.get(item.id)?.revision ?? 0) <= item.revision) merged.set(item.id, item);
        data.current = {
          key,
          items: [...merged.values()],
          next: value.page.nextBefore,
          loaded: true,
        };
        setPage(data.current);
      } catch (error) {
        if (mounted.current && listing.current === token)
          setListError(readError(error, t('common.noteList')));
      } finally {
        if (mounted.current && listing.current === token) setLoading(false);
      }
    },
    [available, runtime.command, scope],
  );
  useEffect(() => {
    if (!available) return;
    data.current = { key: queryKey, items: [] };
    setPage(data.current);
    const timer = setTimeout(() => {
      load().catch(() => setListError(t('notecontroller.noteCannotReadRightNow')));
    }, 150);
    return () => {
      clearTimeout(timer);
      listing.current++;
      setLoading(false);
    };
  }, [available, queryKey, load]);
  const owns = useCallback(
    (input: NotePending) =>
      mounted.current &&
      !!pending.current &&
      keyOf(input.request) === keyOf(pending.current.request),
    [keyOf],
  );
  const accept = useCallback(
    (value: unknown, input: NotePending, readingOnly: boolean) => {
      if (!owns(input)) return;
      if (
        !isNoteReceipt(value) ||
        value.bot !== scope ||
        value.actor.kind !== 'human' ||
        keyOf(value.request) !== keyOf(input.request) ||
        (!readingOnly && value.state !== 'complete')
      )
        throw Error('INVALID_NOTE_ACK');
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
      dispatch({ type: 'notes-settle', bot: bot.id, receipt: value });
      setOperationError('');
      if (sameNoteDraft(current.current.notes?.[bot.id]?.draft, input.draft)) {
        setError('');
        setLatest(undefined);
      }
      load().catch(() => setListError(t('notecontroller.saveConfirmedListHasNotRefreshedYet')));
      notify(t('notecontroller.noteActionConfirmed'));
    },
    [bot.id, dispatch, keyOf, load, notify, owns, scope],
  );
  const check = useCallback(async () => {
    const input = pending.current;
    if (!available || !input || checker.current) return;
    const key = keyOf(input.request);
    checker.current = key;
    setChecking(true);
    try {
      accept(
        await runtime.command({
          type: 'notes.receipt',
          bot: scope,
          request: structuredClone(input.request),
        }),
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
  }, [available, runtime.command, accept, owns, keyOf, scope]);
  const pendingKey = cache.pending ? keyOf(cache.pending.request) : undefined;
  useEffect(() => {
    if (!pendingKey || !available) return;
    check().catch(() => {});
    const timer = setInterval(() => {
      check().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingKey, available, check]);
  async function send(input: NotePending, resuming: boolean) {
    if (
      !available ||
      blocked ||
      writer.current ||
      (pending.current && keyOf(pending.current.request) !== keyOf(input.request))
    )
      return;
    const action: Action = { type: 'notes-pending', bot: bot.id, pending: input };
    const updated = resuming ? current.current : reduce(current.current, action);
    const saved = updated.notes?.[bot.id]?.pending;
    if (!saved || keyOf(saved.request) !== keyOf(input.request)) return;
    try {
      // The exact Bot-bound intent must survive a crash before any remote side effect is sent.
      clientCache().setItem(storageKey, serialize(updated));
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
    if (sameNoteDraft(current.current.notes?.[bot.id]?.draft, input.draft)) setError('');
    try {
      accept(
        await runtime.command({
          type: 'notes.write',
          bot: scope,
          request: structuredClone(input.request),
        }),
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
          dispatch({ type: 'notes-release', bot: bot.id, request: input.request });
          setError(runtimeError(error));
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
    const draft = current.current.notes?.[bot.id]?.draft;
    if (!draft || pending.current) return;
    const request = noteInput(draft);
    if (!request) {
      setError(t('notecontroller.enterNoteTitleUpCharactersBodyUp'));
      return;
    }
    await send({ request, draft: structuredClone(draft) }, false);
  }
  async function changeStatus(action: 'trash' | 'restore') {
    const draft = current.current.notes?.[bot.id]?.draft;
    if (!draft?.base || pending.current || (action === 'trash' && noteDirty(draft))) return;
    await send(
      {
        request: {
          id: crypto.randomUUID(),
          note: draft.base.id,
          revision: draft.base.revision,
          action,
        },
        draft: structuredClone(draft),
      },
      false,
    );
  }
  function fresh() {
    if (history || pending.current) return;
    const previous = current.current.notes?.[bot.id]?.draft;
    setEditorVisible(true);
    if (noteDirty(previous)) {
      setError(t('notecontroller.saveDiscardCurrentEditsCreatingNote'));
      return;
    }
    reader.current++;
    setReading(false);
    setLatest(undefined);
    setError('');
    dispatch({ type: 'notes-draft', bot: bot.id, previous, draft: noteDraft(scope) });
  }
  async function open(id: string, review = false) {
    // One editor per Bot: keep its sealed draft until a definitive outcome, including a rejected CAS.
    if (!available || (pending.current && !review)) return;
    const previous = current.current.notes?.[bot.id]?.draft;
    setEditorVisible(true);
    if (!review && previous?.base?.id === id && noteDirty(previous)) return;
    if (!review && noteDirty(previous) && pending.current?.draft.key !== previous?.key) {
      setError(t('notecontroller.saveDiscardCurrentEditsOpeningAnotherNote'));
      return;
    }
    const token = ++reader.current;
    setReading(true);
    setError('');
    try {
      const value = await runtime.command({ type: 'notes.read', bot: scope, id });
      if (
        !mounted.current ||
        reader.current !== token ||
        !sameNoteDraft(current.current.notes?.[bot.id]?.draft, previous)
      )
        return;
      if (
        !isNoteItem(value) ||
        value.bot !== scope ||
        value.id !== id ||
        (previous?.base?.id === id && value.revision < previous.base.revision)
      )
        throw Error('INVALID_NOTE_ITEM');
      if (review && previous) setLatest({ key: previous.key, item: value });
      else dispatch({ type: 'notes-draft', bot: bot.id, previous, draft: noteDraft(scope, value) });
    } catch (error) {
      if (mounted.current && reader.current === token)
        setError(readError(error, t('notecontroller.noteDetails')));
    } finally {
      if (mounted.current && reader.current === token) setReading(false);
    }
  }
  function discard() {
    const previous = current.current.notes?.[bot.id]?.draft;
    if (!previous || pending.current?.draft.key === previous.key) return;
    reader.current++;
    setReading(false);
    setLatest(undefined);
    setError('');
    dispatch({
      type: 'notes-draft',
      bot: bot.id,
      previous,
      draft: previous.base ? noteDraft(scope, previous.base, previous.key) : noteDraft(scope),
    });
  }
  function merge(keep: boolean) {
    if (!latest) return;
    dispatch({ type: 'notes-merge', bot: bot.id, key: latest.key, latest: latest.item, keep });
    setLatest(undefined);
    setError('');
  }
  return {
    available,
    history,
    blocked,
    working,
    checking,
    loading,
    reading,
    error,
    listError,
    operationError,
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
    items: page.key === queryKey ? page.items : [],
    loaded: page.key === queryKey && page.loaded === true,
    next: page.key === queryKey ? page.next : undefined,
    retry: async () => {
      if (pending.current) await send(pending.current, true);
    },
  };
}
