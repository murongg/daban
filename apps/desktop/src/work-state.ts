import {
  isWorkItem,
  isWorkQuery,
  isWorkReceipt,
  isWorkWrite,
  validAgentId,
  type WorkAck,
  type WorkFields,
  type WorkItem,
  type WorkQuery,
  type WorkWrite,
  workKey,
  workStates,
} from '@daban/protocol';

export interface WorkDraft extends WorkFields {
  key: string;
  base?: WorkItem;
}
export interface WorkPending {
  request: WorkWrite;
  draft: WorkDraft;
}
export interface WorkState {
  mode: 'list' | 'board';
  filter: NonNullable<WorkQuery['filter']>;
  text: string;
  draft?: WorkDraft;
  pending?: WorkPending;
  damaged?: true;
}
export type WorkAction =
  | { type: 'work-options'; patch: Partial<Pick<WorkState, 'mode' | 'filter' | 'text'>> }
  | { type: 'work-draft'; previous?: WorkDraft; draft?: WorkDraft }
  | { type: 'work-change'; key: string; patch: Partial<WorkFields> }
  | { type: 'work-pending'; pending: WorkPending }
  | { type: 'work-release'; request: WorkWrite }
  | { type: 'work-settle'; receipt: WorkAck }
  | { type: 'work-merge'; key: string; latest: WorkItem; keep: boolean };
const fields = ['title', 'description', 'progress', 'status'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const humanKey = (request: WorkWrite) => workKey(request, { kind: 'human' });
export const sameWorkDraft = (left?: WorkDraft, right?: WorkDraft) =>
  JSON.stringify(left) === JSON.stringify(right);
export const workInitial = (): WorkState => ({ mode: 'list', filter: 'all', text: '' });
export function workDraft(base?: WorkItem, key: string = crypto.randomUUID()): WorkDraft {
  return {
    key,
    title: base?.title ?? '',
    description: base?.description ?? '',
    progress: base?.progress ?? '',
    status: base?.status ?? 'todo',
    ...(base ? { base: structuredClone(base) } : {}),
  };
}
export function workDirty(draft?: WorkDraft) {
  return (
    !!draft &&
    fields.some(
      (field) => draft[field] !== (draft.base?.[field] ?? (field === 'status' ? 'todo' : '')),
    )
  );
}
export function workInput(
  draft: WorkDraft,
  id: string = crypto.randomUUID(),
  entity: string = crypto.randomUUID(),
): WorkWrite | undefined {
  const value = Object.fromEntries(
    fields
      .filter((field) => !draft.base || draft[field] !== draft.base[field])
      .map((field) => [field, field === 'title' ? draft.title.trim() : draft[field]]),
  );
  const request = draft.base
    ? { id, item: draft.base.id, revision: draft.base.revision, action: 'update', value }
    : { id, item: entity, revision: 0, action: 'create', value };
  return !draft.base?.deleted && isWorkWrite(request) ? request : undefined;
}
export function mergeWork(draft: WorkDraft, latest: WorkItem): WorkDraft {
  if (draft.base?.id !== latest.id || latest.revision < draft.base.revision) return draft;
  const next = workDraft(latest, draft.key);
  for (const field of fields)
    if (draft[field] !== draft.base[field]) {
      if (field === 'status') next.status = draft.status;
      else next[field] = draft[field];
    }
  return next;
}
function isDraft(value: unknown): value is WorkDraft {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['key', 'base', ...fields].includes(key)) &&
    validAgentId(value.key) &&
    ['title', 'description', 'progress'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length <= (key === 'title' ? 2000 : 16000) &&
        !value[key].includes('\0'),
    ) &&
    workStates.includes(value.status as WorkFields['status']) &&
    (value.base === undefined || isWorkItem(value.base))
  );
}
function isPending(value: unknown): value is WorkPending {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['request', 'draft'].includes(key)) ||
    !isWorkWrite(value.request) ||
    !isDraft(value.draft)
  )
    return false;
  const { request, draft } = value;
  if (request.action === 'create' || request.action === 'update') {
    const generated = workInput(draft, request.id, request.item);
    return !!generated && humanKey(generated) === humanKey(request);
  }
  return (
    draft.base?.id === request.item &&
    draft.base.revision === request.revision &&
    draft.base.deleted === (request.action === 'restore')
  );
}
export function restoreWork(value: unknown): WorkState | undefined {
  if (value === undefined) return undefined;
  const next = workInitial();
  if (!object(value)) return { ...next, damaged: true };
  if (value.mode === 'list' || value.mode === 'board') next.mode = value.mode;
  else next.damaged = true;
  if (
    isWorkQuery({ filter: value.filter, text: value.text }) &&
    typeof value.filter === 'string' &&
    typeof value.text === 'string'
  ) {
    next.filter = value.filter as WorkState['filter'];
    next.text = value.text;
  } else next.damaged = true;
  if (value.draft !== undefined) {
    if (isDraft(value.draft)) next.draft = value.draft;
    else next.damaged = true;
  }
  if (value.pending !== undefined) {
    if (isPending(value.pending)) next.pending = value.pending;
    else next.damaged = true;
  }
  if (value.damaged === true) next.damaged = true;
  return next;
}
export function reduceWork(value: WorkState | undefined, action: WorkAction): WorkState {
  const current = value ?? workInitial();
  switch (action.type) {
    case 'work-options': {
      const next = { ...current, ...action.patch };
      return ['list', 'board'].includes(next.mode) &&
        isWorkQuery({ filter: next.filter, text: next.text })
        ? next
        : current;
    }
    case 'work-draft':
      if (
        current.draft?.base &&
        action.draft?.base &&
        current.draft.base.id === action.draft.base.id &&
        action.draft.base.revision < current.draft.base.revision
      )
        return current;
      return sameWorkDraft(current.draft, action.previous) &&
        (action.draft === undefined || isDraft(action.draft))
        ? { ...current, draft: action.draft }
        : current;
    case 'work-change': {
      if (
        current.draft?.key !== action.key ||
        current.pending?.draft.key === action.key ||
        Object.keys(action.patch).some((key) => !fields.includes(key as (typeof fields)[number]))
      )
        return current;
      const draft = { ...current.draft, ...action.patch };
      return isDraft(draft) ? { ...current, draft } : current;
    }
    case 'work-pending':
      return !current.pending &&
        isPending(action.pending) &&
        sameWorkDraft(current.draft, action.pending.draft)
        ? { ...current, pending: structuredClone(action.pending) }
        : current;
    case 'work-release':
      return current.pending && humanKey(current.pending.request) === humanKey(action.request)
        ? { ...current, pending: undefined }
        : current;
    case 'work-settle': {
      if (
        !current.pending ||
        !isWorkReceipt(action.receipt) ||
        action.receipt.actor.kind !== 'human' ||
        humanKey(current.pending.request) !== humanKey(action.receipt.request)
      )
        return current;
      const { request, draft } = current.pending;
      // Only the original untouched editor follows a late receipt; another draft stays owned by its new key.
      const edited = sameWorkDraft(current.draft, draft)
        ? request.action === 'restore' || request.action === 'trash'
          ? mergeWork(draft, action.receipt.item)
          : workDraft(action.receipt.item, draft.key)
        : current.draft;
      return { ...current, pending: undefined, draft: edited };
    }
    case 'work-merge':
      return current.draft?.key === action.key &&
        !current.pending &&
        isWorkItem(action.latest) &&
        current.draft.base?.id === action.latest.id &&
        current.draft.base.revision <= action.latest.revision
        ? {
            ...current,
            draft: action.keep
              ? mergeWork(current.draft, action.latest)
              : workDraft(action.latest, action.key),
          }
        : current;
  }
}
