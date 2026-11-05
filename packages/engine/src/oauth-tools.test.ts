import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { AgentTools } from './agent-tools.js';
import { ApprovalRules, type RulePolicy } from './approval-rules.js';
import { IntegrationTools } from './integration-tools.js';
import { Integrations } from './integrations.js';
import { Interactions } from './interactions.js';
import { secureDirectory } from './private-files.js';
import { Projects } from './projects.js';
import { WorkspaceFiles } from './workspace.js';

test.each([
  ['config', 'project'],
  ['token', 'project'],
  ['return', 'project'],
  ['config', 'policy'],
  ['token', 'policy'],
  ['return', 'policy'],
] as const)(
  'OAuth lookup at %s rechecks %s authority before using credentials',
  async (phase, change) => {
    const root = await secureDirectory(
      await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-authority-')),
    );
    const store = new Integrations(path.join(root, 'integrations.sqlite'));
    const interactions = new Interactions(path.join(root, 'interactions'));
    const rules = new ApprovalRules(path.join(root, 'rules.sqlite'));
    const projects = new Projects(path.join(root, 'projects.sqlite'));
    const project = { projectId: 'mock-project', revision: 1 };
    const bot = 'mock-bot',
      connection = 'mock-app';
    let release!: () => unknown, arrived!: () => unknown;
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    const waiting = new Promise<unknown>((resolve) => {
      arrived = () => resolve(undefined);
    });
    const pause = async () => {
      arrived();
      await gate;
    };
    let tokenCalls = 0,
      factories = 0,
      effects = 0,
      configCalls = 0;
    const policy: RulePolicy = {
      review: (run, selector, baseline, allowEligible = false) =>
        rules.evaluate({
          scope: { kind: 'bot', bot: run.bot },
          project,
          trigger: 'interactive',
          selector,
          mode: 'ask',
          baseline,
          allowEligible,
        }),
      assertCurrent: (_run, decision) => rules.assertCurrent(decision),
    };
    const service = new IntegrationTools(store, interactions, {
      policy,
      authorization: async () => {
        tokenCalls++;
        if (phase === 'token') await pause();
        return 'synthetic-current-access';
      },
      remote: async (_config, options) => {
        factories++;
        return {
          start: async () => {
            options.authorize?.();
          },
          tools: async () => [{ name: 'synthetic_echo', inputSchema: { type: 'object' } }],
          call: async () => {
            await options.onDispatch?.();
            options.authorize?.();
            effects++;
            return { content: [{ type: 'text', text: 'Synthetic' }] };
          },
          close: async () => {},
        };
      },
    });
    const tools = new AgentTools(undefined, new WorkspaceFiles(root), {
      projectAccess: (run, access) => projects.assertScope(run.bot, run.project!, access),
    });
    tools.integrations = service;
    let pending: ReturnType<AgentTools['invoke']> | undefined;
    try {
      await projects.write({
        action: 'create',
        requestId: 'mock-project-create',
        projectId: project.projectId,
        expectedRevision: 0,
        value: { name: 'Synthetic', grants: [{ bot, content: 'write', browser: true }] },
      });
      const target = { bot, connection, revision: 0 };
      const attempt = await store.beginOAuth(
        { ...target, app: 'notion', name: 'Synthetic', requestId: 'mock-start' },
        Date.now() + 600000,
      );
      await store.oauthPhase(target, attempt.attempt, 'waiting');
      await store.oauthPhase(target, attempt.attempt, 'exchanging');
      await store.oauthCommit(target, attempt.attempt, {
        issuer: 'https://mcp.notion.com',
        resource: 'https://mcp.notion.com/mcp',
        tokenEndpoint: 'https://mcp.notion.com/token',
        clientId: 'mock-client',
        redirectUri: 'http://127.0.0.1:45123/oauth/mock',
        accessToken: 'synthetic-expired-access',
        refreshToken: 'synthetic-refresh',
        scope: 'default',
        expiresAt: 1,
      });
      const catalog = await store.catalog(connection, 1, [
        { name: 'synthetic_echo', inputSchema: { type: 'object' } },
      ]);
      await store.bind(bot, {
        connection,
        configRevision: 1,
        bindingRevision: 0,
        catalogDigest: catalog.current.catalogDigest,
        tools: ['synthetic_echo'],
        enabled: true,
      });
      const run = {
        id: 'mock-run',
        bot,
        sessionId: 'mock-session',
        abort: new AbortController(),
        integrations: await store.capture(bot),
        project,
        workdir: root,
        canonicalRoot: root,
        seen: {},
        trace: [],
        toolCount: 0,
        limit: 10,
      };
      const readConfig = store.privateConfig.bind(store);
      vi.spyOn(store, 'privateConfig').mockImplementation(async (id) => {
        const value = await readConfig(id);
        configCalls++;
        if ((phase === 'config' && configCalls === 1) || (phase === 'return' && configCalls === 2))
          await pause();
        return value;
      });
      pending = tools.invoke(run, catalog.tools[0].alias, {}, 'mock-wire');
      const deadline = Date.now() + 3000;
      while (!(await interactions.list()).some((item) => item.status === 'pending')) {
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const approval = (await interactions.list()).find((item) => item.status === 'pending')!;
      await interactions.reply(bot, run.id, approval.id, { kind: 'decision', allow: true });
      await waiting;
      if (change === 'project')
        await projects.write({
          action: 'update',
          requestId: 'mock-project-revoke',
          projectId: project.projectId,
          expectedRevision: 1,
          value: { name: 'Synthetic', grants: [] },
        });
      else
        await rules.write({
          action: 'save',
          requestId: 'mock-rule-edit',
          expectedRevision: 0,
          scope: { kind: 'bot', bot },
          rule: {
            id: 'mock-rule',
            name: 'Synthetic',
            enabled: true,
            effect: 'deny',
            trigger: 'interactive',
            selector: { kind: 'url', url: 'https://example.test/mock' },
          },
        });
      release();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        change === 'project' ? 'PROJECT_SCOPE_STALE' : 'APPROVAL_POLICY_CHANGED',
      );
      expect(factories).toBe(0);
      expect(effects).toBe(0);
      expect(tokenCalls).toBe(phase === 'config' ? 0 : 1);
    } finally {
      release();
      await pending?.catch(() => undefined);
      vi.restoreAllMocks();
      await service.close();
      await rules.close();
      await projects.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('OAuth credentials are resolved before probing while snapshots never gain secrets or tool authority', async () => {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'mock-oauth-tools-')));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  const interactions = new Interactions(path.join(root, 'interactions'));
  let resolved = 0;
  const tools = new IntegrationTools(store, interactions, {
    authorization: async () => {
      resolved++;
      return 'synthetic-valid-access';
    },
    remote: async (config) => {
      expect(resolved).toBe(1);
      expect(config.bearer).toBe('synthetic-valid-access');
      return {
        start: async () => {},
        tools: async () => [{ name: 'synthetic_echo', inputSchema: { type: 'object' } }],
        call: async () => {
          throw new Error('must not execute');
        },
        close: async () => {},
      };
    },
  });
  try {
    const target = { bot: 'mock-a', connection: 'mock-notion', revision: 0 };
    const start = await store.beginOAuth(
      { ...target, app: 'notion', name: 'Synthetic App', requestId: 'mock-start' },
      Date.now() + 600000,
    );
    await store.oauthPhase(target, start.attempt, 'waiting');
    await store.oauthPhase(target, start.attempt, 'exchanging');
    await store.oauthCommit(target, start.attempt, {
      issuer: 'https://mcp.notion.com',
      resource: 'https://mcp.notion.com/mcp',
      clientId: 'mock-client',
      accessToken: 'synthetic-expired-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: 1,
      scope: 'default',
      tokenEndpoint: 'https://mcp.notion.com/token',
      redirectUri: 'http://127.0.0.1:45123/callback/mock',
    });
    await tools.probe(target.connection, 1);
    expect(resolved).toBe(1);
    expect((await store.capture(target.bot)).connections).toEqual([]);
    expect(JSON.stringify(await store.capture(target.bot))).not.toMatch(/synthetic-|token|secret/i);
  } finally {
    await tools.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
