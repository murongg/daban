import { validAgentId } from '@daban/protocol';

export interface Mention {
  id: string;
  name: string;
  start: number;
  end: number;
}
export interface MentionMember {
  id: string;
  name: string;
}
const boundary = (char: string | undefined) => !char || /[\s\p{P}]/u.test(char);

export function readMentions(raw: unknown, text: string): Mention[] {
  if (!Array.isArray(raw)) return [];
  const values = raw
    .filter(
      (item): item is Mention =>
        !!item &&
        typeof item === 'object' &&
        'id' in item &&
        validAgentId(item.id) &&
        'name' in item &&
        typeof item.name === 'string' &&
        !!item.name &&
        'start' in item &&
        typeof item.start === 'number' &&
        Number.isSafeInteger(item.start) &&
        item.start >= 0 &&
        'end' in item &&
        typeof item.end === 'number' &&
        Number.isSafeInteger(item.end) &&
        item.end <= text.length &&
        item.end > item.start &&
        text.slice(item.start, item.end) === `@${item.name}` &&
        boundary(text[item.start - 1]) &&
        boundary(text[item.end]),
    )
    .sort((a, b) => a.start - b.start);
  return values.filter((item, index) => !index || item.start >= values[index - 1].end);
}

export function rebaseMentions(before: string, after: string, mentions: readonly Mention[]) {
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  return readMentions(
    mentions.flatMap((mention) => {
      if (mention.end <= start) return [mention];
      if (mention.start >= oldEnd)
        return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
      return [];
    }),
    after,
  );
}

export function mentionQuery(text: string, caret: number, mentions: readonly Mention[]) {
  if (caret <= 0 || caret > text.length) return;
  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0 || !boundary(text[start - 1]) || mentions.some((item) => item.start === start))
    return;
  const query = text.slice(start + 1, caret);
  if (query.includes('\n') || query.includes('@')) return;
  return { start, end: caret, query };
}

export function insertMention(
  text: string,
  range: { start: number; end: number },
  member: MentionMember,
  mentions: readonly Mention[],
) {
  const token = `@${member.name}`;
  const after = `${text.slice(0, range.start)}${token} ${text.slice(range.end)}`;
  if (after.length > 12000) return { text, mentions: [...mentions], caret: range.end };
  const added = { ...member, start: range.start, end: range.start + token.length };
  return {
    text: after,
    mentions: readMentions([...rebaseMentions(text, after, mentions), added], after),
    caret: added.end + 1,
  };
}

export function resolveMentions(
  text: string,
  members: readonly MentionMember[],
  stored: readonly Mention[],
) {
  // Selected tokens retain identity across renames; only unbound text resolves by current names.
  const mentions = readMentions(stored, text);
  const ambiguous = new Set<string>();
  const ordered = [...members].sort((a, b) => b.name.length - a.name.length);
  for (let start = text.indexOf('@'); start >= 0; start = text.indexOf('@', start + 1)) {
    if (
      !boundary(text[start - 1]) ||
      mentions.some((item) => start >= item.start && start < item.end)
    )
      continue;
    const match = ordered.find(
      (member) =>
        text.startsWith(`@${member.name}`, start) && boundary(text[start + member.name.length + 1]),
    );
    if (!match) continue;
    if (members.filter((member) => member.name === match.name).length > 1)
      ambiguous.add(match.name);
    else mentions.push({ ...match, start, end: start + match.name.length + 1 });
  }
  mentions.sort((a, b) => a.start - b.start);
  return {
    mentions,
    recipients: [...new Set(mentions.map((item) => item.id))],
    ambiguous: [...ambiguous],
  };
}
