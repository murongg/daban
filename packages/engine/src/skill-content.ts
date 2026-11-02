import { isSkillName } from '@daban/protocol';
import { parse } from 'yaml';
import { Fault } from './control.js';

const invalid = (): never => {
  throw new Fault('INVALID_SKILL', 400);
};
function extension(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return true;
  if (Array.isArray(value))
    return value.length <= 200 && value.every((item) => extension(item, depth + 1));
  return (
    !!value &&
    typeof value === 'object' &&
    Object.keys(value).length <= 200 &&
    Object.values(value).every((item) => extension(item, depth + 1))
  );
}
export function parseSkill(content: unknown, standard = false) {
  if (
    typeof content !== 'string' ||
    content.length > 100000 ||
    Buffer.byteLength(content) > 200000 ||
    content.includes('\0')
  )
    return invalid();
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return invalid();
  let data: Record<string, unknown>;
  try {
    const value: unknown = parse(match[1], { uniqueKeys: true, maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    data = value as Record<string, unknown>;
  } catch {
    return invalid();
  }
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const body = content.slice(match[0].length).trim();
  if (
    !isSkillName(name) ||
    !description ||
    description.length > 2000 ||
    (!body && !standard) ||
    ['disableModelInvocation', 'modelInvocable', 'userInvocable'].some((key) =>
      Object.hasOwn(data, key),
    )
  )
    return invalid();
  const flag = (key: string, fallback: boolean) => {
    if (!Object.hasOwn(data, key)) return fallback;
    const value = data[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') {
      if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true;
      if (['false', 'no', 'off'].includes(value.toLowerCase())) return false;
    }
    return invalid();
  };
  if (
    standard &&
    (name.length > 64 ||
      description.length > 1024 ||
      (data.license !== undefined && (typeof data.license !== 'string' || !data.license.trim())) ||
      (data.compatibility !== undefined &&
        (typeof data.compatibility !== 'string' ||
          !data.compatibility.trim() ||
          data.compatibility.length > 500)) ||
      (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') ||
      (data.metadata !== undefined &&
        (!data.metadata ||
          typeof data.metadata !== 'object' ||
          Array.isArray(data.metadata) ||
          !Object.entries(data.metadata).every(
            ([key, value]) =>
              typeof value === 'string' ||
              (['openclaw', 'clawdbot', 'clawdis'].includes(key) && extension(value)),
          ))))
  )
    return invalid();
  const metadata = Object.fromEntries(
    ['license', 'compatibility', 'metadata', 'allowed-tools']
      .filter((key) => Object.hasOwn(data, key))
      .map((key) => [key, data[key]]),
  );
  return {
    name,
    description,
    content,
    body,
    ...(Object.keys(metadata).length ? { metadata } : {}),
    invocation: {
      modelInvocable: !flag('disable-model-invocation', false),
      userInvocable: flag('user-invocable', true),
    },
  };
}
