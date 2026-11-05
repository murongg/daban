import { createHash } from 'node:crypto';
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
    let held!: () => unknown, release!: () => unknown;
    const rootHeld = new Promise((resolve) => {
      held = () => resolve(undefined);
    });
    const acknowledgement = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const permits = new Map<
      string,
      { hash: string; purpose: string; session: string; root: string }
    >();
    const dispatched = new Set<string>();
    const arrived: string[] = [];
    let rootDispatches = 0;
    let rootCalls = 0,
      childCalls = 0,
      wireCalls = 0,
      refused = false,
      approvalRequests = 0;
    const webSessions: unknown[] = [];
    const toolResults = new Set<string>();
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const input = chunks.length ? JSON.parse(bytes.toString('utf8')) : {};
        if (req.url?.startsWith('/mcp/')) {
          if (input.method === 'approval.web') webSessions.push(input.params?.sessionId);
          if (input.method === 'interaction.open' && input.params?.kind === 'approval')
            approvalRequests++;
          const reply = (await models!.rpc('mock-bot', req.headers.authorization, input)) as {
            result?: { accepted?: boolean; send?: boolean };
          };
          if (input.method === 'budget.reserve' && reply.result?.accepted) {
            const params = input.params as {
              attemptId: string;
              requestHash: string;
              purpose: string;
              sessionId: string;
              rootSessionId: string;
            };
            permits.set(params.attemptId, {
              hash: params.requestHash,
              purpose: params.purpose,
              session: params.sessionId,
              root: params.rootSessionId,
            });
          }
          if (input.method === 'budget.dispatched' && reply.result?.send) {
            const id = String(input.params.attemptId);
            dispatched.add(id);
            if (cancel && permits.get(id)?.purpose === 'main' && ++rootDispatches === 2) {
              held();
              await acknowledgement;
            }
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(reply));
          return;
        }
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'mock-reader' }] }));
          return;
        }
        wireCalls++;
        arrived.push(createHash('sha256').update(bytes).digest('hex'));
        const isRoot = JSON.stringify(input.messages).includes('SYNTHETIC ROOT TASK');
        if (!isRoot && cancel) {
          entered();
          return;
        }
        let name: string | undefined;
        let args: unknown;
        if (isRoot && ++rootCalls <= 2) {
          name = 'subagent';
          args = {
            description: 'Synthetic read-only check',
            prompt:
              'SYNTHETIC CHILD TASK: try the synthetic write once, then report its refusal and finish.',
          };
        } else if (!isRoot) {
          for (const message of Array.isArray(input.messages) ? input.messages : []) {
            if (message.role === 'tool' && typeof message.content === 'string')
              toolResults.add(message.content.slice(0, 200));
          }
          refused ||= JSON.stringify(input.messages).includes('DELEGATION_READ_ONLY');
          childCalls++;
          if (childCalls === 1) {
            name = input.tools?.find((tool: { function: { name: string } }) =>
              tool.function.name.endsWith('write_file'),
            )?.function.name;
            if (!name) throw new Error('SYNTHETIC CHILD TOOL CATALOG MISSING');
            args = { path: 'forbidden.txt', content: 'SYNTHETIC FORBIDDEN WRITE' };
          } else if (childCalls === 2) {
            name = 'web_fetch';
            args = { url: 'https://example.test/mock-child-read' };
          } else if (childCalls === 3) {
            await models!.approvalRules.write({
              requestId: 'mock-ask-child-read',
              expectedRevision: 1,
              scope: { kind: 'bot', bot: 'mock-bot' },
              action: 'save',
              rule: {
                id: 'mock-child-read-rule',
                name: 'Synthetic child read review',
                effect: 'ask',
                enabled: true,
                trigger: 'interactive',
                selector: { kind: 'url', url: 'https://example.test/mock-child-read' },
              },
            });
            name = 'web_fetch';
            args = { url: 'https://example.test/mock-child-read' };
          }
        }
        const delta = name
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `mock-call-${isRoot ? `root-${rootCalls}` : `child-${childCalls}`}`,
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
      await models.approvalRules.write({
        requestId: 'mock-deny-child-read',
        expectedRevision: 0,
        scope: { kind: 'bot', bot: 'mock-bot' },
        action: 'save',
        rule: {
          id: 'mock-child-read-rule',
          name: 'Synthetic child read restriction',
          enabled: true,
          effect: 'deny',
          trigger: 'interactive',
          selector: { kind: 'url', url: 'https://example.test/mock-child-read' },
        },
      });
      await models.start('mock-bot', {
        requestId: 'mock-reader-task',
        prompt:
          'SYNTHETIC ROOT TASK: delegate a short check of https://example.test/mock-child-read and report.',
      });
      const job = models.jobs.get('mock-bot')!;
      if (cancel) {
        await Promise.all([childEntered, rootHeld]);
        await models.stop('mock-bot');
        release();
        await job.done;
        expect(job.phase).toBe('stopped');
        expect(job.running).toBe(false);
        const budget = models.budgets.view(job.budget!.budgetId);
        // Stop can follow a durable dispatch claim before the SDK enters fetch; that claim stays unknown, not free.
        expect(wireCalls).toBe(2);
        expect(dispatched.size).toBe(3);
        expect(budget.requests).toBe(3);
        expect(budget.unknownCount).toBe(3);
        const reached = new Set<string>();
        for (const hash of arrived) {
          const matches = [...dispatched].filter(
            (id) => !reached.has(id) && permits.get(id)?.hash === hash,
          );
          expect(
            matches,
            JSON.stringify({ hash, permits: [...permits], dispatched: [...dispatched] }),
          ).toHaveLength(1);
          reached.add(matches[0]);
        }
        for (const receipt of budget.receipts) {
          expect(receipt).toMatchObject({
            runId: job.id,
            modelAttemptId: job.attemptId,
            scope: job.budget,
            rootSessionId: job.sessionId,
            phase: 'unknown',
          });
          expect(permits.get(receipt.attemptId)).toMatchObject({
            session: receipt.sessionId,
            root: job.sessionId,
            purpose: receipt.purpose,
          });
        }
        const heldReceipts = budget.receipts.filter((receipt) => !reached.has(receipt.attemptId));
        expect(heldReceipts).toHaveLength(1);
        expect(heldReceipts[0]).toMatchObject({
          purpose: 'main',
          sessionId: job.sessionId,
          phase: 'unknown',
        });
        await new Promise(setImmediate);
        expect(arrived).toHaveLength(2);
        return;
      }
      await job.done;
      expect(job.phase, job.error).toBe('completed');
      expect(childCalls).toBeGreaterThanOrEqual(4);
      expect(webSessions).toEqual([job.sessionId, job.sessionId]);
      expect(
        (await models.interactions.list()).some(
          (item) =>
            item.policyDecision?.reasonCode === 'ruleDenied' &&
            item.reply?.kind === 'decision' &&
            !item.reply.allow,
        ),
        'Missing the root-bound rule-denied receipt',
      ).toBe(true);
      expect([...toolResults]).toContain(
        'Error: The user declined this exact one-time web request. No HTTP request was made. Do not retry it unless the user explicitly asks.',
      );
      expect(approvalRequests, 'A child must not borrow root authority to prompt the Human').toBe(
        0,
      );
      expect((await models.interactions.list()).some((item) => item.status === 'pending')).toBe(
        false,
      );
      expect(refused, 'The real child write guard must remain active').toBe(true);
      const budget = models.budgets.view(job.budget!.budgetId);
      expect(budget.requests).toBe(wireCalls);
      expect(budget.unknownCount).toBe(wireCalls);
      expect(
        new Set(budget.receipts.filter((r) => r.purpose === 'subtask').map((r) => r.sessionId))
          .size,
      ).toBe(2);
      expect(job.result).toContain('SYNTHETIC ROOT COMPLETE');
      expect(job.trace.some((item) => item.name === 'subagent')).toBe(true);
      await expect(readFile(path.join(job.workdir, 'forbidden.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      release();
      await models?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
