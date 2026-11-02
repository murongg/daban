import { validAgentId } from './id.js';

export const skillPackageCapability = 'skill-packages-v1';
export const skillPackageLimit = 5 * 1024 * 1024;
export const skillArchiveLimit = 6 * 1024 * 1024;
export const skillPackageFiles = 200;

export interface SkillPackageFile {
  path: string;
  data: string;
  executable?: boolean;
}
export interface SkillPackage {
  root?: string;
  files: SkillPackageFile[];
}
export interface SkillResource {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}
export interface SkillPackageInfo {
  digest: string;
  fileCount: number;
  bytes: number;
}
export interface SkillPackagePreview extends SkillPackageInfo {
  name: string;
  description: string;
  files: SkillResource[];
}
export type SkillSelection =
  | { kind: 'text'; content: string; name: string; description: string }
  | { kind: 'package'; package: SkillPackage; preview: SkillPackagePreview };
export interface SkillResourceData {
  id: string;
  revision: number;
  file: SkillResource;
  data: string;
}
export interface SkillArchive {
  name: string;
  data: string;
  size: number;
  sha256: string;
}
export interface SkillArchiveResult {
  id: string;
  revision: number;
  archive: SkillArchive;
}
export type SkillPackageCommand =
  | { type: 'skill.pick'; bot: string; kind: 'directory' | 'file' }
  | { type: 'skill.package.import'; bot: string; package: SkillPackage }
  | {
      type: 'skill.package.update';
      bot: string;
      id: string;
      revision: number;
      package: SkillPackage;
    }
  | { type: 'skill.package.export'; bot: string; id: string; revision: number }
  | { type: 'skill.resource'; bot: string; id: string; revision: number; path: string };
export function isSkillPackageCommand(value: unknown): value is SkillPackageCommand {
  if (!object(value) || !validAgentId(value.bot)) return false;
  if (value.type === 'skill.pick')
    return (
      keys(value, ['type', 'bot', 'kind']) && ['directory', 'file'].includes(String(value.kind))
    );
  if (value.type === 'skill.package.import')
    return keys(value, ['type', 'bot', 'package']) && isSkillPackage(value.package);
  if (
    !validAgentId(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    return false;
  if (value.type === 'skill.package.update')
    return (
      keys(value, ['type', 'bot', 'id', 'revision', 'package']) && isSkillPackage(value.package)
    );
  if (value.type === 'skill.package.export') return keys(value, ['type', 'bot', 'id', 'revision']);
  return (
    value.type === 'skill.resource' &&
    keys(value, ['type', 'bot', 'id', 'revision', 'path']) &&
    isSkillPath(value.path)
  );
}
export function isSkillArchiveResult(value: unknown): value is SkillArchiveResult {
  return (
    object(value) &&
    keys(value, ['id', 'revision', 'archive']) &&
    validAgentId(value.id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    isSkillArchive(value.archive)
  );
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown, max: number) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
export function isSkillPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\\:*?"<>|]/.test(value) &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    value.split('/').length <= 16 &&
    value
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
export function skillDataSize(value: unknown, max = skillPackageLimit): number | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 4 * Math.ceil(max / 3) ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    return;
  const result = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  return result <= max ? result : undefined;
}
export function isSkillPackage(value: unknown): value is SkillPackage {
  if (
    !object(value) ||
    !keys(value, ['root', 'files']) ||
    (value.root !== undefined &&
      (typeof value.root !== 'string' ||
        value.root.length > 64 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.root))) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > skillPackageFiles
  )
    return false;
  const seen = new Set<string>();
  let bytes = 0,
    main = false;
  for (const file of Array.from(value.files)) {
    if (
      !object(file) ||
      !keys(file, ['path', 'data', 'executable']) ||
      !isSkillPath(file.path) ||
      (file.executable !== undefined && typeof file.executable !== 'boolean')
    )
      return false;
    const length = skillDataSize(file.data);
    if (length === undefined) return false;
    bytes += length;
    if (bytes > skillPackageLimit) return false;
    const canonical = file.path.normalize('NFC').toLowerCase();
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    if (file.path === 'SKILL.md') main = true;
  }
  if (!main) return false;
  for (const file of seen) {
    const parts = file.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/'))) return false;
      parts.pop();
    }
  }
  return true;
}
export function isSkillResource(value: unknown): value is SkillResource {
  return (
    object(value) &&
    keys(value, ['path', 'size', 'sha256', 'executable']) &&
    isSkillPath(value.path) &&
    size(value.size, skillPackageLimit) &&
    hash(value.sha256) &&
    typeof value.executable === 'boolean'
  );
}
export function isSkillPackageInfo(value: unknown): value is SkillPackageInfo {
  return (
    object(value) &&
    keys(value, ['digest', 'fileCount', 'bytes']) &&
    hash(value.digest) &&
    size(value.bytes, skillPackageLimit) &&
    Number(value.bytes) > 0 &&
    size(value.fileCount, skillPackageFiles) &&
    Number(value.fileCount) > 0
  );
}
export function isSkillResourceData(value: unknown): value is SkillResourceData {
  return (
    object(value) &&
    keys(value, ['id', 'revision', 'file', 'data']) &&
    typeof value.id === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    isSkillResource(value.file) &&
    skillDataSize(value.data) === value.file.size
  );
}
export function isSkillArchive(value: unknown): value is SkillArchive {
  return (
    object(value) &&
    keys(value, ['name', 'data', 'size', 'sha256']) &&
    typeof value.name === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*\.zip$/.test(value.name) &&
    size(value.size, skillArchiveLimit) &&
    skillDataSize(value.data, skillArchiveLimit) === value.size &&
    hash(value.sha256)
  );
}
export function isSkillSelection(value: unknown): value is SkillSelection {
  if (!object(value)) return false;
  if (value.kind === 'text')
    return (
      keys(value, ['kind', 'content', 'name', 'description']) &&
      typeof value.content === 'string' &&
      value.content.length <= 100000 &&
      typeof value.name === 'string' &&
      value.name.length <= 80 &&
      typeof value.description === 'string' &&
      value.description.length <= 2000
    );
  if (
    value.kind !== 'package' ||
    !keys(value, ['kind', 'package', 'preview']) ||
    !isSkillPackage(value.package) ||
    !object(value.preview)
  )
    return false;
  const { name, description, files, ...info } = value.preview;
  return (
    typeof name === 'string' &&
    name.length <= 64 &&
    typeof description === 'string' &&
    description.length <= 1024 &&
    isSkillPackageInfo(info) &&
    Array.isArray(files) &&
    files.length === info.fileCount &&
    Array.from(files).every(isSkillResource)
  );
}
