import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Legacy Linux composition keeps its default; host applications always supply their bundled SDK.
export const defaultSdkFile =
  '/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js';

export function runtimeRequire(sdkFile: string) {
  return createRequire(createRequire(sdkFile).resolve('@deepseek-ai/dsh/package.json'));
}

export const startupLogLimit = 512 * 1024;
export const startupSnapshotLimit = 64 * 1024;

export class DshLog {
  private pending = Promise.resolve(true);
  constructor(readonly file: string) {}

  write(entry: Record<string, unknown>, clean: (text: string) => string) {
    const operation = this.pending.then(() => this.append(entry, clean));
    this.pending = operation;
    return operation;
  }

  private async append(entry: Record<string, unknown>, clean: (text: string) => string) {
    try {
      const encode = (value: object) =>
        JSON.stringify(value, (_key, value: unknown) =>
          typeof value === 'string'
            ? clean(value).replace(/data:[^\s"'<>]+/g, '[inline module redacted]')
            : value,
        ) + '\n';
      const time = new Date().toISOString();
      let line = encode({ ...entry, time });
      if (Buffer.byteLength(line) > startupSnapshotLimit)
        line = encode({
          time,
          stage: String(entry.stage ?? '').slice(0, 64),
          runId: String(entry.runId ?? '').slice(0, 256),
          bot: String(entry.bot ?? '').slice(0, 128),
          error: clean(String(entry.error ?? '')).slice(0, 4096),
          truncated: true,
        });
      const paths = [this.file, this.file + '.1', this.file + '.2'];
      const entries = await Promise.all(
        paths.map(async (file) => {
          try {
            return await lstat(file);
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
              return undefined;
            throw error;
          }
        }),
      );
      if (
        entries.some(
          (info) => info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1),
        )
      )
        return false;
      for (let index = 0; index < paths.length; index++)
        if ((entries[index]?.size ?? 0) > startupLogLimit) {
          await unlink(paths[index]);
          entries[index] = undefined;
        }
      // One ModelRuns owner serializes all Bots; rotate before append so the hard byte budget is never exceeded.
      if ((entries[0]?.size ?? 0) + Buffer.byteLength(line) > startupLogLimit) {
        if (entries[2]) await unlink(paths[2]);
        if (entries[1]) await rename(paths[1], paths[2]);
        if (entries[0]) await rename(paths[0], paths[1]);
      }
      const handle = await open(
        this.file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size + Buffer.byteLength(line) > startupLogLimit
        )
          return false;
        await handle.chmod(0o600);
        await handle.writeFile(line);
      } finally {
        await handle.close();
      }
      return true;
    } catch {
      return false;
    }
  }
}

export async function readDshStartup(file: string): Promise<unknown> {
  try {
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > startupSnapshotLimit
    )
      return undefined;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > startupSnapshotLimit ||
        info.ino !== before.ino ||
        info.dev !== before.dev
      )
        return undefined;
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const record = value as Record<string, unknown>;
      if (!['node-started', 'waiting-initialize', 'initialized'].includes(String(record.stage)))
        return undefined;
      // A checkpoint is not a general JSON attachment: do not ingest environment/configuration or RPC bodies.
      const snapshot: Record<string, unknown> = {};
      for (const key of ['stage', 'startedAt', 'entry', 'stderr'])
        if (typeof record[key] === 'string') snapshot[key] = record[key];
      for (const key of ['pid', 'parentPid', 'elapsedMs', 'exitCode'])
        if (typeof record[key] === 'number' && Number.isFinite(record[key]))
          snapshot[key] = record[key];
      if (Array.isArray(record.resources))
        snapshot.resources = record.resources
          .filter((value) => typeof value === 'string')
          .slice(-32);
      snapshot.truncated = record.truncated === true;
      if (record.exception && typeof record.exception === 'object') {
        const exception = record.exception as Record<string, unknown>;
        snapshot.exception = Object.fromEntries(
          ['name', 'message', 'stack']
            .filter((key) => typeof exception[key] === 'string')
            .map((key) => [key, exception[key]]),
        );
      }
      return snapshot;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
