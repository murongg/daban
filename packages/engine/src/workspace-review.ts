import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  compareReviewPaths,
  isReviewCapture,
  isReviewSelection,
  type ReviewArea,
  type ReviewCapture,
  type ReviewFile,
  type ReviewReason,
  reviewFileKey,
  reviewLimits,
  safeRuntimePath,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';

export interface ReviewReadHooks {
  afterOpen?(relative: string, handle: FileHandle): Promise<unknown>;
}

export function checkedReviewCapture(value: unknown): ReviewCapture {
  if (!isReviewCapture(value)) throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
  const files = new Map(value.files.map((file) => [reviewFileKey(file), file]));
  for (const text of value.texts) {
    const file = files.get(reviewFileKey(text));
    if (
      file?.state !== 'present' ||
      createHash('sha256').update(Buffer.from(text.data, 'base64')).digest('hex') !== file.sha256
    )
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
  }
  return value;
}

export function unavailableReviewCapture(area: ReviewArea, reason: ReviewReason): ReviewCapture {
  const at = new Date().toISOString();
  return {
    snapshot: {
      area,
      startedAt: at,
      endedAt: at,
      capture: 'unknown',
      reasons: [reason],
      omitted: 0,
    },
    files: [],
    texts: [],
  };
}

class CaptureStop extends Error {
  constructor(readonly reason: ReviewReason) {
    super(reason);
  }
}
const identity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const directoryPath = (handle: FileHandle, fallback: string) =>
  process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : fallback;
const excluded = (name: string) =>
  name === '.git' || name.startsWith('.skills-') || name.startsWith('.browser-download-');
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export async function captureWorkspaceReview(
  root: string,
  canonical: string,
  paths?: string[],
  signal?: AbortSignal,
  hooks?: ReviewReadHooks,
): Promise<ReviewCapture> {
  if (paths !== undefined && (!isReviewSelection({ sharedPaths: paths }) || paths.length === 0))
    throw new Fault('INVALID_FILE', 400);
  const area: ReviewArea = paths === undefined ? 'task' : 'shared';
  // Pathname identity rechecks cannot replace open-directory resolution when an ancestor is swapped back.
  if (process.platform !== 'linux') return unavailableReviewCapture(area, 'unsupported');
  const startedAt = new Date().toISOString();
  const deadline = performance.now() + reviewLimits.milliseconds;
  const result: ReviewCapture = {
    snapshot: { area, startedAt, endedAt: startedAt, capture: 'complete', reasons: [], omitted: 0 },
    files: [],
    texts: [],
  };
  const reasons = new Set<ReviewReason>();
  let visited = 0;
  let hashBytes = 0;
  let textBytes = 0;
  let serializedBytes = 4096;
  let rootHandle: FileHandle | undefined;
  let rootIdentity: BigIntStats | undefined;
  let stopped = false;
  const note = (reason: ReviewReason, omitted = 0) => {
    reasons.add(reason);
    result.snapshot.omitted += omitted;
  };
  const check = () => {
    if (signal?.aborted) throw new CaptureStop('cancelled');
    if (performance.now() >= deadline) throw new CaptureStop('time-limit');
  };
  const record = (file: ReviewFile, data?: string) => {
    const text = data === undefined ? undefined : { area, path: file.path, data };
    const bytes =
      Buffer.byteLength(JSON.stringify(file)) +
      (text ? Buffer.byteLength(JSON.stringify(text)) : 0) +
      2;
    if (serializedBytes + bytes > reviewLimits.responseBytes) {
      note('size-limit', 1);
      throw new CaptureStop('size-limit');
    }
    serializedBytes += bytes;
    result.files.push(file);
    if (text) result.texts.push(text);
  };
  const unknown = (relative: string, reason: ReviewReason, bytes?: number) => {
    note(reason);
    record({
      area,
      path: relative,
      state: 'unknown',
      reason,
      ...(bytes === undefined ? {} : { bytes }),
    });
  };
  const invalidate = (relative: string, reason: ReviewReason) => {
    note(reason);
    const within = (name: string) => !relative || name.startsWith(`${relative}/`);
    result.files = result.files.map((file) =>
      within(file.path) ? { area, path: file.path, state: 'unknown', reason } : file,
    );
    result.texts = result.texts.filter((file) => !within(file.path));
  };
  const rootValid = async () => {
    if (!rootHandle || !rootIdentity) return false;
    try {
      return (
        (await realpath(root)) === canonical &&
        identity(rootIdentity, await rootHandle.stat({ bigint: true })) &&
        identity(rootIdentity, await lstat(root, { bigint: true })) &&
        (process.platform !== 'linux' ||
          (await realpath(directoryPath(rootHandle, canonical))) === canonical)
      );
    } catch {
      return false;
    }
  };
  const verify = async (handle: FileHandle, named: string, before: BigIntStats) => {
    const after = await handle.stat({ bigint: true });
    const current = await lstat(named, { bigint: true });
    if (!identity(before, after) || !identity(after, current) || current.isSymbolicLink())
      throw new CaptureStop('unstable');
    if (process.platform === 'linux') {
      const actual = await realpath(directoryPath(handle, named));
      if (actual !== canonical && !actual.startsWith(canonical + path.sep))
        throw new CaptureStop('root-moved');
    }
  };
  const readFile = async (
    parent: FileHandle,
    directory: string,
    name: string,
    relative: string,
  ) => {
    check();
    const named = path.join(directoryPath(parent, directory), name);
    let handle: FileHandle | undefined;
    try {
      const before = await lstat(named, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        unknown(relative, 'permission');
        return;
      }
      const size = Number(before.size);
      if (
        !Number.isSafeInteger(size) ||
        size > reviewLimits.fileBytes ||
        hashBytes + size > reviewLimits.hashBytes
      ) {
        unknown(relative, 'size-limit', Number.isSafeInteger(size) ? size : undefined);
        return;
      }
      // O_NONBLOCK prevents a raced FIFO replacement from hanging before fstat can reject it.
      handle = await open(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !identity(before, opened))
        throw new CaptureStop('unstable');
      await verify(handle, named, opened);
      await hooks?.afterOpen?.(relative, handle);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      const retainText =
        size <= reviewLimits.textBytes && textBytes + size <= reviewLimits.totalTextBytes;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        check();
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, reviewLimits.fileBytes - bytes + 1),
          bytes,
        );
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        hashBytes += read.bytesRead;
        // A growing file is already unstable; never retain buffers beyond its bounded initial size.
        if (bytes > size) throw new CaptureStop('unstable');
        if (bytes > reviewLimits.fileBytes || hashBytes > reviewLimits.hashBytes)
          throw new CaptureStop('size-limit');
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        if (retainText) chunks.push(Buffer.from(chunk));
      }
      check();
      await verify(handle, named, opened);
      if (bytes !== size) throw new CaptureStop('unstable');
      let data: string | undefined;
      if (retainText) {
        const content = Buffer.concat(chunks);
        if (!content.includes(0)) {
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(content);
            data = content.toString('base64');
          } catch {
            /* Invalid UTF-8 is binary evidence, not replacement-character text. */
          }
        }
      } else note('text-limit');
      record(
        {
          area,
          path: relative,
          state: 'present',
          bytes,
          sha256: hash.digest('hex'),
          text: data !== undefined,
        },
        data,
      );
      if (data !== undefined) textBytes += bytes;
    } catch (error) {
      if (
        error instanceof CaptureStop &&
        ['cancelled', 'time-limit', 'size-limit'].includes(error.reason)
      )
        throw error;
      if (errorCode(error) === 'ENOENT') record({ area, path: relative, state: 'absent' });
      else unknown(relative, error instanceof CaptureStop ? error.reason : 'permission');
    } finally {
      await handle?.close();
    }
  };
  const walk = async (
    handle: FileHandle,
    directory: string,
    relative: string,
    depth: number,
  ): Promise<unknown> => {
    check();
    const before = await handle.stat({ bigint: true });
    const entries = await opendir(directoryPath(handle, directory), { bufferSize: 32 });
    try {
      for (;;) {
        check();
        const entry = await entries.read();
        if (!entry) break;
        if (visited >= reviewLimits.entries) {
          note('entry-limit', 1);
          stopped = true;
          break;
        }
        visited++;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (excluded(entry.name)) {
          note('excluded', 1);
          continue;
        }
        if (!safeRuntimePath(name)) {
          note('entry-limit', 1);
          continue;
        }
        const named = path.join(directoryPath(handle, directory), entry.name);
        let child: FileHandle | undefined;
        try {
          const info = await lstat(named, { bigint: true });
          if (info.isDirectory() && !info.isSymbolicLink()) {
            if (depth >= reviewLimits.depth) {
              note('entry-limit', 1);
              continue;
            }
            child = await open(named, directoryFlags);
            if (!identity(info, await child.stat({ bigint: true })))
              throw new CaptureStop('unstable');
            await walk(child, path.join(directory, entry.name), name, depth + 1);
            await verify(child, named, info);
          } else await readFile(handle, directory, entry.name, name);
        } catch (error) {
          if (
            error instanceof CaptureStop &&
            ['cancelled', 'time-limit', 'size-limit'].includes(error.reason)
          )
            throw error;
          note(error instanceof CaptureStop ? error.reason : 'permission', 1);
          invalidate(name, 'unstable');
        } finally {
          await child?.close();
        }
        if (stopped) break;
      }
    } finally {
      await entries.close();
    }
    try {
      await verify(handle, directory, before);
    } catch {
      invalidate(relative, 'unstable');
    }
    return undefined;
  };
  const selectedFile = async (relative: string) => {
    let parent = rootHandle!;
    let directory = canonical;
    const chain: { handle: FileHandle; named: string; info: BigIntStats }[] = [];
    const parts = relative.split('/');
    const name = parts.pop()!;
    if (parts.length > reviewLimits.depth) {
      unknown(relative, 'entry-limit');
      return;
    }
    try {
      for (const part of parts) {
        check();
        if (excluded(part)) {
          unknown(relative, 'excluded');
          return;
        }
        const named = path.join(directoryPath(parent, directory), part);
        const info = await lstat(named, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) {
          unknown(relative, 'permission');
          return;
        }
        const child = await open(named, directoryFlags);
        chain.push({ handle: child, named, info });
        if (!identity(info, await child.stat({ bigint: true }))) throw new CaptureStop('unstable');
        directory = path.join(directory, part);
        parent = child;
      }
      if (excluded(name)) unknown(relative, 'excluded');
      else await readFile(parent, directory, name, relative);
      for (const item of chain) await verify(item.handle, item.named, item.info);
    } catch (error) {
      if (
        error instanceof CaptureStop &&
        ['cancelled', 'time-limit', 'size-limit'].includes(error.reason)
      )
        throw error;
      result.files = result.files.filter((file) => file.path !== relative);
      result.texts = result.texts.filter((file) => file.path !== relative);
      if (errorCode(error) === 'ENOENT') record({ area, path: relative, state: 'absent' });
      else unknown(relative, error instanceof CaptureStop ? error.reason : 'permission');
    } finally {
      for (const item of chain.reverse()) await item.handle.close();
    }
  };
  try {
    check();
    rootHandle = await open(root, directoryFlags);
    rootIdentity = await rootHandle.stat({ bigint: true });
    if (
      (await realpath(root)) !== canonical ||
      (await realpath(directoryPath(rootHandle, canonical))) !== canonical
    )
      throw new CaptureStop('root-moved');
    if (paths) {
      for (const relative of [...paths].sort(compareReviewPaths)) await selectedFile(relative);
    } else await walk(rootHandle, canonical, '', 0);
    check();
  } catch (error) {
    note(
      error instanceof CaptureStop
        ? error.reason
        : errorCode(error) === 'ENOENT'
          ? 'root-moved'
          : 'permission',
      1,
    );
    stopped = true;
  } finally {
    if (rootHandle && !(await rootValid())) invalidate('', 'root-moved');
    await rootHandle?.close();
  }
  if (paths && stopped) {
    const seen = new Set(result.files.map((file) => file.path));
    for (const relative of paths)
      if (!seen.has(relative))
        unknown(
          relative,
          reasons.has('cancelled')
            ? 'cancelled'
            : reasons.has('time-limit')
              ? 'time-limit'
              : 'baseline-missing',
        );
  }
  result.files.sort((a, b) => compareReviewPaths(reviewFileKey(a), reviewFileKey(b)));
  result.texts.sort((a, b) => compareReviewPaths(reviewFileKey(a), reviewFileKey(b)));
  result.snapshot.reasons = [...reasons];
  result.snapshot.capture = reasons.size
    ? result.files.some((file) => file.state === 'present')
      ? 'partial'
      : stopped
        ? 'unknown'
        : 'partial'
    : 'complete';
  result.snapshot.endedAt = new Date().toISOString();
  return checkedReviewCapture(result);
}
