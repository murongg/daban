import {
  isWorkCommentReceipt,
  isWorkCommentWrite,
  validAgentId,
  type WorkCommentAck,
  type WorkCommentWrite,
  workCommentKey,
} from '@daban/protocol';

export interface CommentDraft {
  key: string;
  body: string;
}
export interface CommentPending {
  request: WorkCommentWrite;
  draft: CommentDraft;
}
export interface CommentCard {
  draft?: CommentDraft;
  pending?: CommentPending;
}
export interface CommentsState {
  cards: Record<string, CommentCard>;
  damaged?: true;
}
export type CommentAction =
  | { type: 'comment-draft'; item: string; draft: CommentDraft }
  | { type: 'comment-pending'; pending: CommentPending }
  | { type: 'comment-release'; request: WorkCommentWrite }
  | { type: 'comment-settle'; receipt: WorkCommentAck };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const draftBody = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40000;
const isDraft = (value: unknown): value is CommentDraft =>
  object(value) &&
  closed(value, ['key', 'body']) &&
  validAgentId(value.key) &&
  draftBody(value.body);
const sameDraft = (left?: CommentDraft, right?: CommentDraft) =>
  left?.key === right?.key && left?.body === right?.body;
export const commentKey = (request: WorkCommentWrite) => workCommentKey(request, { kind: 'human' });
function isPending(item: string, value: unknown): value is CommentPending {
  return (
    object(value) &&
    closed(value, ['request', 'draft']) &&
    isWorkCommentWrite(value.request) &&
    value.request.item === item &&
    isDraft(value.draft) &&
    value.request.body === value.draft.body
  );
}
export function commentCard(value: CommentsState | undefined, item: string): CommentCard {
  return value && Object.hasOwn(value.cards, item) ? value.cards[item] : {};
}
export function restoreComments(value: unknown): CommentsState | undefined {
  if (value === undefined) return undefined;
  const next: CommentsState = { cards: {} };
  if (!object(value) || !object(value.cards)) return { ...next, damaged: true };
  if (!closed(value, ['cards', 'damaged']) || value.damaged === true) next.damaged = true;
  const cards: [string, CommentCard][] = [];
  for (const [item, raw] of Object.entries(value.cards)) {
    if (cards.length >= 1000 || !validAgentId(item) || !object(raw)) {
      next.damaged = true;
      continue;
    }
    const card: CommentCard = {};
    if (!closed(raw, ['draft', 'pending'])) next.damaged = true;
    if (raw.draft !== undefined) {
      if (isDraft(raw.draft)) card.draft = structuredClone(raw.draft);
      else {
        next.damaged = true;
        if (object(raw.draft) && draftBody(raw.draft.body))
          card.draft = { key: 'restored', body: raw.draft.body };
      }
    }
    if (raw.pending !== undefined) {
      if (isPending(item, raw.pending)) {
        // The pending snapshot is its own authority; a damaged or later local draft cannot erase an uncertain effect.
        card.pending = structuredClone(raw.pending);
        if (!card.draft || (!isDraft(raw.draft) && card.draft.body === raw.pending.draft.body)) {
          card.draft = structuredClone(raw.pending.draft);
          next.damaged = true;
        } else if (!sameDraft(card.draft, raw.pending.draft)) next.damaged = true;
      } else next.damaged = true;
    }
    cards.push([item, card]);
  }
  next.cards = Object.fromEntries(cards);
  return next;
}
export function reduceComments(
  value: CommentsState | undefined,
  action: CommentAction,
): CommentsState {
  const current = value ?? { cards: {} };
  const item =
    action.type === 'comment-draft'
      ? action.item
      : action.type === 'comment-pending'
        ? action.pending.request.item
        : action.type === 'comment-release'
          ? action.request.item
          : action.receipt.request.item;
  if (!validAgentId(item)) return current;
  const old = commentCard(current, item);
  let card = old;
  if (action.type === 'comment-draft') {
    if (
      old.pending ||
      !isDraft(action.draft) ||
      (!Object.hasOwn(current.cards, item) && Object.keys(current.cards).length >= 1000)
    )
      return current;
    card = action.draft.body ? { draft: structuredClone(action.draft) } : {};
  } else if (action.type === 'comment-pending') {
    if (
      old.pending ||
      !isPending(item, action.pending) ||
      !sameDraft(old.draft, action.pending.draft)
    )
      return current;
    card = { ...old, pending: structuredClone(action.pending) };
  } else {
    const request = action.type === 'comment-release' ? action.request : action.receipt.request;
    if (
      !old.pending ||
      !isWorkCommentWrite(request) ||
      commentKey(request) !== commentKey(old.pending.request)
    )
      return current;
    if (action.type === 'comment-settle') {
      if (
        !isWorkCommentReceipt(action.receipt) ||
        action.receipt.state !== 'complete' ||
        action.receipt.actor.kind !== 'human'
      )
        return current;
      // A confirmed effect clears only its sealed draft, never another card or a later composition.
      card = sameDraft(old.draft, old.pending.draft) ? {} : { draft: old.draft };
    } else card = { draft: old.draft };
  }
  const cards = { ...current.cards, [item]: card };
  if (!card.draft && !card.pending) delete cards[item];
  return { ...current, cards };
}
