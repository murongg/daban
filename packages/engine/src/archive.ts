import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import { secureDirectory } from './private-files.js';

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function entryName(name: string) {
  const directory = name.endsWith('/');
  const parts = (directory ? name.slice(0, -1) : name).split('/');
  if (
    !name ||
    name.length > 1024 ||
    /[\\:]/.test(name) ||
    Array.from(name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw Error('ARCHIVE_UNSAFE');
  return { parts, directory, key: parts.join('/').toLowerCase() };
}
async function regular(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('ARCHIVE_UNSAFE');
  return info;
}
function unchanged(before: Stats, after: Stats) {
  if (
    !same(before, after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    after.nlink !== 1
  )
    throw Error('ARCHIVE_UNSAFE');
}

export async function createArchive(source: string, target: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = await secureDirectory(source);
  const relative = path.relative(root, path.resolve(target));
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    throw Error('ARCHIVE_UNSAFE');
  const files: { name: string; info: Stats }[] = [];
  const names = new Set<string>();
  let unpackedBytes = 0;
  async function walk(directory: string, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted();
      const relative = prefix + name;
      const checked = entryName(relative);
      if (names.has(checked.key)) throw Error('ARCHIVE_UNSAFE');
      names.add(checked.key);
      if (names.size > 4096) throw Error('ARCHIVE_LIMIT');
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw Error('ARCHIVE_UNSAFE');
      if (info.isDirectory()) await walk(file, relative + '/');
      else {
        if (!info.isFile() || info.nlink !== 1) throw Error('ARCHIVE_UNSAFE');
        unpackedBytes += info.size;
        if (unpackedBytes > 2 * 1024 ** 3) throw Error('ARCHIVE_LIMIT');
        files.push({ name: relative, info });
      }
    }
  }
  await walk(root);
  await secureDirectory(path.dirname(target));
  const output = await open(target, 'wx', 0o600);
  let pending: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  let bytes = 0;
  let finished = false;
  const hash = createHash('sha256');
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure ??= error;
      return;
    }
    bytes += chunk.length;
    if (bytes > 2 * 1024 ** 3) {
      failure ??= Error('ARCHIVE_LIMIT');
      return;
    }
    hash.update(chunk);
    pending = pending
      .then(() => output.writeFile(chunk))
      .catch((error) => {
        failure ??= error;
      });
    finished ||= final;
  });
  try {
    for (const item of files) {
      signal?.throwIfAborted();
      const input = await open(
        path.join(root, item.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        unchanged(item.info, await input.stat());
        const file = new ZipPassThrough(item.name);
        // Images are already compressed. Stored entries keep streaming memory bounded and timestamps reproducible.
        file.mtime = new Date(1980, 0, 1);
        file.os = 0;
        file.attrs = 0;
        zip.add(file);
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          signal?.throwIfAborted();
          file.push(new Uint8Array(chunk));
          await pending;
          if (failure) throw failure;
        }
        file.push(new Uint8Array(), true);
        await pending;
        if (failure) throw failure;
        unchanged(item.info, await input.stat());
      } finally {
        await input.close();
      }
    }
    zip.end();
    await pending;
    if (failure) throw failure;
    if (!finished) throw Error('ARCHIVE_CORRUPT');
    await output.sync();
    return { bytes, sha256: hash.digest('hex'), unpackedBytes };
  } finally {
    zip.terminate();
    await pending;
    await output.close();
  }
}

async function readBytes(input: FileHandle, position: number, length: number) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const part = await input.read(bytes, offset, length - offset, position + offset);
    if (!part.bytesRead) throw Error('ARCHIVE_CORRUPT');
    offset += part.bytesRead;
  }
  return bytes;
}

export async function extractArchive(
  source: string,
  destination: string,
  options: { sha256: string; maxBytes: number; maxFiles?: number; signal?: AbortSignal },
) {
  const { signal } = options;
  signal?.throwIfAborted();
  const maxFiles = options.maxFiles ?? 4096;
  if (
    !/^[a-f0-9]{64}$/.test(options.sha256) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 8 * 1024 ** 3 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 4096
  )
    throw Error('ARCHIVE_LIMIT');
  const identity = await regular(source);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    unchanged(identity, await input.stat());
    if (identity.size < 22 || identity.size > 2 * 1024 ** 3) throw Error('ARCHIVE_CORRUPT');
    const footer = await readBytes(input, identity.size - 22, 22);
    if (
      footer.readUInt32LE(0) !== 0x06054b50 ||
      footer.readUInt16LE(4) !== 0 ||
      footer.readUInt16LE(6) !== 0 ||
      footer.readUInt16LE(20) !== 0 ||
      footer.readUInt16LE(8) !== footer.readUInt16LE(10)
    )
      throw Error('ARCHIVE_CORRUPT');
    const count = footer.readUInt16LE(10);
    const directoryBytes = footer.readUInt32LE(12),
      directoryOffset = footer.readUInt32LE(16);
    if (count > maxFiles || directoryBytes > 8 * 1024 ** 2) throw Error('ARCHIVE_LIMIT');
    if (directoryOffset + directoryBytes !== identity.size - 22) throw Error('ARCHIVE_CORRUPT');
    const hash = createHash('sha256');
    for await (const chunk of input.createReadStream({ autoClose: false, start: 0 })) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest('hex') !== options.sha256) throw Error('ARCHIVE_INTEGRITY');
    unchanged(identity, await input.stat());
    const directory = await readBytes(input, directoryOffset, directoryBytes);
    const entries: { name: ReturnType<typeof entryName>; offset: number; bytes: number }[] = [];
    const names = new Set<string>(),
      directories = new Set<string>(),
      files = new Set<string>();
    let cursor = 0,
      size = 0,
      previousEnd = 0;
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50)
        throw Error('ARCHIVE_CORRUPT');
      const flags = directory.readUInt16LE(cursor + 8),
        method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16),
        bytes = directory.readUInt32LE(cursor + 20);
      const expanded = directory.readUInt32LE(cursor + 24),
        nameBytes = directory.readUInt16LE(cursor + 28);
      const extraBytes = directory.readUInt16LE(cursor + 30),
        commentBytes = directory.readUInt16LE(cursor + 32);
      const offset = directory.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameBytes + extraBytes + commentBytes;
      if (
        end > directory.length ||
        method !== 0 ||
        (flags & ~0x0808) !== 0 ||
        bytes !== expanded ||
        directory.readUInt16LE(cursor + 34) !== 0 ||
        offset !== previousEnd ||
        nameBytes > 1024 ||
        extraBytes > 4096 ||
        commentBytes > 1024
      )
        throw Error('ARCHIVE_CORRUPT');
      const encodedName = directory.subarray(cursor + 46, cursor + 46 + nameBytes);
      const text = encodedName.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(encodedName)) throw Error('ARCHIVE_UNSAFE');
      const name = entryName(text);
      if (names.has(name.key) || (name.directory ? files : directories).has(name.key))
        throw Error('ARCHIVE_UNSAFE');
      names.add(name.key);
      for (let part = 1; part < name.parts.length; part++) {
        const parent = name.parts.slice(0, part).join('/').toLowerCase();
        if (files.has(parent)) throw Error('ARCHIVE_UNSAFE');
        directories.add(parent);
      }
      (name.directory ? directories : files).add(name.key);
      size += bytes;
      if (size > options.maxBytes) throw Error('ARCHIVE_LIMIT');
      if (name.directory && bytes) throw Error('ARCHIVE_UNSAFE');
      if (offset + 30 > directoryOffset) throw Error('ARCHIVE_CORRUPT');
      const local = await readBytes(input, offset, 30);
      const localExtra = local.readUInt16LE(28);
      const dataOffset = offset + 30 + nameBytes + localExtra;
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== flags ||
        local.readUInt16LE(8) !== method ||
        local.readUInt16LE(26) !== nameBytes ||
        localExtra > 4096 ||
        dataOffset + bytes > directoryOffset ||
        !(await readBytes(input, offset + 30, nameBytes)).equals(encodedName)
      )
        throw Error('ARCHIVE_CORRUPT');
      previousEnd = dataOffset + bytes;
      if (flags & 8) {
        if (previousEnd + 16 > directoryOffset) throw Error('ARCHIVE_CORRUPT');
        const descriptor = await readBytes(input, previousEnd, 16);
        if (
          descriptor.readUInt32LE(0) !== 0x08074b50 ||
          descriptor.readUInt32LE(4) !== crc ||
          descriptor.readUInt32LE(8) !== bytes ||
          descriptor.readUInt32LE(12) !== expanded
        )
          throw Error('ARCHIVE_CORRUPT');
        previousEnd += 16;
      } else if (
        local.readUInt32LE(14) !== crc ||
        local.readUInt32LE(18) !== bytes ||
        local.readUInt32LE(22) !== expanded
      )
        throw Error('ARCHIVE_CORRUPT');
      entries.push({ name, offset: dataOffset, bytes });
      cursor = end;
    }
    if (cursor !== directory.length || previousEnd !== directoryOffset)
      throw Error('ARCHIVE_CORRUPT');
    const root = await secureDirectory(destination);
    if ((await readdir(root)).length) throw Error('ARCHIVE_UNSAFE');
    // Stored image bytes can contain ZIP signatures. Use verified directory lengths, never scan payload framing.
    for (const entry of entries) {
      signal?.throwIfAborted();
      const target = path.join(root, ...entry.name.parts);
      await secureDirectory(entry.name.directory ? target : path.dirname(target));
      if (entry.name.directory) continue;
      const output = await open(target, 'wx', 0o600);
      try {
        for (let offset = 0; offset < entry.bytes; ) {
          signal?.throwIfAborted();
          const bytes = await readBytes(
            input,
            entry.offset + offset,
            Math.min(1024 * 1024, entry.bytes - offset),
          );
          await output.writeFile(bytes);
          offset += bytes.length;
        }
        await output.sync();
      } finally {
        await output.close();
      }
    }
    unchanged(identity, await input.stat());
    return size;
  } finally {
    await input.close();
  }
}
