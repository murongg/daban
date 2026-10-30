import { validAgentId } from './id.js';

export const noteStates = ['open', 'parked', 'done'] as const;
export type NoteState = (typeof noteStates)[number];
export type NoteAuthor = { kind: 'human' } | { kind: 'bot'; bot: string };
export interface NoteFields {
  title: string;
  body: string;
  status: NoteState;
}
export interface NoteItem extends NoteFields {
  bot: string;
  id: string;
  revision: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  createdBy: NoteAuthor;
  updatedBy: NoteAuthor;
}
export interface NoteSummary extends NoteItem {
  bodyTruncated: boolean;
}
export type NoteWrite = { id: string; note: string } & (
  | { action: 'create'; revision: 0; value: NoteFields }
  | { action: 'update'; revision: number; value: Partial<NoteFields> }
  | { action: 'trash' | 'restore'; revision: number }
);
export interface NoteQuery {
  filter?: 'active' | 'all' | NoteState | 'trash';
  text?: string;
  before?: number;
  limit?: number;
}
export interface NotePage {
  bot: string;
  revision: number;
  items: NoteSummary[];
  nextBefore?: number;
}
export interface NoteAck {
  state: 'complete';
  bot: string;
  request: NoteWrite;
  actor: NoteAuthor;
  acceptedRevision: number;
  acceptedAt: string;
  item: NoteItem;
}
export type NoteReceipt =
  | NoteAck
  | { state: 'unknown'; bot: string; request: NoteWrite; actor: NoteAuthor };
type NoteFailure = {
  available: false;
  error: 'NOTES_CLOSED' | 'NOTES_CORRUPT' | 'NOTES_UNAVAILABLE' | 'INVALID_NOTE_METADATA';
};
export type NoteAvailability = { available: true } | NoteFailure;
export type NoteStatus = { available: true; revision: number; count: number } | NoteFailure;
export interface NoteStatusResult {
  bot: string;
  status: NoteStatus;
}
export interface NoteList {
  bot: string;
  query: NoteQuery;
  page: NotePage;
}
export type NoteCommand =
  | { type: 'notes.status'; bot: string }
  | { type: 'notes.list'; bot: string; query: NoteQuery }
  | { type: 'notes.read'; bot: string; id: string }
  | { type: 'notes.write' | 'notes.receipt'; bot: string; request: NoteWrite };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
) =>
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
const integer = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;
const time = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const fields = ['title', 'body', 'status'] as const;
function validFields(value: unknown, partial = false) {
  if (!object(value) || !keys(value, fields, partial ? [] : fields) || !Object.keys(value).length)
    return false;
  return fields.every(
    (key) =>
      !Object.hasOwn(value, key) ||
      (key === 'status'
        ? noteStates.includes(value.status as NoteState)
        : typeof value[key] === 'string' &&
          !value[key].includes('\0') &&
          value[key].length <= (key === 'title' ? 200 : 4000) &&
          (key !== 'title' || !!value[key].trim())),
  );
}
export function isNoteAuthor(value: unknown): value is NoteAuthor {
  return (
    object(value) &&
    (value.kind === 'human'
      ? keys(value, ['kind'])
      : value.kind === 'bot' && keys(value, ['kind', 'bot']) && validAgentId(value.bot))
  );
}
export function noteAuthorMatches(bot: string, actor: NoteAuthor) {
  return actor.kind === 'human' || actor.bot === bot;
}
export function isNoteWrite(value: unknown): value is NoteWrite {
  if (
    !object(value) ||
    !validAgentId(value.id) ||
    !validAgentId(value.note) ||
    !integer(value.revision)
  )
    return false;
  const common = ['id', 'note', 'revision', 'action'];
  if (value.action === 'create' || value.action === 'update')
    return (
      keys(value, [...common, 'value']) &&
      (value.action === 'create'
        ? value.revision === 0 && validFields(value.value)
        : value.revision > 0 && validFields(value.value, true))
    );
  return (
    (value.action === 'trash' || value.action === 'restore') &&
    value.revision > 0 &&
    keys(value, common)
  );
}
export function isNoteQuery(value: unknown): value is NoteQuery {
  return (
    object(value) &&
    keys(value, ['filter', 'text', 'before', 'limit'], []) &&
    (value.filter === undefined ||
      (typeof value.filter === 'string' &&
        ['active', 'all', ...noteStates, 'trash'].includes(value.filter))) &&
    (value.text === undefined ||
      (typeof value.text === 'string' && value.text.length <= 200 && !value.text.includes('\0'))) &&
    (value.before === undefined || integer(value.before, 1)) &&
    (value.limit === undefined || (integer(value.limit, 1) && value.limit <= 50))
  );
}
export function isNoteItem(value: unknown): value is NoteItem {
  if (
    !object(value) ||
    !keys(
      value,
      [
        'bot',
        'id',
        ...fields,
        'revision',
        'deleted',
        'createdAt',
        'updatedAt',
        'completedAt',
        'createdBy',
        'updatedBy',
      ],
      [
        'bot',
        'id',
        ...fields,
        'revision',
        'deleted',
        'createdAt',
        'updatedAt',
        'createdBy',
        'updatedBy',
      ],
    ) ||
    !validAgentId(value.bot) ||
    !validAgentId(value.id) ||
    !integer(value.revision, 1) ||
    typeof value.deleted !== 'boolean' ||
    !validFields({ title: value.title, body: value.body, status: value.status }) ||
    !time(value.createdAt) ||
    !time(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !isNoteAuthor(value.createdBy) ||
    !isNoteAuthor(value.updatedBy) ||
    !noteAuthorMatches(value.bot, value.createdBy) ||
    !noteAuthorMatches(value.bot, value.updatedBy)
  )
    return false;
  return value.status === 'done'
    ? time(value.completedAt) &&
        Date.parse(value.completedAt) >= Date.parse(value.createdAt) &&
        Date.parse(value.completedAt) <= Date.parse(value.updatedAt)
    : value.completedAt === undefined;
}
export function isNoteSummary(value: unknown): value is NoteSummary {
  if (!object(value) || typeof value.bodyTruncated !== 'boolean') return false;
  const { bodyTruncated: _truncated, ...item } = value;
  return isNoteItem(item) && Array.from(item.body).length <= 200;
}
export function isNotePage(value: unknown): value is NotePage {
  if (
    !object(value) ||
    !keys(value, ['bot', 'revision', 'items', 'nextBefore'], ['bot', 'revision', 'items']) ||
    !validAgentId(value.bot) ||
    !integer(value.revision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    (value.nextBefore !== undefined && (!integer(value.nextBefore, 1) || !value.items.length))
  )
    return false;
  const seen = new Set<string>();
  let revisions = 0;
  return value.items.every((item: unknown) => {
    if (!isNoteSummary(item) || item.bot !== value.bot || seen.has(item.id)) return false;
    seen.add(item.id);
    revisions += item.revision;
    return revisions <= Number(value.revision);
  });
}
export function isNoteReceipt(value: unknown): value is NoteReceipt {
  if (
    !object(value) ||
    !validAgentId(value.bot) ||
    !isNoteWrite(value.request) ||
    !isNoteAuthor(value.actor) ||
    !noteAuthorMatches(value.bot, value.actor)
  )
    return false;
  if (value.state === 'unknown') return keys(value, ['state', 'bot', 'request', 'actor']);
  return (
    value.state === 'complete' &&
    keys(value, ['state', 'bot', 'request', 'actor', 'acceptedRevision', 'acceptedAt', 'item']) &&
    isNoteItem(value.item) &&
    value.item.bot === value.bot &&
    value.item.id === value.request.note &&
    integer(value.acceptedRevision, 1) &&
    value.acceptedRevision <= value.item.revision &&
    time(value.acceptedAt) &&
    (value.request.action === 'create'
      ? value.acceptedRevision === 1
      : [value.request.revision, value.request.revision + 1].includes(value.acceptedRevision))
  );
}
export function noteKey(bot: string, request: NoteWrite, actor: NoteAuthor) {
  // Existing operation fingerprints depend on this field order across reader/writer upgrades.
  return JSON.stringify({
    bot,
    actor: actor.kind === 'human' ? { kind: 'human' } : { kind: 'bot', bot: actor.bot },
    request: {
      id: request.id,
      note: request.note,
      action: request.action,
      revision: request.revision,
      ...('value' in request
        ? {
            value: Object.fromEntries(
              fields
                .filter((key) => Object.hasOwn(request.value, key))
                .map((key) => [key, request.value[key]]),
            ),
          }
        : {}),
    },
  });
}

function failure(value: Record<string, unknown>): value is NoteFailure {
  return (
    value.available === false &&
    keys(value, ['available', 'error']) &&
    typeof value.error === 'string' &&
    ['NOTES_CLOSED', 'NOTES_CORRUPT', 'NOTES_UNAVAILABLE', 'INVALID_NOTE_METADATA'].includes(
      value.error,
    )
  );
}
export function isNoteAvailability(value: unknown): value is NoteAvailability {
  return object(value) && (value.available === true ? keys(value, ['available']) : failure(value));
}
export function isNoteStatus(value: unknown): value is NoteStatus {
  return (
    object(value) &&
    (value.available === true
      ? keys(value, ['available', 'revision', 'count']) &&
        integer(value.revision) &&
        integer(value.count) &&
        value.count <= value.revision &&
        (value.count > 0 || value.revision === 0)
      : failure(value))
  );
}
export function isNoteStatusResult(value: unknown): value is NoteStatusResult {
  return (
    object(value) &&
    keys(value, ['bot', 'status']) &&
    validAgentId(value.bot) &&
    isNoteStatus(value.status)
  );
}
export function noteQueryKey(query: NoteQuery) {
  return JSON.stringify([
    query.filter ?? 'active',
    query.text ?? '',
    query.before ?? null,
    query.limit ?? 50,
  ]);
}
export function isNoteList(value: unknown): value is NoteList {
  if (
    !object(value) ||
    !keys(value, ['bot', 'query', 'page']) ||
    !validAgentId(value.bot) ||
    !isNoteQuery(value.query) ||
    !isNotePage(value.page) ||
    value.page.bot !== value.bot ||
    value.page.items.length > (value.query.limit ?? 50) ||
    (value.page.nextBefore !== undefined &&
      value.query.before !== undefined &&
      value.page.nextBefore >= value.query.before)
  )
    return false;
  const filter = value.query.filter ?? 'active';
  return value.page.items.every((item) =>
    filter === 'trash'
      ? item.deleted
      : !item.deleted &&
        (filter === 'all' ||
          (filter === 'active' ? item.status !== 'done' : item.status === filter)),
  );
}
export function isNoteCommand(value: unknown): value is NoteCommand {
  if (!object(value) || !validAgentId(value.bot)) return false;
  if (value.type === 'notes.status') return keys(value, ['type', 'bot']);
  if (value.type === 'notes.list')
    return keys(value, ['type', 'bot', 'query']) && isNoteQuery(value.query);
  if (value.type === 'notes.read')
    return keys(value, ['type', 'bot', 'id']) && validAgentId(value.id);
  return (
    (value.type === 'notes.write' || value.type === 'notes.receipt') &&
    keys(value, ['type', 'bot', 'request']) &&
    isNoteWrite(value.request)
  );
}
