import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import {
  isSkillPackage,
  isSkillPath,
  type SkillPackage,
  type SkillPackageFile,
  type SkillPackagePreview,
  type SkillResource,
  type SkillSelection,
  skillArchiveLimit,
  skillPackageFiles,
  skillPackageLimit,
} from '@daban/protocol';
import { type Zippable, zipSync } from 'fflate';
import { Fault } from './control.js';
import { parseSkill } from './skill-content.js';

const invalid = (): never => {
  throw new Fault('INVALID_SKILL_PACKAGE', 400);
};
const large = (): never => {
  throw new Fault('SKILL_PACKAGE_TOO_LARGE', 413);
};
export const skillHash = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export function normalizeSkillPackage(value: unknown): SkillPackage {
  if (!isSkillPackage(value)) return invalid();
  const main = value.files.find((file) => file.path === 'SKILL.md')!;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(main.data, 'base64'));
  } catch {
    return invalid();
  }
  let parsed: ReturnType<typeof parseSkill>;
  try {
    parsed = parseSkill(content, true);
  } catch {
    return invalid();
  }
  if (value.root !== undefined && value.root !== parsed.name) return invalid();
  return {
    root: parsed.name,
    files: value.files
      .map((file) => ({
        path: file.path,
        data: Buffer.from(file.data, 'base64').toString('base64'),
        executable: file.path === 'SKILL.md' ? false : (file.executable ?? false),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
export function packageResources(value: SkillPackage): SkillResource[] {
  return value.files.map((file) => {
    const bytes = Buffer.from(file.data, 'base64');
    return {
      path: file.path,
      size: bytes.length,
      sha256: skillHash(bytes),
      executable: file.executable ?? false,
    };
  });
}
export function inspectSkillPackage(value: unknown): SkillPackagePreview {
  const bundle = normalizeSkillPackage(value),
    files = packageResources(bundle);
  const content = Buffer.from(
    bundle.files.find((file) => file.path === 'SKILL.md')!.data,
    'base64',
  ).toString('utf8');
  const parsed = parseSkill(content, true);
  return {
    name: parsed.name,
    description: parsed.description,
    files,
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    digest: skillHash(JSON.stringify(files)),
  };
}
const ignored = (name: string) =>
  name.split('/').includes('__MACOSX') || name.split('/').at(-1) === '.DS_Store';
export function readSkillZip(value: Uint8Array): SkillPackage {
  const zip = Buffer.from(value);
  if (zip.length > skillArchiveLimit) return large();
  if (zip.length < 22) return invalid();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  }
  if (
    end < 0 ||
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0 ||
    zip.readUInt16LE(end + 8) !== zip.readUInt16LE(end + 10)
  )
    return invalid();
  const count = zip.readUInt16LE(end + 10),
    directorySize = zip.readUInt32LE(end + 12),
    directory = zip.readUInt32LE(end + 16);
  if (count > skillPackageFiles * 2) return large();
  if (!count || directory + directorySize !== end) return invalid();
  const entries: {
    name: string;
    start: number;
    end: number;
    method: number;
    size: number;
    crc: number;
    executable: boolean;
  }[] = [];
  let cursor = directory,
    total = 0;
  const text = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) return invalid();
    const flags = zip.readUInt16LE(cursor + 8),
      method = zip.readUInt16LE(cursor + 10),
      crc = zip.readUInt32LE(cursor + 16),
      compressed = zip.readUInt32LE(cursor + 20),
      size = zip.readUInt32LE(cursor + 24);
    const nameSize = zip.readUInt16LE(cursor + 28),
      extra = zip.readUInt16LE(cursor + 30),
      comment = zip.readUInt16LE(cursor + 32),
      disk = zip.readUInt16LE(cursor + 34),
      attrs = zip.readUInt32LE(cursor + 38),
      local = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extra + comment;
    if (next > end || disk || flags & 1 || ![0, 8].includes(method)) return invalid();
    total += size;
    if (size > skillPackageLimit || total > skillPackageLimit) return large();
    let name: string;
    try {
      name = text.decode(zip.subarray(cursor + 46, cursor + 46 + nameSize));
    } catch {
      return invalid();
    }
    const directoryEntry = name.endsWith('/'),
      clean = directoryEntry ? name.slice(0, -1) : name;
    const mode = attrs >>> 16,
      type = mode & 0xf000;
    if (!isSkillPath(clean) || (type && type !== (directoryEntry ? 0x4000 : 0x8000)))
      return invalid();
    if (
      local + 30 > directory ||
      zip.readUInt32LE(local) !== 0x04034b50 ||
      zip.readUInt16LE(local + 6) !== flags ||
      zip.readUInt16LE(local + 8) !== method
    )
      return invalid();
    const localNameSize = zip.readUInt16LE(local + 26),
      localExtra = zip.readUInt16LE(local + 28),
      start = local + 30 + localNameSize + localExtra;
    if (
      start + compressed > directory ||
      localNameSize !== nameSize ||
      !zip
        .subarray(local + 30, local + 30 + localNameSize)
        .equals(zip.subarray(cursor + 46, cursor + 46 + nameSize))
    )
      return invalid();
    if (
      !(flags & 8) &&
      (zip.readUInt32LE(local + 14) !== crc ||
        zip.readUInt32LE(local + 18) !== compressed ||
        zip.readUInt32LE(local + 22) !== size)
    )
      return invalid();
    if (directoryEntry && size) return invalid();
    if (!directoryEntry && !ignored(name))
      entries.push({
        name,
        start,
        end: start + compressed,
        method,
        size,
        crc,
        executable: !!(mode & 0o111),
      });
    cursor = next;
  }
  if (cursor !== end || !entries.length || entries.length > skillPackageFiles) return invalid();
  const ranges = [...entries].sort((a, b) => a.start - b.start);
  if (ranges.some((entry, index) => index > 0 && entry.start < ranges[index - 1].end))
    return invalid();
  const root = entries.some((entry) => entry.name === 'SKILL.md')
    ? undefined
    : entries[0].name.split('/')[0];
  if (
    root &&
    (!entries.some((entry) => entry.name === `${root}/SKILL.md`) ||
      entries.some((entry) => !entry.name.startsWith(`${root}/`)))
  )
    return invalid();
  const files: SkillPackageFile[] = [];
  for (const entry of entries) {
    let bytes: Buffer;
    try {
      bytes =
        entry.method === 0
          ? zip.subarray(entry.start, entry.end)
          : inflateRawSync(zip.subarray(entry.start, entry.end), {
              maxOutputLength: Math.max(1, entry.size),
            });
    } catch {
      return invalid();
    }
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) return invalid();
    files.push({
      path: root ? entry.name.slice(root.length + 1) : entry.name,
      data: bytes.toString('base64'),
      executable: entry.executable,
    });
  }
  // Central sizes were bounded before inflation; the canonical package now checks collisions and file/directory aliases.
  return normalizeSkillPackage({ ...(root ? { root } : {}), files });
}
export function writeSkillZip(value: SkillPackage): Buffer {
  const bundle = normalizeSkillPackage(value),
    files: Zippable = {};
  for (const file of bundle.files)
    files[`${bundle.root}/${file.path}`] = [
      Buffer.from(file.data, 'base64'),
      { os: 3, attrs: ((0x8000 | (file.executable ? 0o755 : 0o644)) << 16) >>> 0 },
    ];
  const zip = Buffer.from(zipSync(files, { level: 6 }));
  if (zip.length > skillArchiveLimit) return large();
  return zip;
}
export async function readSkillDirectory(
  selected: string,
  signal?: AbortSignal,
): Promise<SkillPackage> {
  const root = path.resolve(selected),
    initial = await lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) return invalid();
  const canonical = await realpath(root),
    files: SkillPackageFile[] = [];
  let size = 0;
  const walk = async (directory: string, prefix = '') => {
    signal?.throwIfAborted();
    if ((await realpath(directory)) !== path.join(canonical, prefix)) return invalid();
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (ignored(relative)) continue;
      if (!isSkillPath(relative)) return invalid();
      const target = path.join(directory, name),
        info = await lstat(target);
      if (info.isSymbolicLink()) return invalid();
      if (info.isDirectory()) {
        await walk(target, relative);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) return invalid();
      size += info.size;
      if (files.length >= skillPackageFiles || size > skillPackageLimit) return large();
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.nlink !== 1 ||
          !opened.isFile()
        )
          return invalid();
        const bytes = Buffer.alloc(Math.min(skillPackageLimit, info.size) + 1);
        let used = 0;
        while (used < bytes.length) {
          signal?.throwIfAborted();
          const read = await file.read(bytes, used, bytes.length - used, used);
          if (!read.bytesRead) break;
          used += read.bytesRead;
        }
        if (used !== info.size || (await realpath(directory)) !== path.join(canonical, prefix))
          return invalid();
        files.push({
          path: relative,
          data: bytes.subarray(0, used).toString('base64'),
          executable: process.platform !== 'win32' && !!(info.mode & 0o111),
        });
      } finally {
        await file.close();
      }
    }
  };
  await walk(root);
  return normalizeSkillPackage({ root: path.basename(root), files });
}
export async function readSkillSelection(
  kind: 'directory' | 'file',
  selected: string,
  signal?: AbortSignal,
): Promise<SkillSelection> {
  if (kind === 'directory') {
    const bundle = await readSkillDirectory(selected, signal);
    return { kind: 'package', package: bundle, preview: inspectSkillPackage(bundle) };
  }
  signal?.throwIfAborted();
  const info = await lstat(selected);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return invalid();
  if (info.size > skillArchiveLimit) return large();
  const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.nlink !== 1
    )
      return invalid();
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, used, buffer.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used !== info.size) return invalid();
    bytes = buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
  if (path.extname(selected).toLowerCase() === '.zip') {
    const bundle = readSkillZip(bytes);
    return { kind: 'package', package: bundle, preview: inspectSkillPackage(bundle) };
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  const parsed = parseSkill(content);
  return { kind: 'text', content, name: parsed.name, description: parsed.description };
}
