import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isTaskFileName, validAgentId } from '@daban/protocol';
import { Fault } from './control.js';
import { type AgentWorkspace, type TaskDirectory, WorkspaceFiles } from './workspace.js';

// Native-only agents expose no model shell/file tools. This private scratch area holds explicit task inputs.
export class NativeWorkspace implements AgentWorkspace {
  canonical: string | null;
  private readonly files: WorkspaceFiles;
  constructor(
    readonly root: string,
    expectedRoot?: string,
  ) {
    this.canonical = expectedRoot ?? null;
    this.files = new WorkspaceFiles(root, expectedRoot);
    this.files.base = () => this.base();
  }
  async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return this.base();
  }
  async list() {
    return (await this.files.list()).map((file) => ({
      ...file,
      path: file.path.split(path.sep).join('/'),
    }));
  }
  read(relative: string, limit?: number) {
    return this.files.read(relative, limit);
  }
  download(relative: string) {
    return this.files.download(relative);
  }
  async base() {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Fault('WORKSPACE_MOVED');
    const value = await realpath(this.root);
    if (this.canonical && this.canonical !== value) throw new Fault('WORKSPACE_MOVED');
    this.canonical = value;
    return value;
  }
  scope(root: string, canonical?: string): AgentWorkspace {
    return new NativeWorkspace(root, canonical);
  }
  async create(parts: string[]): Promise<TaskDirectory> {
    if (
      !parts.length ||
      !parts.every(
        (part) =>
          validAgentId(part) &&
          !/[<>:"|?*]/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
    )
      throw new Fault('INVALID_FILE');
    const root = await this.base();
    let directory = root;
    for (const part of parts) {
      directory = path.join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(directory);
      const canonical = await realpath(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !canonical.startsWith(root + path.sep))
        throw new Fault('TASK_DIRECTORY_MOVED');
    }
    const canonical = await realpath(directory),
      identity = await lstat(directory);
    const verify = async () => {
      const now = await lstat(directory);
      if (
        !now.isDirectory() ||
        now.isSymbolicLink() ||
        now.ino !== identity.ino ||
        now.dev !== identity.dev ||
        (await realpath(directory)) !== canonical ||
        (await this.base()) !== root
      )
        throw new Fault('TASK_DIRECTORY_MOVED');
    };
    return {
      root,
      path: directory,
      canonical,
      verify,
      close: async () => {},
      write: async (name, data, signal) => {
        if (
          !isTaskFileName(name) ||
          /[<>:"|?*]/.test(name) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
        )
          throw new Fault('INVALID_FILE');
        await verify();
        signal?.throwIfAborted();
        const target = path.join(directory, name),
          file = await open(target, 'wx', 0o600);
        try {
          await verify();
          const info = await file.stat(),
            named = await lstat(target);
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            named.ino !== info.ino ||
            named.dev !== info.dev ||
            named.isSymbolicLink()
          )
            throw new Fault('INVALID_FILE');
          signal?.throwIfAborted();
          await file.writeFile(data);
        } finally {
          await file.close();
        }
      },
    };
  }
}
