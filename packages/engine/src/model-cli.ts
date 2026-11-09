import { addAbortListener } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';

interface CodexTurn {
  input: Readable;
  output: Writable;
  model: string;
  prompt: string;
  run: AgentToolRun;
  tools: AgentTools;
  onDelta?: (delta: string) => unknown;
}

const frameLimit = 1024 * 1024;
const allowedTools = new Set(['work_list', 'local_shell']);
const clientName = 'daban_poc';
const appServerVersion = '0.167.0';
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
  // Both proof-of-concept tools return text. Other payload types require their own mapping.
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
  model,
  prompt,
  run,
  tools,
  onDelta,
}: CodexTurn) {
  const signal = run.abort.signal;
  signal.throwIfAborted();
  const catalog = tools
    .list(run.bot, run.model, run.conversationId, run)
    .filter((tool) => allowedTools.has(tool.name));
  const stop = () => run.abort.abort();
  const deadline = setTimeout(stop, 120_000).unref();
  const interrupt = addAbortListener(signal, () => input.destroy());
  output.on('error', stop);
  const messages = frames(input);
  const names = new Set(catalog.map((tool) => tool.name));
  const calls = new Set<string>();
  let pending: Promise<unknown> | undefined;
  let dispatching = false;
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
      clientInfo: { name: clientName, title: 'Daban CLI prototype', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (typeof initialized.userAgent !== 'string') throw new Error('CODEX_INVALID_INITIALIZE');
    // The experimental tool protocol is verified against this exact App Server version.
    if (initialized.userAgent.split(' ', 1)[0] !== `${clientName}/${appServerVersion}`)
      throw new Error('CODEX_UNVERIFIED_VERSION');
    await send({ method: 'initialized' });
    const started = await request(2, 'thread/start', {
      model,
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
        // Keep reading while approval waits. A premature turn end must revoke the pending grant.
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
      if (method === 'item/agentMessage/delta' && params.turnId === turnId) {
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
    stop();
    await pending;
    throw error;
  } finally {
    clearTimeout(deadline);
    interrupt[Symbol.dispose]();
    output.off('error', stop);
    await messages.return(undefined);
  }
}
