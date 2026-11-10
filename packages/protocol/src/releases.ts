import {
  type BotProfileInput,
  botBundleLimit,
  type DocumentUpload,
  isBotProfileInput,
  isDocumentUpload,
  isKnowledgeContent,
  isKnowledgePath,
} from './index.js';
import { isSkillPackage, type SkillPackage } from './skills.js';

export const botReleaseCapability = 'bot-releases-v1';
export const releaseUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const releaseDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const releaseKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const releaseVersion = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) &&
  value.split('.').every((part) => Number(part) <= 2147483647);

export interface GallerySource {
  sourceOrigin: string;
  sourceId: string;
}
export interface ReleaseOrigin extends GallerySource {
  templateId: string;
  releaseVersion: string;
  digest: string;
}
export interface ReleaseRequirements {
  capabilities: string[];
  tools: { name: string; required: boolean }[];
  model: { toolCalling: boolean; vision: boolean };
}
export interface ReleaseSkill {
  key: string;
  package: SkillPackage & { root: string };
}
export interface ReleaseKnowledge {
  key: string;
  path: string;
  content: string;
  original?: DocumentUpload;
}
export interface BotDefinition {
  profile: Pick<BotProfileInput, 'name' | 'instructions' | 'color'>;
  defaultPreferences: string;
  skills: ReleaseSkill[];
  knowledge: ReleaseKnowledge[];
}
export interface BotRelease {
  format: 'daban.bot';
  version: 3;
  manifest: {
    templateId: string;
    releaseVersion: string;
    summary: string;
    license: string;
    changelog: string;
    requires: ReleaseRequirements;
    derivedFrom: ReleaseOrigin | null;
  };
  definition: BotDefinition;
}
export type ReleaseChoices = Record<string, 'local' | 'target'>;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' &&
  !value.includes('\0') &&
  !/[\uD800-\uDFFF]/u.test(value) &&
  new TextEncoder().encode(value).length <= bytes;
const unique = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;
const ordered = <T>(items: T[], key: (item: T) => string) =>
  [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

export function galleryOrigin(value: unknown, local = false): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (local &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function isReleaseOrigin(value: unknown): value is ReleaseOrigin {
  return (
    object(value) &&
    keys(value, ['sourceOrigin', 'sourceId', 'templateId', 'releaseVersion', 'digest']) &&
    galleryOrigin(value.sourceOrigin, true) &&
    releaseUuid(value.sourceId) &&
    releaseUuid(value.templateId) &&
    releaseVersion(value.releaseVersion) &&
    releaseDigest(value.digest)
  );
}
function skillMainText(data: string) {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
    );
    return decoded.length <= 100000 && text(decoded, 200000);
  } catch {
    return false;
  }
}
export function isReleaseRequirements(value: unknown): value is ReleaseRequirements {
  return (
    object(value) &&
    keys(value, ['capabilities', 'tools', 'model']) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 32 &&
    value.capabilities.includes(botReleaseCapability) &&
    value.capabilities.every(releaseKey) &&
    unique(value.capabilities, String) &&
    Array.isArray(value.tools) &&
    value.tools.length <= 64 &&
    value.tools.every(
      (tool) =>
        object(tool) &&
        keys(tool, ['name', 'required']) &&
        typeof tool.name === 'string' &&
        tool.name.length <= 128 &&
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(tool.name) &&
        typeof tool.required === 'boolean',
    ) &&
    unique(value.tools, (tool) => tool.name) &&
    object(value.model) &&
    keys(value.model, ['toolCalling', 'vision']) &&
    typeof value.model.toolCalling === 'boolean' &&
    typeof value.model.vision === 'boolean'
  );
}
export function isBotDefinition(value: unknown): value is BotDefinition {
  if (
    !object(value) ||
    !keys(value, ['profile', 'defaultPreferences', 'skills', 'knowledge']) ||
    !object(value.profile) ||
    !keys(value.profile, ['name', 'instructions', 'color']) ||
    !text(value.defaultPreferences, 48000) ||
    value.defaultPreferences.length > 12000 ||
    !isBotProfileInput({ id: 'portable', ...value.profile, memory: value.defaultPreferences }) ||
    !text(value.profile.name, 320) ||
    !text(value.profile.instructions, 80000) ||
    !Array.isArray(value.skills) ||
    value.skills.length > 20 ||
    !Array.isArray(value.knowledge) ||
    value.knowledge.length > 100
  )
    return false;
  if (
    !value.skills.every(
      (skill) =>
        object(skill) &&
        keys(skill, ['key', 'package']) &&
        releaseKey(skill.key) &&
        isSkillPackage(skill.package) &&
        typeof skill.package.root === 'string' &&
        skill.package.files.every(
          (file) =>
            typeof file.executable === 'boolean' &&
            (file.path !== 'SKILL.md' || !file.executable) &&
            (file.path !== 'SKILL.md' || skillMainText(file.data)) &&
            btoa(atob(file.data)) === file.data,
        ),
    ) ||
    !value.knowledge.every(
      (doc) =>
        object(doc) &&
        keys(doc, ['key', 'path', 'content'], ['original']) &&
        releaseKey(doc.key) &&
        isKnowledgePath(doc.path) &&
        isKnowledgeContent(doc.content) &&
        text(doc.content, 204800) &&
        (doc.original === undefined ||
          (isDocumentUpload(doc.original) && btoa(atob(doc.original.data)) === doc.original.data)),
    )
  )
    return false;
  const definition = value as unknown as BotDefinition;
  const originals = definition.knowledge.flatMap((doc) => (doc.original ? [doc.original] : []));
  return (
    unique(definition.skills, (skill) => skill.key) &&
    unique(definition.skills, (skill) => skill.package.root) &&
    unique(definition.knowledge, (doc) => doc.key) &&
    unique(definition.knowledge, (doc) => doc.path) &&
    unique(originals, (file) => file.name) &&
    originals.reduce((sum, file) => sum + atob(file.data).length, 0) <= 50 * 1024 * 1024 &&
    definition.knowledge.reduce(
      (sum, doc) => sum + new TextEncoder().encode(doc.content).length,
      0,
    ) <=
      20 * 1024 * 1024
  );
}
export function isBotRelease(value: unknown): value is BotRelease {
  try {
    if (
      !object(value) ||
      !keys(value, ['format', 'version', 'manifest', 'definition']) ||
      value.format !== 'daban.bot' ||
      value.version !== 3 ||
      !object(value.manifest) ||
      !keys(value.manifest, [
        'templateId',
        'releaseVersion',
        'summary',
        'license',
        'changelog',
        'requires',
        'derivedFrom',
      ])
    )
      return false;
    const manifest = value.manifest;
    return (
      releaseUuid(manifest.templateId) &&
      releaseVersion(manifest.releaseVersion) &&
      text(manifest.summary, 2048) &&
      text(manifest.license, 128) &&
      manifest.license.trim().length > 0 &&
      text(manifest.changelog, 16384) &&
      isReleaseRequirements(manifest.requires) &&
      (manifest.derivedFrom === null || isReleaseOrigin(manifest.derivedFrom)) &&
      isBotDefinition(value.definition) &&
      (!value.definition.skills.length ||
        manifest.requires.capabilities.includes('skill-packages-v1')) &&
      new TextEncoder().encode(botReleaseText(value as unknown as BotRelease)).length <=
        botBundleLimit
    );
  } catch {
    return false;
  }
}
export function botReleaseText(value: BotRelease) {
  const m = value.manifest;
  const d = value.definition;
  return JSON.stringify({
    format: 'daban.bot',
    version: 3,
    manifest: {
      templateId: m.templateId,
      releaseVersion: m.releaseVersion,
      summary: m.summary,
      license: m.license,
      changelog: m.changelog,
      requires: {
        capabilities: [...m.requires.capabilities].sort(),
        tools: ordered(m.requires.tools, (tool) => tool.name).map((tool) => ({
          name: tool.name,
          required: tool.required,
        })),
        model: { toolCalling: m.requires.model.toolCalling, vision: m.requires.model.vision },
      },
      derivedFrom: m.derivedFrom
        ? {
            sourceOrigin: m.derivedFrom.sourceOrigin,
            sourceId: m.derivedFrom.sourceId,
            templateId: m.derivedFrom.templateId,
            releaseVersion: m.derivedFrom.releaseVersion,
            digest: m.derivedFrom.digest,
          }
        : null,
    },
    definition: {
      profile: {
        name: d.profile.name,
        instructions: d.profile.instructions,
        color: d.profile.color,
      },
      defaultPreferences: d.defaultPreferences,
      skills: ordered(d.skills, (skill) => skill.key).map((skill) => ({
        key: skill.key,
        package: {
          root: skill.package.root,
          files: ordered(skill.package.files, (file) => file.path).map((file) => ({
            path: file.path,
            data: file.data,
            executable: file.executable ?? false,
          })),
        },
      })),
      knowledge: ordered(d.knowledge, (doc) => doc.key).map((doc) => ({
        key: doc.key,
        path: doc.path,
        content: doc.content,
        ...(doc.original ? { original: { name: doc.original.name, data: doc.original.data } } : {}),
      })),
    },
  });
}

// JSON.parse cannot report duplicate properties; check them before any review or hashing.
export function parseReleaseJSON(source: string): unknown {
  if (new TextEncoder().encode(source).length > botBundleLimit) throw Error('PACKAGE_TOO_LARGE');
  let position = 0;
  let containers = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[position] ?? 'x')) position++;
  };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === '"') return JSON.parse(source.slice(start, position)) as string;
    }
    throw Error('INVALID_PACKAGE');
  };
  const value = (depth: number): unknown => {
    whitespace();
    const char = source[position];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      if (depth >= 16 || ++containers > 10000) throw Error('INVALID_PACKAGE');
      position++;
      const array = char === '[';
      const result: Record<string, unknown> = Object.create(null);
      const entries: unknown[] = [];
      const end = array ? ']' : '}';
      whitespace();
      if (source[position] !== end)
        while (true) {
          whitespace();
          if (array) entries.push(value(depth + 1));
          else {
            if (source[position] !== '"') throw Error('INVALID_PACKAGE');
            const key = string();
            if (Object.hasOwn(result, key)) throw Error('INVALID_PACKAGE');
            whitespace();
            if (source[position++] !== ':') throw Error('INVALID_PACKAGE');
            result[key] = value(depth + 1);
          }
          whitespace();
          if (source[position] !== ',') break;
          position++;
        }
      if (source[position++] !== end) throw Error('INVALID_PACKAGE');
      return array ? entries : result;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(position),
    );
    if (!match) throw Error('INVALID_PACKAGE');
    position += match[0].length;
    return JSON.parse(match[0]);
  };
  const result = value(0);
  whitespace();
  if (position !== source.length) throw Error('INVALID_PACKAGE');
  return result;
}
export function parseBotRelease(source: string, canonical = false): BotRelease {
  const value = parseReleaseJSON(source);
  if (
    object(value) &&
    value.format === 'daban.bot' &&
    Number.isSafeInteger(value.version) &&
    value.version !== 3
  )
    throw Error('UNSUPPORTED_PACKAGE_VERSION');
  if (!isBotRelease(value)) throw Error('INVALID_PACKAGE');
  if (canonical && botReleaseText(value) !== source) throw Error('NON_CANONICAL_PACKAGE');
  return value;
}
export function compareReleaseVersions(a: string, b: string) {
  if (!releaseVersion(a) || !releaseVersion(b)) throw Error('INVALID_RELEASE_VERSION');
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function mergeRelease(
  base: BotDefinition,
  local: BotDefinition,
  target: BotDefinition,
  choices: ReleaseChoices = {},
) {
  const conflicts: string[] = [];
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const choose = <T>(key: string, b: T, l: T, n: T): T => {
    if (equal(l, b)) return n;
    if (equal(n, b) || equal(l, n)) return l;
    if (choices[key]) return choices[key] === 'local' ? l : n;
    conflicts.push(key);
    return l;
  };
  const resources = <T extends { key: string }>(kind: string, b: T[], l: T[], n: T[]) => {
    const result: T[] = [];
    for (const key of [...new Set([...b, ...l, ...n].map((item) => item.key))].sort()) {
      const entry = choose(
        `${kind}:${key}`,
        b.find((item) => item.key === key),
        l.find((item) => item.key === key),
        n.find((item) => item.key === key),
      );
      if (entry) result.push(entry);
    }
    return result;
  };
  return {
    definition: structuredClone({
      profile: {
        ...local.profile,
        instructions: choose(
          'instructions',
          base.profile.instructions,
          local.profile.instructions,
          target.profile.instructions,
        ),
      },
      defaultPreferences: choose(
        'defaultPreferences',
        base.defaultPreferences,
        local.defaultPreferences,
        target.defaultPreferences,
      ),
      skills: resources('skills', base.skills, local.skills, target.skills),
      knowledge: resources('knowledge', base.knowledge, local.knowledge, target.knowledge),
    }),
    conflicts,
  };
}
