import { validAgentId } from './id.js';
import { isWorkAuthor, isWorkItem, type WorkAuthor, type WorkItem } from './work.js';

export interface WorkCommentWrite {
  id: string;
  item: string;
  revision: number;
  body: string;
}
export interface WorkComment {
  id: string;
  item: string;
  body: string;
  createdAt: string;
  createdBy: WorkAuthor;
}
export interface WorkCommentQuery {
  item: string;
  before?: number;
  limit?: number;
}
export interface WorkCommentPage {
  item: string;
  revision: number;
  comments: WorkComment[];
  nextBefore?: number;
}
export interface WorkCommentList {
  query: WorkCommentQuery;
  page: WorkCommentPage;
}
export type WorkCommentCommand =
  | { type: 'work.comments'; query: WorkCommentQuery }
  | { type: 'work.comment' | 'work.comment-receipt'; request: WorkCommentWrite };
export interface WorkCommentAck {
  state: 'complete';
  request: WorkCommentWrite;
  actor: WorkAuthor;
  acceptedRevision: number;
  acceptedAt: string;
  item: WorkItem;
  comment: WorkComment;
}
export type WorkCommentReceipt =
  | WorkCommentAck
  | {
      state: 'unknown';
      request: WorkCommentWrite;
      actor: WorkAuthor;
    };
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
const integer = (value: unknown, min = 1) => Number.isSafeInteger(value) && Number(value) >= min;
const body = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 10000 && !!value.trim() && !value.includes('\0');
const time = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const sameAuthor = (left: WorkAuthor, right: WorkAuthor) =>
  left.kind === right.kind &&
  (left.kind === 'human' || (right.kind === 'bot' && left.bot === right.bot));

export function workCommentKey(request: WorkCommentWrite, actor: WorkAuthor) {
  return JSON.stringify([
    'daban.work.comment.v1',
    request.id,
    request.item,
    request.revision,
    request.body,
    actor.kind,
    actor.kind === 'bot' ? actor.bot : null,
  ]);
}
export function isWorkCommentWrite(value: unknown): value is WorkCommentWrite {
  return (
    object(value) &&
    keys(value, ['id', 'item', 'revision', 'body']) &&
    validAgentId(value.id) &&
    validAgentId(value.item) &&
    integer(value.revision) &&
    body(value.body)
  );
}
export function isWorkComment(value: unknown): value is WorkComment {
  return (
    object(value) &&
    keys(value, ['id', 'item', 'body', 'createdAt', 'createdBy']) &&
    validAgentId(value.id) &&
    validAgentId(value.item) &&
    body(value.body) &&
    time(value.createdAt) &&
    isWorkAuthor(value.createdBy)
  );
}
export function isWorkCommentQuery(value: unknown): value is WorkCommentQuery {
  return (
    object(value) &&
    keys(value, ['item', 'before', 'limit'], ['item']) &&
    validAgentId(value.item) &&
    (value.before === undefined || integer(value.before)) &&
    (value.limit === undefined || (integer(value.limit) && Number(value.limit) <= 50))
  );
}
export function isWorkCommentPage(value: unknown): value is WorkCommentPage {
  if (
    !object(value) ||
    !keys(
      value,
      ['item', 'revision', 'comments', 'nextBefore'],
      ['item', 'revision', 'comments'],
    ) ||
    !validAgentId(value.item) ||
    !integer(value.revision) ||
    !Array.isArray(value.comments) ||
    value.comments.length > 50 ||
    value.comments.length >= Number(value.revision) ||
    (value.nextBefore !== undefined && (!integer(value.nextBefore) || !value.comments.length))
  )
    return false;
  const seen = new Set<string>();
  for (const row of value.comments) {
    if (!isWorkComment(row) || row.item !== value.item || seen.has(row.id)) return false;
    seen.add(row.id);
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024;
}
export function workCommentQueryKey(query: WorkCommentQuery) {
  return JSON.stringify([query.item, query.before ?? null, query.limit ?? 50]);
}
export function isWorkCommentList(value: unknown): value is WorkCommentList {
  return (
    object(value) &&
    keys(value, ['query', 'page']) &&
    isWorkCommentQuery(value.query) &&
    isWorkCommentPage(value.page) &&
    value.page.item === value.query.item &&
    value.page.comments.length <= (value.query.limit ?? 50) &&
    (value.page.nextBefore === undefined ||
      value.query.before === undefined ||
      value.page.nextBefore < value.query.before)
  );
}
export function isWorkCommentCommand(value: unknown): value is WorkCommentCommand {
  if (!object(value)) return false;
  if (value.type === 'work.comments')
    return keys(value, ['type', 'query']) && isWorkCommentQuery(value.query);
  return (
    (value.type === 'work.comment' || value.type === 'work.comment-receipt') &&
    keys(value, ['type', 'request']) &&
    isWorkCommentWrite(value.request)
  );
}
export function isWorkCommentReceipt(value: unknown): value is WorkCommentReceipt {
  if (!object(value) || !isWorkCommentWrite(value.request) || !isWorkAuthor(value.actor))
    return false;
  if (value.state === 'unknown') return keys(value, ['state', 'request', 'actor']);
  return (
    value.state === 'complete' &&
    keys(value, [
      'state',
      'request',
      'actor',
      'acceptedRevision',
      'acceptedAt',
      'item',
      'comment',
    ]) &&
    isWorkItem(value.item) &&
    value.item.id === value.request.item &&
    isWorkComment(value.comment) &&
    value.comment.id === value.request.id &&
    value.comment.item === value.request.item &&
    value.comment.body === value.request.body &&
    sameAuthor(value.comment.createdBy, value.actor) &&
    integer(value.acceptedRevision) &&
    value.acceptedRevision === value.request.revision + 1 &&
    value.item.revision >= Number(value.acceptedRevision) &&
    time(value.acceptedAt) &&
    value.comment.createdAt === value.acceptedAt &&
    Date.parse(value.acceptedAt) >= Date.parse(value.item.createdAt) &&
    Date.parse(value.acceptedAt) <= Date.parse(value.item.updatedAt)
  );
}
