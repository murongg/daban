import { addAbortListener } from 'node:events';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  client,
  type McpServerStdio,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  RequestError,
  type Stream,
} from '@agentclientprotocol/sdk';
import { Fault } from './control.js';

interface AcpTurn {
  provider: 'grok' | 'gemini';
  stream: Stream;
  cwd: string;
  mcpServer: McpServerStdio;
  prompt: string;
  model?: string;
  signal: AbortSignal;
  onDelta?: (delta: string) => unknown;
}

const textLimit = 1024 * 1024;
const modelOption = (options: NewSessionResponse['configOptions']) =>
  options?.find((option) => option.category === 'model' && option.type === 'select');

/** The Host supplies a confined agent transport and a run-scoped Daban MCP bridge. */
export async function runAcpTurn({
  provider,
  stream,
  cwd,
  mcpServer,
  prompt,
  model,
  signal: callerSignal,
  onDelta,
}: AcpTurn) {
  if (!isAbsolute(cwd) || !isAbsolute(mcpServer.command) || mcpServer.name !== 'daban')
    throw new Fault('ACP_INVALID_WORKSPACE');
  if (Buffer.byteLength(prompt) > textLimit) throw new Fault('ACP_INPUT_TOO_LARGE');

  const failure = new AbortController();
  const signal = AbortSignal.any([callerSignal, failure.signal, AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  let sessionId: string | undefined;
  let prompting = false;
  let text = '';
  let bytes = 0;
  const connection = client()
    .onRequest('session/request_permission', ({ params }) => {
      // Daban's MCP handlers own approval. Native requests never grant an alternate route.
      const rejected =
        prompting && !signal.aborted && params.sessionId === sessionId
          ? params.options.find((option) => option.kind === 'reject_once')
          : undefined;
      return {
        outcome: rejected
          ? { outcome: 'selected', optionId: rejected.optionId }
          : { outcome: 'cancelled' },
      };
    })
    .onNotification('session/update', ({ params }) => {
      if (!prompting || signal.aborted || params.sessionId !== sessionId) return;
      const update = params.update;
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return;
      const delta = update.content.text;
      bytes += Buffer.byteLength(delta);
      if (bytes > textLimit) {
        failure.abort(new Fault('ACP_OUTPUT_TOO_LARGE'));
        return;
      }
      text += delta;
      onDelta?.(delta);
    })
    .connect(stream);
  const cancel = async () => {
    try {
      if (prompting && sessionId)
        // A stopped agent may also have stopped reading stdin.
        await Promise.race([
          connection.agent.notify('session/cancel', { sessionId }),
          delay(100, undefined, { ref: false }),
        ]);
    } finally {
      connection.close(signal.reason);
    }
  };
  const interrupt = addAbortListener(signal, () => {
    cancel().catch(() => connection.close(signal.reason));
  });
  try {
    const agent = connection.agent;
    const initialization = await agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    if (initialization.protocolVersion !== PROTOCOL_VERSION)
      throw new Fault('ACP_PROTOCOL_UNSUPPORTED');
    signal.throwIfAborted();
    if (provider === 'grok' && initialization.authMethods?.some(({ id }) => id === 'cached_token'))
      await agent.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });

    signal.throwIfAborted();
    const session = await agent.request('session/new', { cwd, mcpServers: [mcpServer] });
    sessionId = session.sessionId;
    if (!sessionId || sessionId.length > 256) throw new Fault('ACP_INVALID_SESSION');
    if (model) {
      const option = modelOption(session.configOptions);
      if (option?.type !== 'select') throw new Fault('ACP_MODEL_UNAVAILABLE');
      const values = option.options.flatMap((entry) =>
        'options' in entry ? entry.options : [entry],
      );
      if (!values.some(({ value }) => value === model)) throw new Fault('ACP_MODEL_UNAVAILABLE');
      if (option.currentValue !== model) {
        signal.throwIfAborted();
        const configured = await agent.request('session/set_config_option', {
          sessionId,
          configId: option.id,
          value: model,
        });
        const actual = modelOption(configured.configOptions);
        if (actual?.type !== 'select' || actual.id !== option.id || actual.currentValue !== model)
          throw new Fault('ACP_MODEL_UNAVAILABLE');
      }
    }
    signal.throwIfAborted();
    prompting = true;
    const response = await agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    signal.throwIfAborted();
    if (response.stopReason !== 'end_turn') throw new Fault('ACP_TURN_INCOMPLETE');
    return { sessionId, text };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Fault) throw error;
    // Vendor error messages may include authentication or environment details.
    throw new Fault(
      error instanceof RequestError && error.code === -32000
        ? 'ACP_AUTH_REQUIRED'
        : 'ACP_REQUEST_FAILED',
    );
  } finally {
    prompting = false;
    interrupt[Symbol.dispose]();
    connection.close();
  }
}
