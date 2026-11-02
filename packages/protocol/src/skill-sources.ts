import { isSkillSelection, type SkillSelection } from './skills.js';
export type SkillPlatform = 'skills.sh' | 'skillsmp' | 'clawhub';
export type SkillSource =
  | { platform: 'github'; url: string; skill?: string }
  | { platform: 'clawhub'; slug: string; owner: string };
export interface SkillSearchItem {
  id: string;
  name: string;
  description: string;
  url: string;
  source?: SkillSource;
  usage?: { kind: 'installs' | 'downloads' | 'stars'; count: number };
}
export interface SkillSearchResult {
  platform: SkillPlatform;
  query: string;
  items: SkillSearchItem[];
}
export interface SkillOrigin {
  label: string;
  url: string;
  revision: string;
}
export type SkillRemoteResult =
  | {
      kind: 'package';
      selection: Extract<SkillSelection, { kind: 'package' }>;
      origin: SkillOrigin;
    }
  | { kind: 'choices'; items: { name: string; source: SkillSource }[]; origin: SkillOrigin };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const slug = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(v);
export function isSkillPlatform(v: unknown): v is SkillPlatform {
  return ['skills.sh', 'skillsmp', 'clawhub'].includes(String(v));
}
function https(v: unknown, hosts?: string[]): v is string {
  if (!text(v, 2048)) return false;
  try {
    const u = new URL(v);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      (!hosts || hosts.includes(u.hostname))
    );
  } catch {
    return false;
  }
}
function github(v: unknown) {
  if (!https(v, ['github.com'])) return false;
  const parts = new URL(v).pathname.split('/').filter(Boolean);
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(parts[0] ?? '') &&
    /^[a-zA-Z0-9_.-]{1,100}$/.test(parts[1] ?? '') &&
    !['.', '..'].includes(parts[1])
  );
}
export function isSkillSource(v: unknown): v is SkillSource {
  if (!object(v)) return false;
  if (v.platform === 'github')
    return (
      keys(v, ['platform', 'url', 'skill']) &&
      github(v.url) &&
      (v.skill === undefined || slug(v.skill))
    );
  return (
    v.platform === 'clawhub' &&
    keys(v, ['platform', 'slug', 'owner']) &&
    slug(v.slug) &&
    slug(v.owner)
  );
}
const origin = (v: unknown): v is SkillOrigin =>
  object(v) &&
  keys(v, ['label', 'url', 'revision']) &&
  text(v.label, 120) &&
  https(v.url, ['github.com', 'clawhub.ai']) &&
  text(v.revision, 200);
export function isSkillSearchResult(v: unknown): v is SkillSearchResult {
  return (
    object(v) &&
    keys(v, ['platform', 'query', 'items']) &&
    isSkillPlatform(v.platform) &&
    text(v.query, 200) &&
    Array.isArray(v.items) &&
    v.items.length <= 20 &&
    Array.from(v.items).every(
      (item) =>
        object(item) &&
        keys(item, ['id', 'name', 'description', 'url', 'source', 'usage']) &&
        text(item.id, 240) &&
        text(item.name, 120) &&
        typeof item.description === 'string' &&
        item.description.length <= 1000 &&
        https(item.url, ['skills.sh', 'skillsmp.com', 'clawhub.ai', 'github.com']) &&
        (item.source === undefined || isSkillSource(item.source)) &&
        (item.usage === undefined ||
          (object(item.usage) &&
            keys(item.usage, ['kind', 'count']) &&
            ['installs', 'downloads', 'stars'].includes(String(item.usage.kind)) &&
            Number.isSafeInteger(item.usage.count) &&
            Number(item.usage.count) >= 0)),
    )
  );
}
export function isSkillRemoteResult(v: unknown): v is SkillRemoteResult {
  if (!object(v) || !origin(v.origin)) return false;
  if (v.kind === 'package')
    return (
      keys(v, ['kind', 'selection', 'origin']) &&
      isSkillSelection(v.selection) &&
      v.selection.kind === 'package'
    );
  return (
    v.kind === 'choices' &&
    keys(v, ['kind', 'items', 'origin']) &&
    Array.isArray(v.items) &&
    v.items.length <= 100 &&
    Array.from(v.items).every(
      (item) =>
        object(item) &&
        keys(item, ['name', 'source']) &&
        text(item.name, 240) &&
        isSkillSource(item.source),
    )
  );
}
