import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test.each([false, true])(
  'real DSH owns readers through completion and cancellation (cancel=%s)',
  {
    timeout: 60000,
  },
  async (cancel) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-delegation-loop-'));
    let models: ModelRuns | undefined;
    let entered!: () => unknown;
    const childEntered = new Promise((resolve) => {
      entered = () => resolve(undefined);
    });
    let rootCalls = 0,
      childCalls = 0,
      refused = false;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (req.url?.startsWith('/mcp/')) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(await models!.rpc('mock-bot', req.headers.authorization, input)));
          return;
        }
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'mock-reader' }] }));
          return;
        }
        const isRoot = JSON.stringify(input.messages).includes('SYNTHETIC ROOT TASK');
        if (!isRoot && cancel) {
          entered();
          return;
        }
        let name: string | undefined;
        let args: unknown;
        if (isRoot && ++rootCalls === 1) {
          name = 'subagent';
          args = {
            description: 'Synthetic read-only check',
            prompt:
              'SYNTHETIC CHILD TASK: try the synthetic write once, then report its refusal and finish.',
          };
        } else if (!isRoot && ++childCalls === 1) {
          name = input.tools?.find((tool: { function: { name: string } }) =>
            tool.function.name.endsWith('write_file'),
          )?.function.name;
          if (!name) throw new Error('SYNTHETIC CHILD TOOL CATALOG MISSING');
          args = { path: 'forbidden.txt', content: 'SYNTHETIC FORBIDDEN WRITE' };
        } else if (!isRoot)
          refused ||= JSON.stringify(input.messages).includes('DELEGATION_READ_ONLY');
        const delta = name
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `mock-call-${isRoot ? 'root' : 'child'}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : {
              role: 'assistant',
              content: isRoot ? 'SYNTHETIC ROOT COMPLETE' : 'SYNTHETIC CHILD COMPLETE',
            };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-reader', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-reader', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
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
    try {
      await settings.configure({
        revision: 0,
        requestId: 'mock-reader-setup',
        apiKey: 'mock-reader-secret',
        model: 'provider:mock-provider:mock-reader',
        connection: {
          id: 'mock-provider',
          name: 'Synthetic model',
          baseURL: `${origin}/v1`,
          models: [
            {
              id: 'mock-reader',
              name: 'Synthetic reader',
              vision: false,
              contextWindow: 64000,
              maxTokens: 2048,
            },
          ],
        },
      });
      models = new ModelRuns({
        settings,
        origin,
        dir: path.join(root, 'models'),
        workspace: path.join(root, 'shared'),
        sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
      });
      await models.start('mock-bot', {
        requestId: 'mock-reader-task',
        prompt: 'SYNTHETIC ROOT TASK: delegate a short check and report.',
      });
      const job = models.jobs.get('mock-bot')!;
      if (cancel) {
        await childEntered;
        await models.stop('mock-bot');
        await job.done;
        expect(job.phase).toBe('stopped');
        expect(job.running).toBe(false);
        return;
      }
      await job.done;
      expect(job.phase, job.error).toBe('completed');
      expect(childCalls).toBeGreaterThanOrEqual(2);
      expect(refused).toBe(true);
      expect(job.result).toContain('SYNTHETIC ROOT COMPLETE');
      expect(job.trace.some((item) => item.name === 'subagent')).toBe(true);
      await expect(readFile(path.join(job.workdir, 'forbidden.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await models?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
