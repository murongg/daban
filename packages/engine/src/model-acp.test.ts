import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { expect, test, vi } from 'vitest';
import { runAcpTurn } from './model-acp.js';

function wire() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const read = lines[Symbol.asyncIterator]();
  return {
    // Node and DOM declare different BYOB overloads for the same byte stream.
    stream: ndJsonStream(
      Writable.toWeb(output),
      Readable.toWeb(input) as unknown as ReadableStream<Uint8Array>,
    ),
    next: async (): Promise<Record<string, unknown>> => {
      const line = await read.next();
      if (line.done) throw new Error('Synthetic ACP peer closed unexpectedly');
      return JSON.parse(line.value);
    },
    send: (message: unknown) =>
      input.write(`${JSON.stringify({ jsonrpc: '2.0', ...(message as object) })}\n`),
    close() {
      lines.close();
      input.destroy();
      output.destroy();
    },
  };
}

const mcpServer = {
  name: 'daban',
  command: path.join(tmpdir(), 'mock-daban-mcp'),
  args: [],
  env: [],
};
const modelOption = {
  type: 'select',
  category: 'model',
  id: 'mock-choice',
  name: 'Synthetic model',
  currentValue: 'mock-default',
  options: [
    { value: 'mock-default', name: 'Default' },
    { value: 'mock-alternate', name: 'Alternate' },
  ],
};

test.each(['grok', 'gemini'] as const)(
  '%s uses ACP with a scoped MCP server and rejects native permission requests',
  async (provider) => {
    const peer = wire();
    const abort = new AbortController();
    const delta = vi.fn();
    const turn = runAcpTurn({
      provider,
      stream: peer.stream,
      cwd: tmpdir(),
      mcpServer,
      prompt: 'Synthetic prompt',
      model: 'mock-alternate',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
      onDelta: delta,
    });
    const next = () =>
      Promise.race([
        peer.next(),
        turn.then(() => {
          throw new Error('Synthetic ACP turn ended early');
        }),
      ]);
    try {
      const initialize = await next();
      expect(initialize).toMatchObject({
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      expect(initialize.params).not.toHaveProperty('clientCapabilities.fs');
      expect(initialize.params).not.toHaveProperty('clientCapabilities.terminal');
      peer.send({
        id: initialize.id,
        result: {
          protocolVersion: 1,
          authMethods: [
            { id: 'cached_token', name: 'Synthetic cached sign-in' },
            { id: 'oauth-personal', name: 'Synthetic browser sign-in' },
          ],
        },
      });
      if (provider === 'grok') {
        const authenticate = await next();
        expect(authenticate).toMatchObject({
          method: 'authenticate',
          params: { methodId: 'cached_token', _meta: { headless: true } },
        });
        peer.send({ id: authenticate.id, result: {} });
      }
      const session = await next();
      expect(session).toMatchObject({
        method: 'session/new',
        params: { cwd: tmpdir(), mcpServers: [mcpServer] },
      });
      peer.send({
        id: session.id,
        result: { sessionId: 'mock-session', configOptions: [modelOption] },
      });
      const configure = await next();
      expect(configure).toMatchObject({
        method: 'session/set_config_option',
        params: { sessionId: 'mock-session', configId: modelOption.id, value: 'mock-alternate' },
      });
      peer.send({
        id: configure.id,
        result: { configOptions: [{ ...modelOption, currentValue: 'mock-alternate' }] },
      });
      const prompt = await next();
      expect(prompt).toMatchObject({
        method: 'session/prompt',
        params: { sessionId: 'mock-session', prompt: [{ type: 'text', text: 'Synthetic prompt' }] },
      });
      peer.send({
        id: 'mock-permission',
        method: 'session/request_permission',
        params: {
          sessionId: 'mock-session',
          toolCall: { toolCallId: 'mock-shell' },
          options: [
            { optionId: 'mock-allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'mock-reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      expect(await next()).toMatchObject({
        id: 'mock-permission',
        result: { outcome: { outcome: 'selected', optionId: 'mock-reject' } },
      });
      for (const [sessionId, text] of [
        ['mock-old-session', 'stale'],
        ['mock-session', 'Synthetic result.'],
      ])
        peer.send({
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          },
        });
      peer.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
      await expect(turn).resolves.toEqual({ sessionId: 'mock-session', text: 'Synthetic result.' });
      expect(delta.mock.calls).toEqual([['Synthetic result.']]);
    } finally {
      abort.abort();
      peer.close();
      await turn.catch(() => {});
    }
  },
);

test('cancelling a stalled prompt sends ACP session cancellation and releases the turn', async () => {
  const peer = wire();
  const abort = new AbortController();
  const turn = runAcpTurn({
    provider: 'gemini',
    stream: peer.stream,
    cwd: tmpdir(),
    mcpServer,
    prompt: 'Synthetic request',
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
  });
  const outcome = turn.catch((error: unknown) => error);
  try {
    const initialize = await peer.next();
    peer.send({ id: initialize.id, result: { protocolVersion: 1 } });
    const session = await peer.next();
    peer.send({ id: session.id, result: { sessionId: 'mock-cancel' } });
    expect(await peer.next()).toMatchObject({ method: 'session/prompt' });
    abort.abort();
    expect(await peer.next()).toMatchObject({
      method: 'session/cancel',
      params: { sessionId: 'mock-cancel' },
    });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  } finally {
    abort.abort();
    peer.close();
    await outcome;
  }
});
