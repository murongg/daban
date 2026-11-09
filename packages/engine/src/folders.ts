import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type FolderStatus,
  isFolderStatus,
  type LocalFolder,
  type LocalOperation,
  validAgentId,
} from '@daban/protocol';
import { Fault } from './control.js';

interface Grant extends LocalFolder {
  dev: string;
  ino: string;
  connected: boolean;
}
interface Receipt {
  key: string;
  input: string;
  operation: LocalOperation;
  result?: Record<string, unknown>;
}
interface State {
  version: 1;
  folders: Grant[];
  receipts: Receipt[];
}
interface Run {
  bot: string;
  id: string;
  signal: AbortSignal;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
// Windows file IDs can exceed Number precision; keep them exact for durable grants and race checks.
const stat = (file: string) => lstat(file, { bigint: true });
const identity = (info: Pick<BigIntStats, 'dev' | 'ino'>) => ({
  dev: info.dev.toString(),
  ino: info.ino.toString(),
});
const persistedIdentity = (value: unknown) => {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
};
const revision = (info: BigIntStats) =>
  hash(
    JSON.stringify([
      info.dev.toString(),
      info.ino.toString(),
      info.size.toString(),
      info.mtimeNs.toString(),
      info.ctimeNs.toString(),
      info.mode.toString(),
    ]),
  );
const missing = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const fileLimit = 1024 * 1024;
const fields: Record<string, string[]> = {
  list: ['folder', 'path'],
  read: ['folder', 'path', 'offset', 'limit'],
  search: ['folder', 'pattern', 'query'],
  write: ['folder', 'path', 'content', 'revision'],
  edit: ['folder', 'path', 'oldText', 'newText', 'revision'],
  mkdir: ['folder', 'path'],
  move: ['folder', 'path', 'destination', 'revision'],
  trash: ['folder', 'path', 'revision'],
};
type OpenLocalFile = (file: string, flags: number) => Promise<FileHandle>;

export async function localSnapshot(
  file: string,
  root: string,
  signal: AbortSignal,
  openFile: OpenLocalFile = open,
) {
  signal.throwIfAborted();
  // Windows may ignore O_NOFOLLOW, so bind the open handle to the checked path before reading.
  const before = await stat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new Fault('LOCAL_PATH_DENIED');
  const handle = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    const named = await stat(file);
    const canonical = await realpath(file);
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      named.isSymbolicLink() ||
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      !within(root, canonical)
    )
      throw new Fault('LOCAL_PATH_DENIED');
    signal.throwIfAborted();
    let content: string | undefined;
    if (info.size <= BigInt(fileLimit)) {
      const bytes = await handle.readFile();
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (content.includes('\0')) content = undefined;
      } catch {
        content = undefined;
      }
    }
    const after = await handle.stat({ bigint: true });
    const finalNamed = await stat(file);
    const finalCanonical = await realpath(file);
    if (
      revision(info) !== revision(after) ||
      finalNamed.isSymbolicLink() ||
      finalNamed.ino !== info.ino ||
      finalNamed.dev !== info.dev ||
      !within(root, finalCanonical)
    )
      throw new Fault('LOCAL_FILE_CONFLICT', 409);
    return { info, revision: revision(info), content };
  } finally {
    await handle.close();
  }
}

/** The host owns directory grants. Model tools can use or inspect them, never create them. */
export class Folders {
  private state: State = { version: 1, folders: [], receipts: [] };
  private pending = Promise.resolve();
  private readonly ready: Promise<unknown>;
  private failure?: unknown;
  constructor(
    readonly file: string,
    private denied: string[],
    private readonly live?: (run: Run) => unknown,
  ) {
    // A corrupt optional catalogue must not terminate the host or reset the user's retained records.
    this.ready = this.load().catch((error: unknown) => {
      this.failure = error;
    });
  }
  private async load() {
    this.denied = await Promise.all(
      this.denied.map((root) => realpath(root).catch(() => path.resolve(root))),
    );
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await stat(this.file);
    } catch (error) {
      if (missing(error)) return;
      throw new Fault('LOCAL_FOLDERS_UNAVAILABLE');
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw new Fault('LOCAL_FOLDERS_UNAVAILABLE');
    let handle: FileHandle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Fault('LOCAL_FOLDERS_UNAVAILABLE');
    }
    try {
      const info = await handle.stat({ bigint: true });
      const named = await stat(this.file);
      // The catalogue contains durable grants; never parse data reached through a replaced link.
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        named.isSymbolicLink() ||
        named.dev !== info.dev ||
        named.ino !== info.ino ||
        info.size > 32n * 1024n * 1024n ||
        (process.platform !== 'win32' &&
          (info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o777n) !== 0o600n))
      )
        throw new Error('metadata');
      const value = JSON.parse(await handle.readFile('utf8')) as State;
      if (
        value.version !== 1 ||
        !Array.isArray(value.folders) ||
        !Array.isArray(value.receipts) ||
        value.folders.length > 256 ||
        value.receipts.length > 1000
      )
        throw new Error('metadata');
      const folders = value.folders.map((item) => {
        const dev = persistedIdentity(item.dev);
        const ino = persistedIdentity(item.ino);
        if (
          !dev ||
          !ino ||
          !isFolderStatus({
            bot: item.bot,
            folders: [{ id: item.id, bot: item.bot, name: item.name, path: item.path }],
            operations: [],
          }) ||
          !path.isAbsolute(item.path) ||
          typeof item.connected !== 'boolean'
        )
          throw new Error('metadata');
        return { ...item, dev, ino };
      });
      if (
        value.receipts.some(
          (item) =>
            typeof item.key !== 'string' ||
            typeof item.input !== 'string' ||
            !isFolderStatus({
              bot: item.operation?.bot,
              folders: [],
              operations: [item.operation],
            }),
        )
      )
        throw new Error('metadata');
      this.state = { version: 1, folders, receipts: value.receipts };
    } catch {
      throw new Fault('LOCAL_FOLDERS_UNAVAILABLE');
    } finally {
      await handle.close();
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      await this.ready;
      if (this.failure) throw this.failure;
      return work();
    });
    this.pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  private async save() {
    const encoded = JSON.stringify(this.state);
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Fault('LOCAL_OPERATION_LIMIT');
    const temporary = `${this.file}.${randomUUID()}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }
  private publicFolder({
    dev: _dev,
    ino: _ino,
    connected: _connected,
    ...folder
  }: Grant): LocalFolder {
    return folder;
  }
  status(bot: string): Promise<FolderStatus> {
    return this.enqueue(async () => {
      if (!validAgentId(bot)) throw new Fault('INVALID_LOCAL_FILE_ARGS');
      return {
        bot,
        folders: this.state.folders
          .filter((item) => item.bot === bot && item.connected)
          .map((item) => this.publicFolder(item)),
        operations: this.state.receipts
          .filter((item) => item.operation.bot === bot)
          .slice(-100)
          .reverse()
          .map((item) => structuredClone(item.operation)),
      };
    });
  }
  connect(bot: string, directory: string) {
    return this.enqueue(async () => {
      if (!validAgentId(bot) || !path.isAbsolute(directory) || directory.includes('\0'))
        throw new Fault('LOCAL_PATH_DENIED');
      const canonical = await realpath(directory);
      if (
        canonical === path.parse(canonical).root ||
        canonical === (await realpath(homedir())) ||
        this.denied.some(
          (root) => within(path.resolve(root), canonical) || within(canonical, path.resolve(root)),
        )
      )
        throw new Fault('LOCAL_PATH_DENIED');
      const info = await stat(canonical);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Fault('LOCAL_PATH_DENIED');
      const existing = this.state.folders.find(
        (item) =>
          item.bot === bot &&
          item.path === canonical &&
          item.dev === info.dev.toString() &&
          item.ino === info.ino.toString(),
      );
      if (existing?.connected) {
        await this.root(bot, existing.id);
        return this.publicFolder(existing);
      }
      if (
        this.state.folders.filter((item) => item.bot === bot && item.connected).length >= 32 ||
        this.state.folders.length >= 256
      )
        throw new Fault('LOCAL_FOLDER_LIMIT');
      if (existing) {
        existing.connected = true;
        try {
          await this.save();
        } catch (error) {
          existing.connected = false;
          throw error;
        }
        return this.publicFolder(existing);
      }
      const grant: Grant = {
        id: randomUUID(),
        bot,
        path: canonical,
        name: path.basename(canonical),
        ...identity(info),
        connected: true,
      };
      this.state.folders.push(grant);
      try {
        await this.save();
      } catch (error) {
        this.state.folders.pop();
        throw error;
      }
      return this.publicFolder(grant);
    });
  }
  disconnect(bot: string, id: string) {
    return this.enqueue(async () => {
      const grant = this.state.folders.find((item) => item.bot === bot && item.id === id);
      if (grant?.connected) {
        grant.connected = false;
        try {
          await this.save();
        } catch (error) {
          grant.connected = true;
          throw error;
        }
      }
      return { disconnected: true };
    });
  }
  private async root(bot: string, id: unknown) {
    const grant = this.state.folders.find(
      (item) => item.bot === bot && item.id === id && item.connected,
    );
    if (!grant) throw new Fault('FOLDER_NOT_CONNECTED', 403);
    const info = await stat(grant.path).catch(() => undefined);
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev.toString() !== grant.dev ||
      info.ino.toString() !== grant.ino ||
      (await realpath(grant.path)) !== grant.path
    )
      throw new Fault('LOCAL_FOLDER_CHANGED', 409);
    return grant;
  }
  commandDirectory(bot: string, id: unknown, relative: unknown) {
    return this.enqueue(async () => {
      const grant = await this.root(bot, id);
      const directory = await this.target(grant, relative ?? '', false, true);
      const info = await stat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Fault('LOCAL_PATH_DENIED', 403);
      return { root: grant.path, cwd: directory };
    });
  }
  private async target(grant: Grant, value: unknown, create = false, rootAllowed = false) {
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      value.includes('\0') ||
      value.includes('\\') ||
      path.isAbsolute(value) ||
      /^[a-z]:/i.test(value) ||
      value
        .split('/')
        .some((part) => part === '..' || part === '.daban-trash' || part.includes(':'))
    )
      throw new Fault('LOCAL_PATH_DENIED', 403);
    const pieces = value.split('/').filter((part) => part && part !== '.');
    if (!rootAllowed && !pieces.length) throw new Fault('LOCAL_PATH_DENIED', 403);
    let current = grant.path;
    for (let index = 0; index < pieces.length; index++) {
      current = path.join(current, pieces[index]);
      if (this.denied.some((root) => within(path.resolve(root), current)))
        throw new Fault('LOCAL_PATH_DENIED', 403);
      const info = await stat(current).catch((error) => {
        if (missing(error) && create && index === pieces.length - 1) return undefined;
        throw error;
      });
      if (
        info &&
        (info.isSymbolicLink() ||
          (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n)) ||
          (index < pieces.length - 1 && !info.isDirectory()))
      )
        throw new Fault('LOCAL_PATH_DENIED', 403);
    }
    await this.root(grant.bot, grant.id);
    return current;
  }
  private snapshot(file: string, root: Grant, signal: AbortSignal) {
    return localSnapshot(file, root.path, signal, async (target, flags) => {
      const handle = await open(target, flags);
      try {
        await this.root(root.bot, root.id);
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    });
  }
  private check(run: Run) {
    run.signal.throwIfAborted();
    this.live?.(run);
  }
  invoke(
    run: Run,
    action: string,
    args: Record<string, unknown>,
    request: string,
  ): Promise<Record<string, unknown>> {
    const owner = { bot: run.bot, id: run.id, signal: run.signal };
    const input = structuredClone(args);
    return this.enqueue(() => this.perform(owner, action, input, request));
  }
  private async perform(
    run: Run,
    action: string,
    args: Record<string, unknown>,
    request: string,
  ): Promise<Record<string, unknown>> {
    this.check(run);
    const allowed = fields[action];
    if (
      !validAgentId(run.bot) ||
      !validAgentId(run.id) ||
      !allowed ||
      Object.keys(args).some((key) => !allowed.includes(key))
    )
      throw new Fault('INVALID_LOCAL_FILE_ARGS', 400);
    const grant = await this.root(run.bot, args.folder);
    const mutation = !['list', 'read', 'search'].includes(action);
    const key = hash(JSON.stringify([run.bot, run.id, request]));
    const input = hash(JSON.stringify([action, ...allowed.map((field) => args[field])]));
    if (mutation) {
      const previous = this.state.receipts.find((item) => item.key === key);
      if (previous) {
        if (previous.input !== input) throw new Fault('LOCAL_REQUEST_CONFLICT', 409);
        if (!previous.result) throw new Fault('LOCAL_OUTCOME_UNKNOWN', 409);
        return structuredClone(previous.result);
      }
    }
    if (action === 'search') return this.search(run, grant, args);
    const file = await this.target(
      grant,
      args.path ?? '',
      ['write', 'mkdir'].includes(action),
      action === 'list',
    );
    this.check(run);
    if (action === 'list') {
      const entries = await readdir(file, { withFileTypes: true });
      const items = [];
      for (const entry of entries.slice(0, 500)) {
        this.check(run);
        if (entry.name === '.daban-trash' || entry.isSymbolicLink()) continue;
        const full = path.join(file, entry.name);
        const info = await stat(full);
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n)))
          continue;
        items.push({
          path: path.relative(grant.path, full).split(path.sep).join('/'),
          kind: info.isDirectory() ? 'directory' : 'file',
          size: Number(info.size),
          revision: revision(info),
        });
      }
      await this.target(grant, args.path ?? '', false, true);
      return { items, truncated: entries.length > 500 };
    }
    const existing = await stat(file).catch((error) => {
      if (missing(error)) return undefined;
      throw error;
    });
    const original = existing?.isFile() ? await this.snapshot(file, grant, run.signal) : undefined;
    if (action === 'read') {
      if (!original) throw new Fault('LOCAL_FILE_REQUIRED');
      if (original.content === undefined)
        throw new Fault(
          existing!.size > BigInt(fileLimit) ? 'LOCAL_FILE_TOO_LARGE' : 'LOCAL_FILE_BINARY',
        );
      const offset = args.offset ?? 0,
        limit = args.limit ?? 16000;
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > original.content.length ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 64000
      )
        throw new Fault('INVALID_LOCAL_FILE_ARGS');
      await this.target(grant, args.path);
      this.check(run);
      const end = Math.min(original.content.length, Number(offset) + Number(limit));
      return {
        path: args.path,
        revision: original.revision,
        content: original.content.slice(Number(offset), end),
        totalChars: original.content.length,
        ...(end < original.content.length ? { nextOffset: end } : {}),
      };
    }
    if (
      action !== 'mkdir' &&
      (action === 'write' && args.revision === null
        ? !!existing
        : !original || args.revision !== original.revision)
    )
      throw new Fault('LOCAL_FILE_CONFLICT', 409);
    if (action === 'mkdir' && existing) throw new Fault('LOCAL_FILE_CONFLICT', 409);
    let content: string | undefined;
    if (action === 'write' || action === 'edit') {
      if (action === 'edit') {
        if (
          original?.content === undefined ||
          typeof args.oldText !== 'string' ||
          !args.oldText ||
          typeof args.newText !== 'string'
        )
          throw new Fault('INVALID_LOCAL_FILE_ARGS');
        const index = original.content.indexOf(args.oldText);
        if (index < 0 || original.content.indexOf(args.oldText, index + 1) >= 0)
          throw new Fault('LOCAL_EDIT_AMBIGUOUS');
        content =
          original.content.slice(0, index) +
          args.newText +
          original.content.slice(index + args.oldText.length);
      } else content = typeof args.content === 'string' ? args.content : undefined;
      if (content === undefined || content.includes('\0') || Buffer.byteLength(content) > fileLimit)
        throw new Fault('INVALID_LOCAL_FILE_ARGS');
    }
    let destination: string | undefined;
    if (action === 'move') {
      destination = await this.target(grant, args.destination, true);
      if (
        await stat(destination).then(
          () => true,
          (error) => {
            if (missing(error)) return false;
            throw error;
          },
        )
      )
        throw new Fault('LOCAL_FILE_CONFLICT');
    }
    if (this.state.receipts.length >= 1000) throw new Fault('LOCAL_OPERATION_LIMIT');
    const operation: LocalOperation = {
      id: randomUUID(),
      folder: grant.id,
      bot: run.bot,
      kind: action as LocalOperation['kind'],
      path: String(args.path),
      ...(action === 'move' ? { destination: String(args.destination) } : {}),
      state: 'unknown',
      at: new Date().toISOString(),
      ...(original?.content !== undefined && original.content.length <= 16000
        ? { before: original.content }
        : {}),
      ...(content !== undefined && content.length <= 16000 ? { after: content } : {}),
    };
    const receipt: Receipt = { key, input, operation };
    // Persist intent before any effect. A crash or lost acknowledgement must never cause an automatic replay.
    this.state.receipts.push(receipt);
    await this.save();
    this.check(run);
    await this.target(grant, args.path, ['write', 'mkdir'].includes(action));
    if (original && revision(await stat(file)) !== original.revision)
      throw new Fault('LOCAL_FILE_CONFLICT', 409);
    if (action === 'mkdir') await mkdir(file, { mode: 0o755 });
    else if (action === 'write' || action === 'edit') {
      const temporary = path.join(path.dirname(file), `.daban-write-${randomUUID()}`);
      const output = await open(
        temporary,
        'wx',
        original ? Number(original.info.mode & 0o777n) : 0o644,
      );
      try {
        await output.writeFile(content!, 'utf8');
        await output.sync();
      } finally {
        await output.close();
      }
      try {
        this.check(run);
        await this.target(grant, args.path, true);
        if (original) {
          if (revision(await stat(file)) !== original.revision)
            throw new Fault('LOCAL_FILE_CONFLICT', 409);
          await rename(temporary, file);
        } else {
          await link(temporary, file);
          await unlink(temporary);
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (!missing(error)) throw error;
        });
      }
    } else if (action === 'move') await this.move(file, destination!, original!.info);
    else if (action === 'trash') {
      const trash = await this.trash(grant);
      await this.move(file, path.join(trash, operation.id), original!.info);
    }
    operation.state = 'complete';
    receipt.result = {
      operation: operation.id,
      path: args.path,
      ...(destination ? { destination: args.destination } : {}),
      state: 'complete',
    };
    await this.save();
    return structuredClone(receipt.result);
  }
  private async trash(grant: Grant) {
    await this.root(grant.bot, grant.id);
    const directory = path.join(grant.path, '.daban-trash');
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error;
    });
    const info = await stat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Fault('LOCAL_PATH_DENIED');
    return directory;
  }
  private async move(source: string, destination: string, expected: BigIntStats) {
    // link is an atomic no-overwrite claim; rename would silently replace an existing destination.
    await link(source, destination);
    const current = await stat(source),
      target = await stat(destination),
      expectedIdentity = identity(expected);
    if (
      current.ino.toString() !== expectedIdentity.ino ||
      current.dev.toString() !== expectedIdentity.dev ||
      target.ino.toString() !== expectedIdentity.ino ||
      target.dev.toString() !== expectedIdentity.dev ||
      target.isSymbolicLink()
    )
      throw new Fault('LOCAL_OUTCOME_UNKNOWN');
    await unlink(source);
  }
  restore(bot: string, id: string) {
    return this.enqueue(async () => {
      const receipt = this.state.receipts.find(
        (item) =>
          item.operation.id === id && item.operation.bot === bot && item.operation.kind === 'trash',
      );
      if (!receipt || receipt.operation.state === 'unknown')
        throw new Fault('LOCAL_OUTCOME_UNKNOWN');
      const grant = await this.root(bot, receipt.operation.folder);
      if (receipt.operation.state === 'restored') return { restored: true };
      const destination = await this.target(grant, receipt.operation.path, true);
      const source = path.join(await this.trash(grant), id);
      const info = await stat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
        throw new Fault('LOCAL_PATH_DENIED');
      await this.move(source, destination, info);
      receipt.operation.state = 'restored';
      await this.save();
      return { restored: true };
    });
  }
  private async search(run: Run, grant: Grant, args: Record<string, unknown>) {
    if (
      (args.pattern !== undefined &&
        (typeof args.pattern !== 'string' ||
          args.pattern.length > 200 ||
          args.pattern.includes('..') ||
          args.pattern.includes('\\'))) ||
      (args.query !== undefined &&
        (typeof args.query !== 'string' || !args.query || args.query.length > 200))
    )
      throw new Fault('INVALID_LOCAL_FILE_ARGS');
    const pattern = typeof args.pattern === 'string' ? args.pattern : '**/*';
    const items: { path: string; line?: number; text?: string }[] = [];
    const pending = [''];
    let scanned = 0,
      bytes = 0,
      truncated = false;
    while (pending.length && !truncated) {
      const relative = pending.pop()!;
      const directory = await this.target(grant, relative, false, true);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        this.check(run);
        if (++scanned > 10000 || items.length >= 100 || bytes > 16 * fileLimit) {
          truncated = true;
          break;
        }
        if (
          entry.isSymbolicLink() ||
          ['.git', 'node_modules', '.daban-trash'].includes(entry.name) ||
          entry.name.startsWith('.daban-write-')
        )
          continue;
        const candidate = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (!entry.isFile() || !path.matchesGlob(candidate, pattern)) continue;
        let file: string;
        try {
          file = await this.target(grant, candidate);
        } catch {
          continue;
        }
        if (args.query === undefined) {
          items.push({ path: candidate });
          continue;
        }
        const value = await this.snapshot(file, grant, run.signal);
        bytes += Number(value.info.size);
        if (value.content === undefined) continue;
        const lines = value.content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (lines[index].includes(String(args.query)))
            items.push({ path: candidate, line: index + 1, text: lines[index].slice(0, 1000) });
          if (items.length >= 100) {
            truncated = true;
            break;
          }
        }
      }
    }
    this.check(run);
    await this.root(run.bot, grant.id);
    return { items, truncated };
  }
}
