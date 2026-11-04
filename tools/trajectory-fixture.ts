import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Artifact,
  type Json,
  ModelRuns,
  ModelSettings,
  type Terminal,
  type TrajectoryCapture,
  type TrajectoryCase,
  validateTrajectoryCase,
} from '@daban/engine/agent';
import {
  isTranscriptContent,
  isTranscriptPage,
  sameTranscriptScope,
  type TranscriptContent,
  type TranscriptPage,
  type TranscriptScope,
} from '@daban/protocol';

const artifactLimit = 1024 * 1024;
const bodyLimit = 8 * 1024 * 1024;
const itemLimit = 1000;

function relativePath(relative: string) {
  return (
    !!relative &&
    !relative.includes('\0') &&
    !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) &&
    !path.win32.isAbsolute(relative) &&
    relative.split('/').every((part) => !!part && !['.', '..'].includes(part))
  );
}

function unchanged(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

async function readBounded(handle: FileHandle) {
  const buffer = Buffer.alloc(artifactLimit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export async function readTrajectoryArtifact(
  root: string,
  relative: string,
  read: (handle: FileHandle) => Promise<Buffer> = readBounded,
): Promise<Artifact> {
  const unknown = (reason: 'missing' | 'changed' | 'unsafe' | 'too-large'): Artifact => ({
    path: relative,
    state: 'unknown',
    reason,
  });
  if (!relativePath(relative)) return unknown('unsafe');
  let handle: FileHandle | undefined;
  try {
    const parents: { directory: string; stat: BigIntStats }[] = [];
    const segments = relative.split('/');
    let directory = root;
    for (let index = 0; index < segments.length; index++) {
      const stat = await lstat(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unknown('unsafe');
      parents.push({ directory, stat });
      directory = path.join(directory, segments[index]);
    }
    const file = path.join(root, ...segments);
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      return unknown('unsafe');
    if (before.size > BigInt(artifactLimit)) return unknown('too-large');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !unchanged(before, opened)) return unknown('changed');
    const bytes = await read(handle);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    // A pathname or same-sized rewrite cannot certify bytes read through a different file identity.
    if (
      !unchanged(opened, after) ||
      !unchanged(opened, current) ||
      BigInt(bytes.length) !== opened.size
    )
      return unknown('changed');
    if (bytes.length > artifactLimit) return unknown('too-large');
    for (const parent of parents) {
      const stat = await lstat(parent.directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !unchanged(parent.stat, stat))
        return unknown('changed');
    }
    return {
      path: relative,
      state: 'verified',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return unknown(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unsafe');
  } finally {
    await handle?.close();
  }
}

export async function collectTrajectoryArtifacts(root: string, expected: readonly string[]) {
  const paths = new Set(expected);
  let complete = true;
  let directories = 0;
  const visit = async (relative: string) => {
    if (++directories > itemLimit) {
      complete = false;
      return;
    }
    const directory = relative ? path.join(root, relative) : root;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      complete = false;
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(name);
      else paths.add(name);
      if (paths.size > 64) {
        complete = false;
        return;
      }
    }
  };
  try {
    await visit('');
  } catch {
    complete = false;
  }
  const artifacts: Artifact[] = [];
  for (const relative of [...paths].sort().slice(0, 64))
    artifacts.push(await readTrajectoryArtifact(root, relative));
  return { artifacts, complete };
}

function aliases(spec: TrajectoryCase) {
  const declared = new Map(spec.rules.map((rule) => [rule.alias, rule.kind]));
  const visit = (value: Json) => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return;
      const match = /^\$\{([A-Za-z0-9_-]+)\}(.*)$/.exec(value);
      if (
        !match ||
        !declared.has(match[1]) ||
        (match[2] && (declared.get(match[1]) !== 'workspace' || !match[2].startsWith('/'))) ||
        match[2].includes('${') ||
        (match[2] && !relativePath(match[2].slice(1)))
      )
        throw new Error('TRAJECTORY_INVALID_ALIAS');
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const event of spec.input.events) if (event.kind === 'call') visit(event.args);
  return declared;
}

function expand(value: Json, bindings: Record<string, string>): Json {
  if (typeof value === 'string') {
    const match = /^\$\{([A-Za-z0-9_-]+)\}(.*)$/.exec(value);
    return match ? bindings[match[1]] + match[2] : value;
  }
  if (Array.isArray(value)) return value.map((entry) => expand(entry, bindings));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expand(entry, bindings)]),
    );
  return value;
}

function terminal(value: string | undefined): value is Terminal {
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(value ?? '');
}

async function captureTranscript(models: ModelRuns, scope: TranscriptScope) {
  const pages: TranscriptPage[] = [];
  const contents: TranscriptContent[] = [];
  let complete = true;
  let after = 0;
  let items = 0;
  let characters = 0;
  try {
    for (;;) {
      const page = await models.transcript(scope, after);
      if (items + page.items.length > itemLimit) {
        complete = false;
        break;
      }
      pages.push(page);
      items += page.items.length;
      if (!isTranscriptPage(page) || !sameTranscriptScope(page, scope)) {
        complete = false;
        break;
      }
      for (const item of page.items) {
        if (!['call', 'result', 'interaction'].includes(item.kind)) continue;
        let offset = 0;
        for (;;) {
          const content = await models.transcriptContent(scope, item.seq, offset);
          if (characters + content.text.length > bodyLimit) {
            complete = false;
            break;
          }
          contents.push(content);
          characters += content.text.length;
          if (
            !isTranscriptContent(content) ||
            !sameTranscriptScope(content, scope) ||
            content.offset !== offset
          ) {
            complete = false;
            break;
          }
          if (content.nextOffset === undefined) break;
          // The protocol uses UTF-16 offsets; converting to bytes here would skip emoji halves.
          if (content.nextOffset <= offset) {
            complete = false;
            break;
          }
          offset = content.nextOffset;
        }
        if (!complete) break;
      }
      if (!complete || page.nextAfter === undefined) break;
      if (page.nextAfter <= after) {
        complete = false;
        break;
      }
      after = page.nextAfter;
    }
  } catch {
    complete = false;
  }
  return { pages, contents, complete };
}

export async function runTrajectoryFixture(
  spec: TrajectoryCase,
  options: { signal?: AbortSignal } = {},
): Promise<TrajectoryCapture> {
  validateTrajectoryCase(spec);
  const declared = aliases(spec);
  for (const file of spec.input.files)
    if (!relativePath(file.path)) throw new Error('TRAJECTORY_INVALID_ARTIFACT_PATH');
  const attempt = randomUUID();
  const requestId = `mock-request-${attempt}`;
  const sessionId = `mock-session-${attempt}`;
  let scope: TranscriptScope = { bot: 'a', runId: `mock-aborted-${attempt}`, chatRevision: 0 };
  let capture: TrajectoryCapture = {
    schema: 1,
    origin: 'synthetic',
    scope,
    sessionId,
    requestId,
    drained: true,
    lateEvents: 0,
    pages: [],
    contents: [],
    modelRequests: 0,
    artifacts: [],
    bindings: {},
  };
  if (options.signal?.aborted) return capture;
  const root = await mkdtemp(path.join(tmpdir(), 'daban-synthetic-trajectory-'));
  let models: ModelRuns | undefined;
  let closed = true;
  let aborted = options.signal?.aborted === true;
  let abortObserved!: (value: 'stop') => unknown;
  const abort = new Promise<'stop'>((resolve) => {
    abortObserved = resolve;
  });
  const onAbort = () => {
    aborted = true;
    abortObserved('stop');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const artifactRoot = path.join(root, 'artifacts');
    await mkdir(artifactRoot, { mode: 0o700 });
    for (const file of spec.input.files) {
      const output = path.join(artifactRoot, ...file.path.split('/'));
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, file.utf8, { flag: 'wx', mode: 0o600 });
    }
    const bindings = Object.fromEntries(
      [...declared].map(([alias, kind], index) => [
        alias,
        kind === 'workspace'
          ? artifactRoot
          : kind === 'clock'
            ? new Date(1800000000000 + index).toISOString()
            : `mock-nonce-${randomUUID()}`,
      ]),
    );
    capture.bindings = bindings;
    if (aborted) return capture;
    let barrierObserved!: (value: 'complete' | 'stop') => unknown;
    const barrier = new Promise<'complete' | 'stop'>((resolve) => {
      barrierObserved = resolve;
    });
    let releaseStop!: () => unknown;
    const stopping = new Promise<unknown>((resolve) => {
      releaseStop = () => resolve(undefined);
    });
    let observer: ((note: unknown) => unknown) | undefined;
    let sequence = 0;
    let modelRequests = 0;
    let lateEvents = 0;
    let boundary = false;
    let harnessCreated = false;
    let harnessClosed = false;
    let closing: Promise<unknown> | undefined;
    const barrierIndex = spec.input.events.findIndex((event) => event.kind === 'barrier');
    const emit = (event: TrajectoryCase['input']['events'][number]) => {
      if (!observer || event.kind === 'barrier') return;
      if (boundary) lateEvents++;
      const data =
        event.kind === 'call'
          ? {
              callId: event.callId,
              name: event.tool,
              arguments: JSON.stringify(expand(event.args, bindings)),
            }
          : {
              message: {
                toolCallId: event.callId,
                isError: event.isError,
                content: [{ type: 'text', text: JSON.stringify(event.body) }],
              },
              ...(event.isError &&
              event.body !== null &&
              typeof event.body === 'object' &&
              !Array.isArray(event.body) &&
              typeof event.body.error === 'string' &&
              /^[A-Z][A-Z0-9_]{0,80}$/.test(event.body.error)
                ? { error: { code: event.body.error } }
                : {}),
            };
      observer({
        method: 'session.event',
        params: {
          sessionId,
          event: {
            type: event.kind === 'call' ? 'tool/call' : 'tool/result',
            seq: ++sequence,
            time: 1800000000000 + sequence,
            data,
          },
        },
      });
    };
    class Harness {
      constructor() {
        harnessCreated = true;
      }
      async start() {}
      async close() {
        closing ??= (async () => {
          boundary = true;
          releaseStop();
          for (const event of spec.input.events.slice(barrierIndex + 1)) emit(event);
          await new Promise((resolve) => setImmediate(resolve));
          observer = undefined;
          harnessClosed = true;
        })();
        await closing;
      }
      session(id = sessionId) {
        return {
          id,
          run: async (_input: unknown, target: { onNotification: (note: unknown) => unknown }) => {
            observer = target.onNotification;
            modelRequests++;
            for (const event of spec.input.events) {
              if (boundary || aborted) break;
              if (event.kind === 'barrier') {
                boundary = true;
                barrierObserved(event.action);
                if (event.action === 'stop') {
                  await stopping;
                  throw new Error('SYNTHETIC_FIXTURE_STOPPED');
                }
                break;
              }
              emit(event);
              await new Promise((resolve) => setImmediate(resolve));
            }
            if (!boundary || aborted) throw new Error('SYNTHETIC_FIXTURE_STOPPED');
            target.onNotification({
              method: 'session.event',
              params: {
                sessionId,
                event: {
                  type: 'assistant/message',
                  seq: ++sequence,
                  time: 1800000000000 + sequence,
                  data: {
                    message: {
                      content: [
                        { type: 'text', text: 'SYNTHETIC FIXTURE COMPLETE' },
                        { type: 'reasoning', text: 'SYNTHETIC REASONING IS NOT TOOL EVIDENCE' },
                      ],
                    },
                  },
                },
              },
            });
            return { sessionId: id, finalResponse: 'SYNTHETIC FIXTURE COMPLETE' };
          },
        };
      }
      async resumeSession(id: string) {
        return this.session(id);
      }
    }
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-trajectory-provider-key' });
    models = new ModelRuns({
      settings,
      Harness,
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'profile'),
      origin: 'http://127.0.0.1:1',
    });
    closed = false;
    await models.start('a', { requestId, prompt: spec.input.prompt });
    const job = models.jobs.get('a')!;
    scope = { bot: job.bot, runId: job.id, chatRevision: job.chatRevision ?? 0 };
    const action = await Promise.race([barrier, abort, job.done!.then(() => 'complete' as const)]);
    if (action === 'stop' || aborted) await models.stop('a');
    await job.done;
    // Freeze only after both run completion and native close; close may still deliver late notifications.
    const transcript = await captureTranscript(models, scope);
    const record = await models.journal.read(scope.bot, scope.runId);
    const artifacts = await collectTrajectoryArtifacts(
      artifactRoot,
      spec.artifacts.map((artifact) => artifact.path),
    );
    capture = {
      schema: 1,
      origin: 'synthetic',
      scope,
      sessionId: job.sessionId ?? sessionId,
      requestId: record?.requestId ?? requestId,
      drained: (!harnessCreated || harnessClosed) && transcript.complete && artifacts.complete,
      lateEvents,
      pages: transcript.pages,
      contents: transcript.contents,
      ...(terminal(record?.phase) ? { terminal: record.phase } : {}),
      modelRequests,
      artifacts: artifacts.artifacts,
      bindings,
    };
  } catch {
    capture.drained = false;
    capture.scope = scope;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (models) {
      try {
        await models.close();
        closed = true;
      } catch {
        capture.drained = false;
      }
    }
    if (closed) await rm(root, { recursive: true, force: true });
  }
  return structuredClone(capture);
}
