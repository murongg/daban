import type { WorkCommentReceipt } from './comments.js';
import {
  isWorkQuery,
  isWorkWrite,
  legacyWorkStates,
  type WorkFields,
  type WorkItem,
  type WorkList,
  type WorkQuery,
  type WorkReceipt,
  type WorkState,
  type WorkWrite,
} from './work.js';

export function legacyWorkState(status: WorkState): (typeof legacyWorkStates)[number] {
  if (status === 'closed') return 'done';
  if (status === 'review' || status === 'blocked') return 'doing';
  return status;
}
function legacyFields<T extends Pick<WorkFields, 'status' | 'priority' | 'assignee'>>(item: T) {
  const { priority: _priority, assignee: _assignee, status, ...fields } = item;
  return { ...fields, status: legacyWorkState(status) };
}
export function legacyWorkItem(item: WorkItem) {
  return legacyFields(item);
}
export function legacyWorkList(list: WorkList) {
  return { ...list, page: { ...list.page, items: list.page.items.map(legacyFields) } };
}
export function legacyWorkReceipt<T extends WorkReceipt | WorkCommentReceipt>(receipt: T) {
  return receipt.state === 'complete'
    ? { ...receipt, item: legacyWorkItem(receipt.item) }
    : receipt;
}
export function isLegacyWorkWrite(input: unknown): input is WorkWrite {
  if (!isWorkWrite(input) || input.action === 'reopen') return false;
  return (
    !('value' in input) ||
    (Object.keys(input.value).every((key) =>
      ['title', 'description', 'progress', 'status'].includes(key),
    ) &&
      (input.value.status === undefined ||
        legacyWorkStates.includes(input.value.status as (typeof legacyWorkStates)[number])))
  );
}
export function isLegacyWorkQuery(input: unknown): input is WorkQuery {
  return (
    isWorkQuery(input) &&
    Object.keys(input).every((key) => ['filter', 'text', 'before', 'limit'].includes(key))
  );
}
