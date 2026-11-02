import { closeSync, constants, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { startupSnapshotLimit } from './dsh.js';
import { redact, redactStream } from './redaction.js';

const file = process.env.DABAN_DSH_STARTUP_FILE;
// NODE_OPTIONS can propagate to workers/subprocesses; only the SDK's directly owned runtime may record this startup.
if (file && Number(process.env.DABAN_DSH_STARTUP_PARENT) === process.ppid) {
  const target = file;
  const secrets = [
    process.env.DABAN_MODEL_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.DABAN_DSH_STARTUP_REDACT,
  ].filter((value): value is string => !!value);
  delete process.env.NODE_OPTIONS;
  delete process.env.DABAN_DSH_STARTUP_FILE;
  delete process.env.DABAN_DSH_STARTUP_PARENT;
  delete process.env.DABAN_DSH_STARTUP_REDACT;
  const began = performance.now();
  const snapshot: {
    stage: string;
    pid: number;
    parentPid: number;
    startedAt: string;
    elapsedMs: number;
    entry: string;
    resources: string[];
    stderr: string;
    truncated: boolean;
    exitCode?: number;
    exception?: { name: string; message: string; stack: string };
  } = {
    stage: 'node-started',
    pid: process.pid,
    parentPid: process.ppid,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    entry: (process.argv[1] ?? '[eval]').replaceAll('\\', '/').split('/').slice(-4).join('/'),
    resources: [],
    stderr: '',
    truncated: false,
  };
  let active = true,
    raw = '',
    used = 0,
    stdout = '';
  const decoder = new StringDecoder('utf8');
  const clean = (value: string) =>
    redact(value, secrets).replace(/data:[^\s"'<>]+/g, '[inline module redacted]');
  function save() {
    if (!active) return;
    let handle: number | undefined;
    try {
      snapshot.elapsedMs = Math.round(performance.now() - began);
      snapshot.resources = process.getActiveResourcesInfo().slice(-32);
      snapshot.stderr = clean(redactStream(raw, secrets));
      const encode = () =>
        JSON.stringify(snapshot, (_key, value: unknown) =>
          typeof value === 'string' ? clean(value) : value,
        );
      let text = encode();
      while (Buffer.byteLength(text) > startupSnapshotLimit && snapshot.stderr.length) {
        snapshot.stderr = snapshot.stderr.slice(0, Math.floor(snapshot.stderr.length / 2));
        snapshot.truncated = true;
        text = encode();
      }
      if (Buffer.byteLength(text) > startupSnapshotLimit) return;
      handle = openSync(
        target + '.tmp',
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(handle, text);
      closeSync(handle);
      handle = undefined;
      renameSync(target + '.tmp', target);
    } catch {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          /* Preserve the runtime even if diagnostic cleanup fails. */
        }
      }
      try {
        unlinkSync(target + '.tmp');
      } catch {
        /* Diagnostics must not change runtime behavior. */
      }
    }
  }
  save();
  const heartbeat = setInterval(() => {
    snapshot.stage = 'waiting-initialize';
    save();
  }, 1000);
  heartbeat.unref();
  const originalError = process.stderr.write;
  const originalOutput = process.stdout.write;
  function stderr(this: typeof process.stderr, chunk: string | Uint8Array, ...args: unknown[]) {
    if (active && used >= 32768 && !snapshot.truncated) {
      snapshot.truncated = true;
      save();
    }
    if (active && used < 32768) {
      const bytes =
        typeof chunk === 'string'
          ? Buffer.from(chunk.slice(0, 32768))
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const selected = bytes.subarray(0, 32768 - used);
      used += selected.length;
      raw += decoder.write(selected);
      snapshot.truncated ||=
        bytes.length > selected.length || (typeof chunk === 'string' && chunk.length > 32768);
      save();
    }
    return Reflect.apply(originalError, this, [chunk, ...args]) as boolean;
  }
  function stopped() {
    snapshot.stage = 'initialized';
    save();
    active = false;
    clearInterval(heartbeat);
    if (process.stderr.write === stderr) process.stderr.write = originalError;
    if (process.stdout.write === output) process.stdout.write = originalOutput;
    process.removeListener('uncaughtExceptionMonitor', crashed);
    process.removeListener('exit', exited);
  }
  function output(this: typeof process.stdout, chunk: string | Uint8Array, ...args: unknown[]) {
    if (active) {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
      const parts = text.split('\n');
      for (const [index, part] of parts.entries()) {
        stdout = (stdout + part).slice(-8192);
        if (index === parts.length - 1) break;
        try {
          const value = JSON.parse(stdout);
          if (
            value?.jsonrpc === '2.0' &&
            value.id !== undefined &&
            typeof value.result?.serverInfo?.name === 'string' &&
            typeof value.result.serverInfo.version === 'string'
          ) {
            // Stop before the parent's first prompt; stdout/RPC bodies and normal chat output are never persisted.
            stopped();
            break;
          }
        } catch {
          /* This may be a partial RPC frame. */
        }
        stdout = '';
      }
    }
    return Reflect.apply(originalOutput, this, [chunk, ...args]) as boolean;
  }
  function crashed(error: Error) {
    try {
      snapshot.exception = {
        name: clean(error.name).slice(0, 128),
        message: clean(error.message).slice(0, 2048),
        stack: clean(error.stack ?? '').slice(0, 8192),
      };
      save();
    } catch {
      /* Observing an exception must not suppress the normal crash. */
    }
  }
  function exited(code: number) {
    snapshot.exitCode = code;
    save();
  }
  process.stderr.write = stderr;
  process.stdout.write = output;
  process.on('uncaughtExceptionMonitor', crashed);
  process.on('exit', exited);
}
