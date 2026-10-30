import { validAgentId } from './id.js';

function workObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
export const workStates = ['todo', 'doing', 'done'] as const;
export type WorkState = (typeof workStates)[number];
export type WorkAuthor = { kind: 'human' } | { kind: 'bot'; bot: string };
export interface WorkFields {
  title: string;
  description: string;
  progress: string;
  status: WorkState;
}
export interface WorkItem extends WorkFields {
  id: string;
  revision: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  createdBy: WorkAuthor;
  updatedBy: WorkAuthor;
}
export type WorkSummary = Omit<WorkItem, 'description' | 'progress'> & {
  progress: string;
  progressTruncated: boolean;
};
export type WorkWrite = { id: string; item: string } & (
  | { revision: 0; action: 'create'; value: WorkFields }
  | { revision: number; action: 'update'; value: Partial<WorkFields> }
  | { revision: number; action: 'trash' | 'restore' }
);
export interface WorkQuery {
  filter?: 'open' | 'done' | 'trash' | 'all';
  text?: string;
  before?: number;
  limit?: number;
}
export interface WorkPage {
  items: WorkSummary[];
  revision: number;
  nextBefore?: number;
}
export interface WorkList {
  query: WorkQuery;
  page: WorkPage;
}
export type WorkStatus =
  | { available: true; revision: number; count: number; error?: never }
  | {
      available: false;
      error: 'WORK_CLOSED' | 'WORK_CORRUPT' | 'WORK_UNAVAILABLE' | 'INVALID_WORK_METADATA';
      revision?: never;
      count?: never;
    };
export interface WorkAck {
  state: 'complete';
  request: WorkWrite;
  actor: WorkAuthor;
  acceptedRevision: number;
  acceptedAt: string;
  item: WorkItem;
}
export type WorkReceipt = WorkAck | { state: 'unknown'; request: WorkWrite; actor: WorkAuthor };
const workFieldNames = ['title', 'description', 'progress', 'status'] as const;
export function workKey(request: WorkWrite, actor: WorkAuthor) {
  const value = 'value' in request ? request.value : undefined;
  return JSON.stringify([
    'daban.work.v1',
    request.id,
    request.item,
    request.revision,
    request.action,
    actor.kind,
    actor.kind === 'bot' ? actor.bot : null,
    ...workFieldNames.map((key) =>
      value && Object.hasOwn(value, key) ? [key, value[key]] : [key],
    ),
  ]);
}
export function isWorkAuthor(value: unknown): value is WorkAuthor {
  return (
    workObject(value) &&
    Object.hasOwn(value, 'kind') &&
    (value.kind === 'human'
      ? Object.keys(value).every((key) => key === 'kind')
      : value.kind === 'bot' &&
        Object.hasOwn(value, 'bot') &&
        validAgentId(value.bot) &&
        Object.keys(value).every((key) => ['kind', 'bot'].includes(key)))
  );
}
function workFields(value: unknown, partial = false) {
  if (
    !workObject(value) ||
    Object.keys(value).some(
      (key) => !workFieldNames.includes(key as (typeof workFieldNames)[number]),
    )
  )
    return false;
  if (
    partial ? !Object.keys(value).length : workFieldNames.some((key) => !Object.hasOwn(value, key))
  )
    return false;
  return workFieldNames.every(
    (key) =>
      !Object.hasOwn(value, key) ||
      (key === 'status'
        ? workStates.includes(value[key] as WorkState)
        : typeof value[key] === 'string' &&
          !value[key].includes('\0') &&
          value[key].length <= (key === 'title' ? 500 : 4000) &&
          (key !== 'title' || !!value[key].trim())),
  );
}
const workTime = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
export function isWorkWrite(value: unknown): value is WorkWrite {
  if (
    !workObject(value) ||
    !['id', 'item', 'revision', 'action'].every((key) => Object.hasOwn(value, key)) ||
    !validAgentId(value.id) ||
    !validAgentId(value.item) ||
    !Number.isSafeInteger(value.revision)
  )
    return false;
  if (value.action === 'create' || value.action === 'update')
    return (
      Object.keys(value).every((key) =>
        ['id', 'item', 'revision', 'action', 'value'].includes(key),
      ) &&
      (value.action === 'create'
        ? value.revision === 0 && workFields(value.value)
        : Number(value.revision) > 0 && workFields(value.value, true))
    );
  return (
    (value.action === 'trash' || value.action === 'restore') &&
    Number(value.revision) > 0 &&
    Object.keys(value).every((key) => ['id', 'item', 'revision', 'action'].includes(key))
  );
}
export function isWorkQuery(value: unknown): value is WorkQuery {
  return (
    workObject(value) &&
    Object.keys(value).every((key) => ['filter', 'text', 'before', 'limit'].includes(key)) &&
    (value.filter === undefined ||
      (typeof value.filter === 'string' &&
        ['open', 'done', 'trash', 'all'].includes(value.filter))) &&
    (value.text === undefined ||
      (typeof value.text === 'string' && value.text.length <= 200 && !value.text.includes('\0'))) &&
    (value.before === undefined ||
      (Number.isSafeInteger(value.before) && Number(value.before) > 0)) &&
    (value.limit === undefined ||
      (Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 50))
  );
}
export function isWorkItem(value: unknown): value is WorkItem {
  return (
    workObject(value) &&
    Object.keys(value).every((key) =>
      [
        'id',
        ...workFieldNames,
        'revision',
        'deleted',
        'createdAt',
        'updatedAt',
        'completedAt',
        'createdBy',
        'updatedBy',
      ].includes(key),
    ) &&
    validAgentId(value.id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.deleted === 'boolean' &&
    workFields({
      title: value.title,
      description: value.description,
      progress: value.progress,
      status: value.status,
    }) &&
    workTime(value.createdAt) &&
    workTime(value.updatedAt) &&
    isWorkAuthor(value.createdBy) &&
    isWorkAuthor(value.updatedBy) &&
    (value.status === 'done' ? workTime(value.completedAt) : value.completedAt === undefined)
  );
}
export function workQueryKey(query: WorkQuery) {
  return JSON.stringify([
    query.filter ?? 'all',
    query.text ?? '',
    query.before ?? null,
    query.limit ?? 50,
  ]);
}
export function isWorkStatus(value: unknown): value is WorkStatus {
  if (!workObject(value)) return false;
  if (value.available === false)
    return (
      Object.keys(value).every((key) => ['available', 'error'].includes(key)) &&
      typeof value.error === 'string' &&
      ['WORK_CLOSED', 'WORK_CORRUPT', 'WORK_UNAVAILABLE', 'INVALID_WORK_METADATA'].includes(
        value.error,
      )
    );
  return (
    value.available === true &&
    Object.keys(value).every((key) => ['available', 'revision', 'count'].includes(key)) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    Number(value.revision) <= 10000 &&
    Number.isSafeInteger(value.count) &&
    Number(value.count) >= 0 &&
    Number(value.count) <= 1000
  );
}
export function isWorkPage(value: unknown): value is WorkPage {
  if (
    !workObject(value) ||
    Object.keys(value).some((key) => !['items', 'revision', 'nextBefore'].includes(key)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > 50
  )
    return false;
  const ids = new Set<string>();
  for (const row of value.items) {
    if (
      !workObject(row) ||
      Object.hasOwn(row, 'description') ||
      typeof row.progressTruncated !== 'boolean'
    )
      return false;
    const { progressTruncated, ...item } = row;
    if (
      !isWorkItem({ ...item, description: '' }) ||
      typeof item.id !== 'string' ||
      typeof item.progress !== 'string' ||
      ids.has(item.id) ||
      Array.from(item.progress).length > 200 ||
      (progressTruncated && Array.from(item.progress).length !== 200) ||
      Number(item.revision) > Number(value.revision)
    )
      return false;
    ids.add(item.id);
  }
  return (
    value.nextBefore === undefined ||
    (value.items.length > 0 &&
      Number.isSafeInteger(value.nextBefore) &&
      Number(value.nextBefore) > 0)
  );
}
export function isWorkList(value: unknown): value is WorkList {
  if (
    !workObject(value) ||
    Object.keys(value).some((key) => !['query', 'page'].includes(key)) ||
    !isWorkQuery(value.query) ||
    !isWorkPage(value.page)
  )
    return false;
  const { query, page } = value;
  return (
    page.items.length <= (query.limit ?? 50) &&
    (page.nextBefore === undefined ||
      query.before === undefined ||
      page.nextBefore < query.before) &&
    page.items.every(
      (item) =>
        item.deleted === (query.filter === 'trash') &&
        (query.filter !== 'open' || item.status !== 'done') &&
        (query.filter !== 'done' || item.status === 'done'),
    )
  );
}
export function isWorkReceipt(value: unknown): value is WorkReceipt {
  if (!workObject(value) || !isWorkWrite(value.request) || !isWorkAuthor(value.actor)) return false;
  if (value.state === 'unknown')
    return Object.keys(value).every((key) => ['state', 'request', 'actor'].includes(key));
  return (
    value.state === 'complete' &&
    Object.keys(value).every((key) =>
      ['state', 'request', 'actor', 'acceptedRevision', 'acceptedAt', 'item'].includes(key),
    ) &&
    isWorkItem(value.item) &&
    value.item.id === value.request.item &&
    workTime(value.acceptedAt) &&
    Number.isSafeInteger(value.acceptedRevision) &&
    Number(value.acceptedRevision) >= 1 &&
    value.item.revision >= Number(value.acceptedRevision) &&
    (value.request.action === 'create'
      ? value.acceptedRevision === 1
      : [value.request.revision, value.request.revision + 1].includes(
          Number(value.acceptedRevision),
        ))
  );
}
