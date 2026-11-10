import { addAbortListener } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';

interface CodexTurn {
  input: Readable;
  output: Writable;
  prompt: string;
  instructions?: string;
  run: AgentToolRun;
  tools: AgentTools;
  onDelta?: (delta: string) => unknown;
}

const frameLimit = 1024 * 1024;
const clientName = 'daban';
export const codexVersion = '0.167.0';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const wireId = (value: unknown): value is number | string =>
  Number.isSafeInteger(value) ||
  (typeof value === 'string' && value.length > 0 && value.length <= 128);
const scopedId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

async function* frames(input: Readable) {
  let rest = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      if (rest.length + end - start > frameLimit) throw new Error('CODEX_FRAME_TOO_LARGE');
      const line = Buffer.concat([rest, bytes.subarray(start, end)]).toString('utf8');
      rest = Buffer.alloc(0);
      start = end + 1;
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error('CODEX_INVALID_MESSAGE');
      }
      if (!record(message)) throw new Error('CODEX_INVALID_MESSAGE');
      yield message;
    }
    if (rest.length + bytes.length - start > frameLimit) throw new Error('CODEX_FRAME_TOO_LARGE');
    rest = Buffer.concat([rest, bytes.subarray(start)]);
  }
  if (rest.length) throw new Error('CODEX_INCOMPLETE_FRAME');
}

const toolFailure = (text: string) => ({
  success: false,
  contentItems: [{ type: 'inputText', text }],
});

function toolResponse(result: ToolResult) {
  // The exposed Daban tools return text. Other payload types require their own mapping.
  if (result.content.some((item) => item.type !== 'text'))
    return toolFailure('CODEX_UNSUPPORTED_TOOL_RESULT');
  return {
    success: result.isError !== true,
    contentItems: result.content.flatMap((item) =>
      item.type === 'text' ? [{ type: 'inputText', text: item.text }] : [],
    ),
  };
}

/** Single ephemeral turn on caller-owned pipes. The caller owns process confinement and reaping. */
export async function runCodexTurn({
  input,
  output,
  prompt,
  instructions,
  run,
  tools,
  onDelta,
}: CodexTurn) {
  run.abort.signal.throwIfAborted();
  const abort = new AbortController();
  const signal = abort.signal;
  const catalog = tools
    .list(run.bot, run.model, run.conversationId, run)
    .filter((tool) => tool.name === 'work_list');
  let dispatching = false;
  const stop = (reason: unknown) => abort.abort(reason);
  const cancel = addAbortListener(run.abort.signal, () => abort.abort(run.abort.signal.reason));
  const deadline = setTimeout(() => stop(new Error('CODEX_TIMEOUT')), 120_000).unref();
  const interrupt = addAbortListener(signal, () => input.destroy());
  const outputError = () => stop(new Error('CODEX_WRITE_FAILED'));
  output.on('error', outputError);
  const messages = frames(input);
  const names = new Set(catalog.map((tool) => tool.name));
  const calls = new Set<string>();
  const commentary = new Set<string>();
  let pending: Promise<unknown> | undefined;
  let result = '';
  let resultBytes = 0;

  const send = async (message: unknown) => {
    signal.throwIfAborted();
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > frameLimit) throw new Error('CODEX_FRAME_TOO_LARGE');
    let abortWrite: ReturnType<typeof addAbortListener> | undefined;
    try {
      await new Promise<unknown>((resolve, reject) => {
        // Backpressure can outlive a stopped turn if the child is no longer reading stdin.
        abortWrite = addAbortListener(signal, () => reject(signal.reason));
        output.write(frame, (error) => {
          if (error) reject(new Error('CODEX_WRITE_FAILED'));
          else resolve(undefined);
        });
      });
    } finally {
      abortWrite?.[Symbol.dispose]();
    }
  };
  const receive = async () => {
    const message = await messages.next();
    signal.throwIfAborted();
    if (message.done) throw new Error('CODEX_UNEXPECTED_EOF');
    return message.value;
  };
  const rejectRequest = async (id: number | string, method: string) => {
    if (method === 'item/tool/call') {
      await send({ id, result: toolFailure('CODEX_TOOL_NOT_AVAILABLE') });
    } else if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      await send({ id, result: { decision: 'decline' } });
    } else {
      await send({ id, error: { code: -32601, message: 'Request unavailable' } });
    }
  };
  const request = async (id: number, method: string, params: unknown) => {
    await send({ id, method, params });
    for (;;) {
      const message = await receive();
      if (typeof message.method === 'string') {
        if (wireId(message.id)) await rejectRequest(message.id, message.method);
        continue;
      }
      if (message.id !== id || !record(message.result) || 'error' in message)
        throw new Error('CODEX_INVALID_RESPONSE');
      return message.result;
    }
  };

  try {
    const initialized = await request(1, 'initialize', {
      clientInfo: { name: clientName, title: 'Daban', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (typeof initialized.userAgent !== 'string') throw new Error('CODEX_INVALID_INITIALIZE');
    // The experimental tool protocol is verified against this exact App Server version.
    if (initialized.userAgent.split(' ', 1)[0] !== `${clientName}/${codexVersion}`)
      throw new Error('CODEX_UNVERIFIED_VERSION');
    await send({ method: 'initialized' });
    const account = await request(4, 'account/read', { refreshToken: false });
    if (!record(account.account) || account.account.type !== 'chatgpt')
      throw new Error('CODEX_LOGIN_REQUIRED');
    const started = await request(2, 'thread/start', {
      ...(instructions ? { developerInstructions: instructions } : {}),
      ephemeral: true,
      // An empty environment list opts out of Codex's native execution environment.
      environments: [],
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      dynamicTools: catalog.map(({ name, description, inputSchema }) => ({
        type: 'function',
        name,
        description,
        inputSchema,
      })),
    });
    if (!record(started.thread) || !scopedId(started.thread.id))
      throw new Error('CODEX_INVALID_THREAD');
    const threadId = started.thread.id;
    const accepted = await request(3, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
    if (!record(accepted.turn) || !scopedId(accepted.turn.id))
      throw new Error('CODEX_INVALID_TURN');
    const turnId = accepted.turn.id;

    for (;;) {
      const { id, method, params } = await receive();
      if (typeof method !== 'string') throw new Error('CODEX_INVALID_NOTIFICATION');
      if (id !== undefined) {
        if (!wireId(id)) throw new Error('CODEX_INVALID_REQUEST');
        if (
          method !== 'item/tool/call' ||
          !record(params) ||
          params.threadId !== threadId ||
          params.turnId !== turnId ||
          params.namespace != null ||
          typeof params.tool !== 'string' ||
          !names.has(params.tool) ||
          !scopedId(params.callId) ||
          !record(params.arguments) ||
          calls.has(params.callId) ||
          dispatching ||
          calls.size >= run.limit
        ) {
          await rejectRequest(id, method);
          continue;
        }
        calls.add(params.callId);
        dispatching = true;
        // Keep checking turn ownership while Daban reads the work list.
        pending = tools
          .invoke(
            run,
            params.tool,
            params.arguments,
            JSON.stringify([threadId, turnId, params.callId]),
          )
          .then(toolResponse, () => toolFailure('CODEX_TOOL_FAILED'))
          .then(async (response) => {
            dispatching = false;
            if (!signal.aborted) await send({ id, result: response });
          })
          .catch(stop);
        continue;
      }
      if (!record(params) || params.threadId !== threadId) continue;
      if (params.turnId !== turnId && method !== 'turn/completed') continue;
      if (
        method === 'item/started' &&
        record(params.item) &&
        params.item.type === 'agentMessage' &&
        params.item.phase === 'commentary' &&
        scopedId(params.item.id)
      ) {
        // Codex sends interim narration as agent messages too. Keep it out of the final chat reply.
        if (commentary.size >= 256) throw new Error('CODEX_OUTPUT_TOO_LARGE');
        commentary.add(params.item.id);
      }
      if (method === 'item/agentMessage/delta') {
        if (typeof params.itemId === 'string' && commentary.has(params.itemId)) continue;
        if (typeof params.delta !== 'string') throw new Error('CODEX_INVALID_DELTA');
        resultBytes += Buffer.byteLength(params.delta);
        if (resultBytes > frameLimit) throw new Error('CODEX_OUTPUT_TOO_LARGE');
        result += params.delta;
        onDelta?.(params.delta);
      }
      if (method === 'turn/completed' && record(params.turn) && params.turn.id === turnId) {
        if (dispatching) throw new Error('CODEX_TOOL_IN_FLIGHT');
        if (params.turn.status !== 'completed') throw new Error('CODEX_TURN_FAILED');
        await pending;
        signal.throwIfAborted();
        return result;
      }
    }
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    stop(failure);
    await pending;
    throw failure;
  } finally {
    clearTimeout(deadline);
    interrupt[Symbol.dispose]();
    cancel[Symbol.dispose]();
    output.off('error', outputError);
    await messages.return(undefined);
  }
}
