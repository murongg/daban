import { isAbsolute, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { bridgeRequest } from './bridge.js';

interface StdioOptions {
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
}
const frameLimit = 8 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

export async function runMcpStdio({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  signal = new AbortController().signal,
}: StdioOptions = {}) {
  const cancellation = new AbortController();
  signal = AbortSignal.any([signal, cancellation.signal]);
  const socketPath = env.DABAN_AGENT_SOCKET;
  const bot = env.DABAN_AGENT_BOT;
  const capability = env.DABAN_AGENT_CAPABILITY;
  if (
    !socketPath ||
    !isAbsolute(socketPath) ||
    socketPath.includes('\0') ||
    !bot ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(bot) ||
    !capability ||
    /[\r\n\0]/.test(capability)
  )
    throw new Error('MCP_STDIO_CONFIG_INVALID');
  const config = { socketPath, capability, url: `http://127.0.0.1:8766/mcp/${bot}` };
  const send = (value: unknown) =>
    new Promise<unknown>((done, reject) => {
      output.write(`${JSON.stringify(value)}\n`, (error) =>
        error ? reject(error) : done(undefined),
      );
    });
  const line = async (bytes: Buffer) => {
    if (bytes.length > frameLimit) throw new Error('MCP_STDIO_FRAME_TOO_LARGE');
    if (!bytes.toString('utf8').trim()) return;
    let rpc: unknown;
    try {
      rpc = JSON.parse(bytes.toString('utf8'));
    } catch {
      await send(rpcError(null, -32700, 'Invalid JSON'));
      return;
    }
    if (
      !object(rpc) ||
      rpc.jsonrpc !== '2.0' ||
      typeof rpc.method !== 'string' ||
      !rpc.method ||
      (Object.hasOwn(rpc, 'id') &&
        rpc.id !== null &&
        typeof rpc.id !== 'string' &&
        typeof rpc.id !== 'number')
    ) {
      await send(rpcError(null, -32600, 'Invalid request'));
      return;
    }
    const expectsReply = Object.hasOwn(rpc, 'id');
    let reply: unknown;
    try {
      // Tool calls can wait on a human; the owning DSH process supplies cancellation and its own deadline.
      reply = await bridgeRequest(config, rpc, signal, undefined, 24 * 60 * 60 * 1000);
      if (!expectsReply) return;
      if (
        !object(reply) ||
        reply.jsonrpc !== '2.0' ||
        reply.id !== rpc.id ||
        Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error') ||
        (Object.hasOwn(reply, 'error') &&
          (!object(reply.error) ||
            !Number.isInteger(reply.error.code) ||
            typeof reply.error.message !== 'string'))
      )
        throw new Error('MCP_STDIO_INVALID_RESPONSE');
    } catch {
      if (signal.aborted) throw new DOMException('MCP bridge aborted', 'AbortError');
      if (!expectsReply) return;
      reply = rpcError(rpc.id, -32603, 'Private agent unavailable');
    }
    await send(reply);
  };
  const abort = () => input.destroy(new DOMException('MCP bridge aborted', 'AbortError'));
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  const pending = new Set<Promise<unknown>>();
  let failure: unknown;
  const schedule = (bytes: Buffer) => {
    if (bytes.length > frameLimit) throw new Error('MCP_STDIO_FRAME_TOO_LARGE');
    if (pending.size >= 64) throw new Error('MCP_STDIO_BUSY');
    // Keep reading cancellation notifications while an earlier tool waits for a human decision.
    const task: Promise<unknown> = line(bytes)
      .catch((error: unknown) => {
        failure ??= error;
        cancellation.abort();
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      buffered = Buffer.concat([
        buffered,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      ]);
      let newline = buffered.indexOf(10);
      while (newline !== -1) {
        schedule(buffered.subarray(0, newline));
        buffered = buffered.subarray(newline + 1);
        newline = buffered.indexOf(10);
      }
      if (buffered.length > frameLimit) throw new Error('MCP_STDIO_FRAME_TOO_LARGE');
    }
    if (buffered.length) schedule(buffered);
  } catch (error) {
    failure ??= error;
    cancellation.abort();
  } finally {
    await Promise.all(pending);
    signal.removeEventListener('abort', abort);
  }
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMcpStdio().catch(() => {
    process.stderr.write('Private MCP bridge failed\n');
    process.exitCode = 1;
  });
}
