import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

export interface SyntheticRequest {
  messages: unknown[];
  tools?: { function: { name: string } }[];
}
export type SyntheticReply =
  | string
  | { id?: string; name: string; args: Record<string, unknown> }[]
  | { status: number; error: { message: string } };

// Real SDK transport with synthetic model responses only; no external provider or user data is used.
export async function inferenceFixture(
  answer: (
    request: SyntheticRequest,
    signal: AbortSignal,
  ) => SyntheticReply | Promise<SyntheticReply>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-inference-'));
  let models!: ModelRuns;
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.url?.startsWith('/mcp/')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            await models.rpc(
              decodeURIComponent(req.url.slice('/mcp/'.length)),
              req.headers.authorization,
              input,
            ),
          ),
        );
        return;
      }
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      const abort = new AbortController();
      res.once('close', () => abort.abort());
      const response = await answer(input, abort.signal);
      if (res.destroyed) return;
      if (typeof response !== 'string' && !Array.isArray(response)) {
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: response.error }));
        return;
      }
      const delta =
        typeof response === 'string'
          ? { role: 'assistant', content: response }
          : {
              role: 'assistant',
              tool_calls: response.map((call, index) => ({
                index,
                id: call.id ?? `mock-call-${++calls}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: typeof response === 'string' ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.configure({
    revision: 0,
    requestId: 'mock-setup',
    apiKey: 'mock-inference-secret',
    model: 'provider:mock-provider:mock-model',
    connection: {
      id: 'mock-provider',
      name: 'Synthetic model',
      baseURL: `${origin}/v1`,
      models: [
        {
          id: 'mock-model',
          name: 'Synthetic model',
          vision: false,
          contextWindow: 64000,
          maxTokens: 2048,
        },
      ],
    },
  });
  const options = {
    settings,
    origin,
    dir: path.join(root, 'models'),
    workspace: path.join(root, 'shared'),
    sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
  };
  models = new ModelRuns(options);
  return {
    get models() {
      return models;
    },
    root,
    async restart() {
      await models.close();
      models = new ModelRuns(options);
      await models.ready;
    },
    async close() {
      await models.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
