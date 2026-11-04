import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ApprovalRules } from './approval-rules.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test.each(['interactive', 'automation'] as const)(
  'Host web decisions bind the live %s source and session; model RPC cannot edit rules',
  async (trigger) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-rules-model-'));
    let models: ModelRuns | undefined;
    let entered: () => unknown = () => undefined;
    let release: () => unknown = () => undefined;
    const started = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    class Harness {
      async start() {}
      async close() {
        release();
      }
      session() {
        return {
          id: 'mock-session',
          run: async () => {
            entered();
            await held;
            return { sessionId: 'mock-session', finalResponse: 'SYNTHETIC' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    const rules = new ApprovalRules(path.join(root, 'model', 'approval-rules.sqlite'));
    try {
      await mkdir(path.join(root, 'workspace'));
      const selector = { kind: 'url' as const, url: 'https://example.test/mock' };
      await rules.write({
        requestId: 'mock-save',
        expectedRevision: 0,
        scope: { kind: 'bot', bot: 'mock-bot' },
        action: 'save',
        rule: {
          id: 'mock-deny',
          name: 'Synthetic URL restriction',
          enabled: true,
          effect: 'deny',
          trigger: 'interactive',
          selector,
        },
      });
      const settings = new ModelSettings(path.join(root, 'credentials.json'));
      await settings.save({ apiKey: 'mock-approval-key' });
      models = new ModelRuns({
        settings,
        workspace: path.join(root, 'workspace'),
        dir: path.join(root, 'model'),
        origin: 'http://127.0.0.1:12345',
        Harness,
      });
      await models.start(
        'mock-bot',
        {
          requestId: 'mock-task',
          prompt: 'Read https://example.test/mock',
          approvalMode: 'full',
        },
        undefined,
        trigger,
      );
      await started;
      const job = models.jobs.get('mock-bot')!;
      const auth = `Bearer ${job.token}`;
      const response = await models.rpc('mock-bot', auth, {
        id: 1,
        method: 'approval.web',
        params: { sessionId: job.sessionId, url: selector.url },
      });
      expect(response).toMatchObject({
        result: {
          trigger,
          effect: trigger === 'interactive' ? 'deny' : 'allow',
          matchedRules: trigger === 'interactive' ? [{ id: 'mock-deny' }] : [],
        },
      });
      expect(
        models.transcripts.page(job.transcript!, 0).items.some((item) => item.name === 'policy'),
      ).toBe(true);
      if (trigger === 'interactive')
        await expect(models.tools.authorizeComputer!(job)).rejects.toMatchObject({
          code: 'WEB_APPROVAL_REJECTED',
        });
      expect(models.journal.findRequest('mock-bot', 'mock-task')?.trigger).toBe(trigger);
      await expect(
        models.rpc('mock-bot', auth, {
          id: 2,
          method: 'approval.web',
          params: { sessionId: 'mock-other-session', url: selector.url },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
      await expect(
        models.rpc('mock-bot', auth, {
          id: 3,
          method: 'interaction.open',
          params: {
            id: 'mock-forged',
            sessionId: job.sessionId,
            kind: 'approval',
            tool: 'web_fetch',
            url: selector.url,
            policyDecision: {},
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
      expect(
        await models.rpc('mock-bot', auth, { id: 4, method: 'approval.rules.write', params: {} }),
      ).toMatchObject({ error: { code: -32601 } });
      expect((await rules.snapshot({ kind: 'bot', bot: 'mock-bot' })).revision).toBe(1);
    } finally {
      release();
      await models?.close();
      await rules.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
