import {
  isNoteItem,
  isNoteQuery,
  isNoteReceipt,
  isNoteWrite,
  type NoteAck,
  type NoteFields,
  type NoteItem,
  type NoteQuery,
  type NoteWrite,
  noteKey,
  noteStates,
  validAgentId,
} from '@daban/protocol';

export interface NoteDraft extends NoteFields {
  bot: string;
  key: string;
  base?: NoteItem;
}
export interface NotePending {
  request: NoteWrite;
  draft: NoteDraft;
}
export interface NotesState {
  filter: NonNullable<NoteQuery['filter']>;
  text: string;
  draft?: NoteDraft;
  pending?: NotePending;
  damaged?: true;
}
export type NotesAction = { bot: string } & (
  | { type: 'notes-options'; patch: Partial<Pick<NotesState, 'filter' | 'text'>> }
  | { type: 'notes-draft'; previous?: NoteDraft; draft?: NoteDraft }
  | { type: 'notes-change'; key: string; patch: Partial<NoteFields> }
  | { type: 'notes-pending'; pending: NotePending }
  | { type: 'notes-release'; request: NoteWrite }
  | { type: 'notes-settle'; receipt: NoteAck }
  | { type: 'notes-merge'; key: string; latest: NoteItem; keep: boolean }
);
const fields = ['title', 'body', 'status'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const humanKey = (bot: string, request: NoteWrite) => noteKey(bot, request, { kind: 'human' });
export const sameNoteDraft = (left?: NoteDraft, right?: NoteDraft) =>
  JSON.stringify(left) === JSON.stringify(right);
export const noteInitial = (): NotesState => ({ filter: 'active', text: '' });
export function noteDraft(
  bot: string,
  base?: NoteItem,
  key: string = crypto.randomUUID(),
): NoteDraft {
  return {
    bot,
    key,
    title: base?.title ?? '',
    body: base?.body ?? '',
    status: base?.status ?? 'open',
    ...(base ? { base: structuredClone(base) } : {}),
  };
}
export function noteDirty(draft?: NoteDraft) {
  return (
    !!draft &&
    fields.some(
      (field) => draft[field] !== (draft.base?.[field] ?? (field === 'status' ? 'open' : '')),
    )
  );
}
export function noteInput(
  draft: NoteDraft,
  id: string = crypto.randomUUID(),
  entity: string = crypto.randomUUID(),
): NoteWrite | undefined {
  const value = Object.fromEntries(
    fields
      .filter((field) => !draft.base || draft[field] !== draft.base[field])
      .map((field) => [field, field === 'title' ? draft.title.trim() : draft[field]]),
  );
  const request = draft.base
    ? { id, note: draft.base.id, revision: draft.base.revision, action: 'update', value }
    : { id, note: entity, revision: 0, action: 'create', value };
  return validAgentId(draft.bot) &&
    (!draft.base || draft.base.bot === draft.bot) &&
    !draft.base?.deleted &&
    isNoteWrite(request)
    ? request
    : undefined;
}
export function mergeNote(draft: NoteDraft, latest: NoteItem): NoteDraft {
  if (
    draft.base?.id !== latest.id ||
    draft.base.bot !== latest.bot ||
    draft.bot !== latest.bot ||
    latest.revision < draft.base.revision
  )
    return draft;
  const next = noteDraft(draft.bot, latest, draft.key);
  for (const field of fields)
    if (draft[field] !== draft.base[field]) {
      if (field === 'status') next.status = draft.status;
      else next[field] = draft[field];
    }
  return next;
}
function isDraft(value: unknown, bot: string): value is NoteDraft {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['bot', 'key', 'base', ...fields].includes(key)) &&
    value.bot === bot &&
    validAgentId(value.key) &&
    ['title', 'body'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length <= (key === 'title' ? 2000 : 16000) &&
        !value[key].includes('\0'),
    ) &&
    noteStates.includes(value.status as NoteFields['status']) &&
    (value.base === undefined || (isNoteItem(value.base) && value.base.bot === bot))
  );
}
function isPending(value: unknown, bot: string): value is NotePending {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['request', 'draft'].includes(key)) ||
    !isNoteWrite(value.request) ||
    !isDraft(value.draft, bot)
  )
    return false;
  const { request, draft } = value;
  if (request.action === 'create' || request.action === 'update') {
    const generated = noteInput(draft, request.id, request.note);
    return !!generated && humanKey(bot, generated) === humanKey(bot, request);
  }
  return (
    draft.base?.id === request.note &&
    draft.base.revision === request.revision &&
    draft.base.deleted === (request.action === 'restore')
  );
}
export function restoreNotes(value: unknown, bot: string): NotesState | undefined {
  if (value === undefined) return undefined;
  const next = noteInitial();
  if (!object(value) || !validAgentId(bot)) return { ...next, damaged: true };
  if (
    typeof value.filter === 'string' &&
    typeof value.text === 'string' &&
    isNoteQuery({ filter: value.filter, text: value.text })
  ) {
    next.filter = value.filter as NotesState['filter'];
    next.text = value.text;
  } else next.damaged = true;
  if (value.draft !== undefined) {
    if (isDraft(value.draft, bot)) next.draft = value.draft;
    else next.damaged = true;
  }
  if (value.pending !== undefined) {
    if (isPending(value.pending, bot)) next.pending = value.pending;
    else next.damaged = true;
  }
  if (value.damaged === true) next.damaged = true;
  return next;
}
export function reduceNotes(
  value: NotesState | undefined,
  bot: string,
  action: NotesAction,
): NotesState {
  const current = value ?? noteInitial();
  switch (action.type) {
    case 'notes-options': {
      const next = { ...current, ...action.patch };
      return isNoteQuery({ filter: next.filter, text: next.text }) ? next : current;
    }
    case 'notes-draft':
      if (
        current.draft?.base &&
        action.draft?.base &&
        current.draft.base.id === action.draft.base.id &&
        action.draft.base.revision < current.draft.base.revision
      )
        return current;
      return sameNoteDraft(current.draft, action.previous) &&
        (action.draft === undefined || isDraft(action.draft, bot))
        ? { ...current, draft: action.draft }
        : current;
    case 'notes-change': {
      if (
        current.draft?.key !== action.key ||
        current.pending?.draft.key === action.key ||
        Object.keys(action.patch).some((key) => !fields.includes(key as (typeof fields)[number]))
      )
        return current;
      const draft = { ...current.draft, ...action.patch };
      return isDraft(draft, bot) ? { ...current, draft } : current;
    }
    case 'notes-pending':
      return !current.pending &&
        isPending(action.pending, bot) &&
        sameNoteDraft(current.draft, action.pending.draft)
        ? { ...current, pending: structuredClone(action.pending) }
        : current;
    case 'notes-release':
      return current.pending &&
        humanKey(bot, current.pending.request) === humanKey(bot, action.request)
        ? { ...current, pending: undefined }
        : current;
    case 'notes-settle': {
      // An unknown receipt must keep the durable ID: the original operation may still be accepted later.
      if (
        !current.pending ||
        !isNoteReceipt(action.receipt) ||
        action.receipt.state !== 'complete' ||
        action.receipt.bot !== bot ||
        action.receipt.actor.kind !== 'human' ||
        humanKey(bot, current.pending.request) !== humanKey(bot, action.receipt.request)
      )
        return current;
      const { request, draft } = current.pending;
      // Late receipts belong to the captured Bot/editor; opening a new draft never transfers that ownership.
      const edited = sameNoteDraft(current.draft, draft)
        ? request.action === 'restore' || request.action === 'trash'
          ? mergeNote(draft, action.receipt.item)
          : noteDraft(bot, action.receipt.item, draft.key)
        : current.draft;
      return { ...current, pending: undefined, draft: edited };
    }
    case 'notes-merge':
      return current.draft?.key === action.key &&
        !current.pending &&
        isNoteItem(action.latest) &&
        action.latest.bot === bot &&
        current.draft.base?.id === action.latest.id &&
        current.draft.base.revision <= action.latest.revision
        ? {
            ...current,
            draft: action.keep
              ? mergeNote(current.draft, action.latest)
              : noteDraft(bot, action.latest, action.key),
          }
        : current;
  }
}
