import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { errorCode } from './control.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test.each([false, true])(
  'real DSH owns readers through completion and cancellation (cancel=%s)',
  {
    timeout: 60000,
  },
  async (cancel) => {
    const started = performance.now();
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
    let phase = 'fixture',
      lastError: string | undefined;
    const mark = (event: string, state: Record<string, string | number | boolean> = {}) => {
      phase = event;
      process.stderr.write(
        `[delegation-phase] ${JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), cancel, rootCalls, childCalls, wireCalls, webCalls: webSessions.length, approvalRequests, lastError, jobAborted: models?.jobs.get('mock-bot')?.abort.signal.aborted, ...state })}\n`,
      );
    };
    const failed = (error: unknown) => {
      const code = errorCode(error);
      lastError = code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'UNCLASSIFIED';
    };
    const closeError = (error: unknown) => {
      failed(error);
      mark('close.error', { activePhase: phase });
      throw error;
    };
    const server = createServer(async (req, res) => {
      // Keep request linkage local: other handlers can change the shared phase during the RPC await.
      let rpcKind = 'provider',
        webCall = 0,
        rootSessionMatches = false;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const input = chunks.length ? JSON.parse(bytes.toString('utf8')) : {};
        if (req.url?.startsWith('/mcp/')) {
          rpcKind =
            input.method === 'approval.web'
              ? 'approval.web'
              : typeof input.method === 'string' && input.method.startsWith('budget.')
                ? 'budget'
                : typeof input.method === 'string' && input.method.startsWith('interaction.')
                  ? 'interaction'
                  : 'other-rpc';
          if (input.method === 'approval.web') webSessions.push(input.params?.sessionId);
          if (input.method === 'approval.web') {
            webCall = webSessions.length;
            rootSessionMatches =
              typeof input.params?.sessionId === 'string' &&
              input.params.sessionId === models?.jobs.get('mock-bot')?.sessionId;
            mark('web.begin', { webCall, rootSessionMatches });
          }
          if (input.method === 'interaction.open' && input.params?.kind === 'approval')
            approvalRequests++;
          const reply = (await models!.rpc('mock-bot', req.headers.authorization, input)) as {
            result?: {
              accepted?: boolean;
              send?: boolean;
              effect?: unknown;
              reasonCode?: unknown;
              policyRevision?: unknown;
            };
            error?: { code?: unknown };
          };
          if (input.method === 'approval.web') {
            // Reading the existing reply adds no store read or ordering barrier to the suspected race.
            const effect = reply.result?.effect;
            const revision = reply.result?.policyRevision;
            if (reply.error !== undefined) lastError = 'RPC_ERROR';
            mark('web.settled', {
              webCall,
              rootSessionMatches,
              effect:
                effect === 'allow' || effect === 'deny' || effect === 'ask' ? effect : 'other',
              ruleDenied: reply.result?.reasonCode === 'ruleDenied',
              policyRevision:
                typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
                  ? revision
                  : -1,
              rpcError: reply.error !== undefined,
              rpcErrorCode: typeof reply.error?.code === 'number' ? reply.error.code : 0,
            });
          }
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
            mark('child.web-offered');
            name = 'web_fetch';
            args = { url: 'https://example.test/mock-child-read' };
          } else if (childCalls === 3) {
            mark('rule.ask.begin', { expectedRevision: 1 });
            const changed = await models!.approvalRules.write({
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
            mark('rule.ask.applied', { revision: changed.revision });
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
        failed(error);
        mark('provider.error', { activePhase: phase, rpcKind, webCall, rootSessionMatches });
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
      mark('rule.deny.begin', { expectedRevision: 0 });
      const initial = await models.approvalRules.write({
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
      mark('rule.deny.applied', { revision: initial.revision });
      await models.start('mock-bot', {
        requestId: 'mock-reader-task',
        prompt:
          'SYNTHETIC ROOT TASK: delegate a short check of https://example.test/mock-child-read and report.',
      });
      const job = models.jobs.get('mock-bot')!;
      mark('root.accepted', {
        rootSessionPresent: typeof job.sessionId === 'string',
        running: job.running,
      });
      if (cancel) {
        mark('cancel.wait');
        await Promise.all([childEntered, rootHeld]);
        mark('cancel.ready');
        await models.stop('mock-bot');
        release();
        await job.done;
        mark('root.settled', { modelPhase: job.phase, running: job.running });
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
      mark('root.settled', {
        modelPhase: job.phase,
        running: job.running,
        jobErrorPresent: !!job.error,
      });
      expect(job.phase, job.error).toBe('completed');
      expect(childCalls).toBeGreaterThanOrEqual(4);
      expect(webSessions).toEqual([job.sessionId, job.sessionId]);
      const interactions = await models.interactions.list();
      const denied = interactions.some(
        (item) =>
          item.policyDecision?.reasonCode === 'ruleDenied' &&
          item.reply?.kind === 'decision' &&
          !item.reply.allow,
      );
      const ruleDeniedRecords = interactions.filter(
        (item) => item.policyDecision?.reasonCode === 'ruleDenied',
      );
      const ownedDenials = ruleDeniedRecords.filter(
        (item) => item.bot === job.bot && item.runId === job.id,
      );
      mark('receipts.read', {
        records: interactions.length,
        denied,
        rootBoundDenied: interactions.some(
          (item) =>
            item.bot === job.bot &&
            item.runId === job.id &&
            item.sessionId === job.sessionId &&
            item.policyDecision?.reasonCode === 'ruleDenied' &&
            item.reply?.kind === 'decision' &&
            !item.reply.allow,
        ),
        ruleDeniedRecords: ruleDeniedRecords.length,
        rootOwnerMatchCount: ownedDenials.length,
        rootSessionMatchCount: ownedDenials.filter((item) => item.sessionId === job.sessionId)
          .length,
        deniedResolved: ruleDeniedRecords.filter((item) => item.status === 'resolved').length,
        deniedPending: ruleDeniedRecords.filter((item) => item.status === 'pending').length,
        deniedCancelled: ruleDeniedRecords.filter((item) => item.status === 'cancelled').length,
        deniedInterrupted: ruleDeniedRecords.filter((item) => item.status === 'interrupted').length,
        deniedMissingReply: ruleDeniedRecords.filter((item) => item.reply === undefined).length,
        deniedNegativeReply: ruleDeniedRecords.filter(
          (item) => item.reply?.kind === 'decision' && !item.reply.allow,
        ).length,
        deniedPositiveReply: ruleDeniedRecords.filter(
          (item) => item.reply?.kind === 'decision' && item.reply.allow,
        ).length,
        deniedOtherReply: ruleDeniedRecords.filter(
          (item) => item.reply !== undefined && item.reply.kind !== 'decision',
        ).length,
        pending: interactions.some((item) => item.status === 'pending'),
      });
      expect(denied, 'Missing the root-bound rule-denied receipt').toBe(true);
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
      mark('verified');
    } catch (error) {
      failed(error);
      mark('test.error', { activePhase: phase });
      throw error;
    } finally {
      release();
      try {
        mark('close.model');
        await models?.close().catch(closeError);
        mark('close.server');
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve)).catch(closeError);
        mark('close.files');
        await rm(root, { recursive: true, force: true }).catch(closeError);
        mark('closed');
      } finally {
        mark('test.finished');
      }
    }
  },
);
