import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  documentLimit,
  isSkillPackage,
  isTaskFileName,
  type RuntimeDownload,
  type SkillPackage,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  modified: string;
  content?: string;
}
export interface TaskDirectory {
  readonly root: string;
  readonly path: string;
  readonly canonical: string;
  verify(): Promise<unknown>;
  write(name: string, data: string | Buffer, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface AgentWorkspace {
  readonly root: string;
  prepare(): Promise<unknown>;
  base(): Promise<string>;
  create(parts: string[]): Promise<TaskDirectory>;
  list(): Promise<WorkspaceFile[]>;
  read(relative: string, limit?: number): Promise<WorkspaceFile & { content: string }>;
  download(relative: string): Promise<RuntimeDownload>;
  scope(root: string, canonical?: string): AgentWorkspace;
  stageSkill?(bundle: SkillPackage, signal?: AbortSignal): Promise<string>;
}
export class WorkspaceFiles implements AgentWorkspace {
  root: string;
  canonical: string | null;
  constructor(root: string, expectedRoot?: string) {
    this.root = root;
    this.canonical = expectedRoot ?? null;
  }
  async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return this.base();
  }
  scope(root: string, canonical?: string) {
    return new WorkspaceFiles(root, canonical);
  }
  async base() {
    const handle = await open(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const value = await realpath(directoryPath(handle, this.root));
      if (this.canonical && this.canonical !== value) throw new Fault('WORKSPACE_MOVED');
      this.canonical = value;
      return value;
    } finally {
      await handle.close();
    }
  }
  async create(parts: string[]) {
    if (!parts.length || !parts.every(validAgentId)) throw new Fault('INVALID_FILE', 400);
    const root = await this.base();
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let handle = await open(root, flags);
    let canonical = root;
    try {
      for (const part of parts) {
        // Linux resolves each child against its opened parent, never a desktop-writable ancestor path.
        const target = path.join(directoryPath(handle, canonical), part);
        try {
          await mkdir(target, { mode: 0o700 });
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        const child = await open(target, flags);
        await handle.close();
        handle = child;
        canonical = await realpath(directoryPath(handle, target));
        if (!canonical.startsWith(root + path.sep)) throw new Fault('TASK_DIRECTORY_MOVED');
      }
      return new WorkspaceDirectory(root, path.join(this.root, ...parts), canonical, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async list(): Promise<WorkspaceFile[]> {
    const root = await this.base(),
      result: WorkspaceFile[] = [];
    const walk = async (dir: string, depth: number): Promise<unknown> => {
      if (depth > 5 || result.length >= 500) return;
      for (const name of await readdir(dir)) {
        if (name.startsWith('.')) continue;
        const file = path.join(dir, name),
          info = await lstat(file).catch(() => null);
        if (!info || info.isSymbolicLink()) continue;
        const canonical = await realpath(file).catch(() => null);
        if (!canonical?.startsWith(root + path.sep)) continue;
        if (info.isDirectory()) await walk(canonical, depth + 1);
        else if (info.isFile())
          result.push({
            // Public workspace references use '/', including when their storage lives on a Windows host.
            path: path.relative(root, canonical).split(path.sep).join('/'),
            name,
            size: info.size,
            modified: info.mtime.toISOString(),
          });
      }
    };
    await walk(root, 0);
    return result.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 200);
  }
  async stageSkill(bundle: SkillPackage, signal?: AbortSignal) {
    if (!isSkillPackage(bundle)) throw new Fault('INVALID_SKILL_PACKAGE', 400);
    signal?.throwIfAborted();
    const root = await this.base(),
      flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const parent = await open(root, flags),
      name = `.skills-${randomUUID()}`;
    try {
      await mkdir(path.join(directoryPath(parent, root), name), { mode: 0o700 });
      const destination = path.join(root, name),
        base = await open(path.join(directoryPath(parent, root), name), flags);
      try {
        for (const file of bundle.files) {
          signal?.throwIfAborted();
          const parts = file.path.split('/'),
            leaf = parts.pop()!;
          let handle = base,
            current = destination;
          try {
            for (const part of parts) {
              const next = path.join(directoryPath(handle, current), part);
              try {
                await mkdir(next, { mode: 0o700 });
              } catch (error) {
                if (errorCode(error) !== 'EEXIST') throw error;
              }
              const child = await open(next, flags);
              if (handle !== base) await handle.close();
              handle = child;
              current = await realpath(directoryPath(child, path.join(current, part)));
              if (!current.startsWith(destination + path.sep))
                throw new Fault('TASK_DIRECTORY_MOVED');
            }
            if (
              (await realpath(destination)) !== destination ||
              (await realpath(this.root)) !== root
            )
              throw new Fault('TASK_DIRECTORY_MOVED');
            // New files only, rooted in opened directories; a package cannot replace a link or overwrite work files.
            const output = await open(
              path.join(directoryPath(handle, current), leaf),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              file.executable ? 0o700 : 0o600,
            );
            try {
              await output.writeFile(Buffer.from(file.data, 'base64'), { signal });
            } finally {
              await output.close();
            }
          } finally {
            if (handle !== base) await handle.close();
          }
        }
      } finally {
        await base.close();
      }
      return destination;
    } finally {
      await parent.close();
    }
  }
  async read(relative: string, limit = 1024 * 1024) {
    const { data, ...file } = await this.bytes(relative, limit);
    if (data.includes(0)) throw new Fault('FILE_NOT_TEXT', 400);
    try {
      return { ...file, content: new TextDecoder('utf-8', { fatal: true }).decode(data) };
    } catch {
      throw new Fault('FILE_NOT_TEXT', 400);
    }
  }
  async download(relative: string): Promise<RuntimeDownload> {
    const { data, ...file } = await this.bytes(relative, documentLimit);
    return {
      ...file,
      data: data.toString('base64'),
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }
  private async bytes(relative: string, limit: number) {
    if (
      typeof relative !== 'string' ||
      relative.length > 512 ||
      relative.startsWith('/') ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      relative.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Fault('INVALID_FILE', 400);
    const root = await this.base(),
      file = path.join(root, relative),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit)
      throw new Fault('FILE_NOT_READABLE', 400);
    const canonical = await realpath(file);
    if (!canonical.startsWith(root + path.sep)) throw new Fault('INVALID_FILE', 400);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Check the opened descriptor, not just the pathname: an agent can rename a directory while we read.
      if (
        process.platform === 'linux' &&
        !(await realpath(`/proc/self/fd/${handle.fd}`)).startsWith(root + path.sep)
      )
        throw new Fault('INVALID_FILE', 400);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        throw new Fault('FILE_NOT_READABLE', 400);
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > limit) throw new Fault('FILE_NOT_READABLE', 400);
      return {
        path: relative,
        name: path.basename(relative),
        size,
        modified: stat.mtime.toISOString(),
        data: buffer.subarray(0, size),
      };
    } finally {
      await handle.close();
    }
  }
}

function directoryPath(handle: FileHandle, fallback: string) {
  return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : fallback;
}
export class WorkspaceDirectory implements TaskDirectory {
  constructor(
    readonly root: string,
    readonly path: string,
    readonly canonical: string,
    private readonly handle: FileHandle,
  ) {}
  async verify() {
    const current = await realpath(directoryPath(this.handle, this.canonical));
    if (
      current !== this.canonical ||
      !current.startsWith(this.root + path.sep) ||
      (await realpath(this.path)) !== this.canonical
    )
      throw new Fault('TASK_DIRECTORY_MOVED');
  }
  async write(name: string, data: string | Buffer, signal?: AbortSignal) {
    if (!isTaskFileName(name)) throw new Fault('INVALID_FILE', 400);
    signal?.throwIfAborted();
    await this.verify();
    const file = await open(
      path.join(directoryPath(this.handle, this.canonical), name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      signal?.throwIfAborted();
      await file.writeFile(data, { signal });
    } finally {
      await file.close();
    }
  }
  async close() {
    await this.handle.close();
  }
}
