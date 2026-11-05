import {
  type DeliveryAttempt,
  type DeliveryChecklist,
  type DeliveryCommand,
  type DeliveryCriterion,
  type DeliveryPage,
  type DeliveryWrite,
  deliveryAction,
  deliveryKey,
  isDeliveryChecklist,
  isDeliveryCommand,
  isDeliveryPage,
  isDeliveryReceipt,
  isWorkItem,
  recoveryBlocked,
  validAgentId,
  type WorkItem,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ClientCache, clientCache } from '../../app/cache';
import { runtimeError, useRuntime } from '../../app/Runtime';

type Mutation = Extract<DeliveryCommand, { request: DeliveryWrite }>;
interface Draft {
  checklist: DeliveryChecklist;
  pending?: Mutation;
}
const storageKey = (workId: string) => `daban.delivery.v1.${workId}`;
function draftCriterion(value: unknown): value is DeliveryCriterion {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    'id' in value &&
    validAgentId(value.id) &&
    'text' in value &&
    typeof value.text === 'string' &&
    value.text.length <= 600 &&
    !value.text.includes('\0') &&
    'kind' in value &&
    (value.kind === 'text' || value.kind === 'file') &&
    'required' in value &&
    typeof value.required === 'boolean'
  );
}
function draftChecklist(value: unknown): value is DeliveryChecklist {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('items' in value) ||
    !Array.isArray(value.items)
  )
    return false;
  // Incomplete editor text must survive reopening; only the wire/save path requires valid acceptance text.
  if (
    !isDeliveryChecklist({ ...value, items: [] }) ||
    value.items.length > 20 ||
    !value.items.every(draftCriterion)
  )
    return false;
  return new Set(value.items.map((item) => item.id)).size === value.items.length;
}
function restore(workId: string, cache: ClientCache): Draft | undefined {
  try {
    const raw = cache.getItem(storageKey(workId));
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('checklist' in value) ||
      !draftChecklist(value.checklist) ||
      value.checklist.workId !== workId
    )
      return undefined;
    const pending = 'pending' in value ? value.pending : undefined;
    if (
      pending !== undefined &&
      (!isDeliveryCommand(pending) || !('request' in pending) || pending.request.workId !== workId)
    )
      return undefined;
    return {
      checklist: value.checklist,
      ...(pending && isDeliveryCommand(pending) && 'request' in pending ? { pending } : {}),
    };
  } catch {
    return undefined;
  }
}
const definite = new Set([
  'DELIVERY_CONFLICT',
  'DELIVERY_REQUEST_CONFLICT',
  'DELIVERY_ACTIVE',
  'DELIVERY_COMPLETED_WORK',
  'DELIVERY_NOT_READY',
  'DELIVERY_NOT_RUNNING',
  'DELIVERY_NOT_FOUND',
  'DELIVERY_UNCHECKED',
  'DELIVERY_FILE_UNAVAILABLE',
  'DELIVERY_FILE_CHANGED',
  'DELIVERY_OUTPUT_OWNER',
  'DELIVERY_CRITERION',
  'DELIVERY_QUERY_REQUIRED',
  'DELIVERY_DECIDED',
  'INVALID_DELIVERY_REQUEST',
  'WORK_REOPEN_REQUIRED',
  'WORK_TRASHED',
  'WORK_NOT_FOUND',
  'BOT_ARCHIVED',
  'UNKNOWN_BOT',
  'RUNTIME_TOO_OLD',
  'RUNTIME_RECOVERY_PENDING',
  'INVALID_COMMAND',
]);
export function useDelivery(item: WorkItem, observe: (item: WorkItem) => unknown) {
  const runtime = useRuntime(),
    cache = clientCache();
  const [draft, setDraft] = useState<Draft>(
    () => restore(item.id, cache) ?? { checklist: { workId: item.id, revision: 0, items: [] } },
  );
  const [page, setPage] = useState<DeliveryPage>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const saved = useRef(draft),
    generation = useRef(0),
    loading = useRef(0),
    observeRef = useRef(observe);
  saved.current = draft;
  observeRef.current = observe;
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.delivery === true;
  const blocked = recoveryBlocked(runtime.snapshot);
  const persist = useCallback(
    (value: Draft) => {
      // Seal the exact request locally before sending it; losing a reply must never generate a new intent.
      cache.setItem(storageKey(item.id), JSON.stringify(value));
      saved.current = value;
      setDraft(value);
    },
    [item.id, cache],
  );
  const load = useCallback(
    async (append = false) => {
      if (!available) return;
      const owner = generation.current,
        token = ++loading.current;
      const before = append ? page?.nextBefore : undefined;
      const query = { workId: item.id, ...(before ? { before } : {}) };
      try {
        const value = await runtime.command({ type: 'delivery.get', query });
        if (owner !== generation.current || token !== loading.current) return;
        if (!isDeliveryPage(value) || value.workId !== item.id)
          throw new Error('INVALID_DELIVERY_PAGE');
        setPage((old) =>
          append && old ? { ...value, attempts: [...old.attempts, ...value.attempts] } : value,
        );
        const current = saved.current;
        if (
          !current.pending &&
          (JSON.stringify(current.checklist.items) ===
            JSON.stringify(page?.checklist.items ?? []) ||
            !restore(item.id, cache))
        )
          persist({ checklist: value.checklist });
        const work = await runtime.command({ type: 'work.read', id: item.id });
        if (
          owner === generation.current &&
          token === loading.current &&
          isWorkItem(work) &&
          work.id === item.id
        )
          observeRef.current(work);
      } catch (cause) {
        if (owner === generation.current) setError(runtimeError(cause));
      }
    },
    [available, cache, item.id, page?.nextBefore, page?.checklist.items, runtime.command, persist],
  );
  const loader = useRef(load);
  loader.current = load;
  const connection = useRef({ command: runtime.command, cache });
  useEffect(() => {
    if (connection.current.command !== runtime.command || connection.current.cache !== cache) {
      const next = restore(item.id, cache) ?? {
        checklist: { workId: item.id, revision: 0, items: [] },
      };
      saved.current = next;
      setDraft(next);
      setPage(undefined);
      connection.current = { command: runtime.command, cache };
    }
    generation.current++;
    if (available) loader.current().catch((cause: unknown) => setError(runtimeError(cause)));
    return () => {
      generation.current++;
      loading.current++;
    };
  }, [available, runtime.command, cache, item.id]);
  const running =
    page?.attempts.some((attempt) => ['accepted', 'running'].includes(attempt.phase)) ?? false;
  useEffect(() => {
    if (!available || !running) return;
    const timer = setInterval(
      () => loader.current().catch((cause: unknown) => setError(runtimeError(cause))),
      2000,
    );
    return () => clearInterval(timer);
  }, [available, running]);
  const acknowledge = useCallback(
    async (command: Mutation, value: unknown, owner: number) => {
      if (
        !isDeliveryReceipt(value) ||
        deliveryKey(deliveryAction(command.type.slice(9)), value.request) !==
          deliveryKey(deliveryAction(command.type.slice(9)), command.request)
      )
        throw new Error('INVALID_DELIVERY_RECEIPT');
      if (owner !== generation.current) return;
      if (value.state === 'unknown') {
        setError('DELIVERY_RECEIPT_UNKNOWN');
        return;
      }
      persist({ checklist: 'checklist' in value ? value.checklist : saved.current.checklist });
      setError('');
      await loader.current();
    },
    [persist],
  );
  const send = useCallback(
    async (command: Mutation) => {
      if (busy || saved.current.pending || blocked || !available) return;
      const owner = generation.current;
      setBusy(true);
      setError('');
      try {
        persist({ ...saved.current, pending: structuredClone(command) });
        const value = await runtime.command(command);
        if (!isDeliveryReceipt(value) || value.state !== 'complete')
          throw new Error('INVALID_DELIVERY_RECEIPT');
        await acknowledge(command, value, owner);
      } catch (cause) {
        if (owner === generation.current) {
          const message = runtimeError(cause);
          setError(message);
          if (cause instanceof Error && definite.has(cause.message)) {
            persist({ checklist: saved.current.checklist });
            await loader.current();
          }
        }
      } finally {
        if (owner === generation.current) setBusy(false);
      }
    },
    [busy, blocked, available, runtime.command, persist, acknowledge],
  );
  const check = useCallback(async () => {
    const pending = saved.current.pending;
    if (!pending || busy || !available) return;
    const owner = generation.current;
    const type = (
      {
        'delivery.start': 'delivery.receipt',
        'delivery.checklist.write': 'delivery.checklist.receipt',
        'delivery.file.bind': 'delivery.file.bind-receipt',
        'delivery.decide': 'delivery.decision-receipt',
        'delivery.stop': 'delivery.stop-receipt',
      } as Record<string, string>
    )[pending.type];
    const command: unknown = { type, request: pending.request };
    if (!isDeliveryCommand(command)) return;
    setBusy(true);
    try {
      await acknowledge(pending, await runtime.command(command), owner);
    } catch (cause) {
      if (owner === generation.current) setError(runtimeError(cause));
    } finally {
      if (owner === generation.current) setBusy(false);
    }
  }, [available, busy, runtime.command, acknowledge]);
  const edit = (items: DeliveryCriterion[]) =>
    persist({ ...saved.current, checklist: { ...saved.current.checklist, items } });
  const target = (attempt: DeliveryAttempt) => ({
    requestId: crypto.randomUUID(),
    workId: item.id,
    workRevision: item.revision,
    attemptId: attempt.attemptId,
    attemptRevision: attempt.revision,
  });
  const dirty =
    !page ||
    draft.checklist.revision !== page.checklist.revision ||
    JSON.stringify(draft.checklist.items) !== JSON.stringify(page.checklist.items);
  return {
    available,
    blocked,
    draft,
    page,
    busy,
    error,
    dirty,
    edit,
    send,
    check,
    load,
    reset: () => {
      if (page) persist({ checklist: page.checklist });
    },
    target,
    save: () =>
      send({
        type: 'delivery.checklist.write',
        request: {
          requestId: crypto.randomUUID(),
          workId: item.id,
          workRevision: item.revision,
          checklistRevision: draft.checklist.revision,
          items: draft.checklist.items,
        },
      }),
  };
}
