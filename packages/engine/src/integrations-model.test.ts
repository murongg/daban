import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { IntegrationTools } from './integration-tools.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('DSH tools use the accepted Bot catalog, one-time approvals and shared budgets without sending credentials to the harness', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-mcp-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let entered!: () => unknown;
  let release!: () => unknown;
  let enteredRun = Promise.resolve<unknown>(undefined);
  let gate = Promise.resolve<unknown>(undefined);
  let sequence = 0;
  const resumed: string[] = [];
  const contexts: string[] = [];
  class Harness {
    constructor(readonly options: { cwd: string }) {}
    async start() {}
    async close() {
      release?.();
    }
    session(id = `mock-mcp-session-${++sequence}`) {
      return {
        id,
        run: async (prompt: unknown) => {
          expect.assert(typeof prompt === 'string');
          contexts.push(await readFile(path.join(this.options.cwd, 'task-context.json'), 'utf8'));
          entered();
          await gate;
          return { sessionId: id, finalResponse: 'SYNTHETIC-MCP-ANSWER' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns(options);
  let factories = 0;
  let effects = 0;
  const offered = [
    {
      name: 'synthetic_echo',
      description: '合成回声',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  ];
  const endpoint = 'https://mcp.example.test/mcp?token=synthetic-model-query';
  const bearer = 'synthetic-model-bearer';
  async function start(bot: string, requestId: string) {
    enteredRun = new Promise((resolve) => {
      entered = () => resolve(undefined);
    });
    gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    await models.start(bot, { requestId, prompt: '合成普通问候' });
    await enteredRun;
    return models.jobs.get(bot)!;
  }
  async function finish(bot: string) {
    const job = models.jobs.get(bot)!;
    release();
    await job.done;
    expect(job.phase).toBe('completed');
    return job.sessionId;
  }
  try {
    await settings.save({ apiKey: 'synthetic-mcp-model-key' });
    await models.ready;
    await models.tools.integrations!.close();
    models.tools.integrations = new IntegrationTools(models.integrations, models.interactions, {
      remote: async (_config, transport) => {
        factories++;
        return {
          start: async () => {},
          tools: async () => offered,
          call: async (_name, args) => {
            await transport.onDispatch?.();
            effects++;
            return { content: [{ type: 'text', text: `SYNTHETIC:${args.value}:${bearer}` }] };
          },
          close: async () => {},
        };
      },
    });
    const plain = await start('mock-a', 'mock-mcp-plain');
    expect(factories).toBe(0);
    expect(plain.integrations?.connections.length).toBe(0);
    const firstSession = await finish('mock-a');
    await models.integrations.save({
      requestId: 'mock-create',
      id: 'mock-connection',
      revision: 0,
      name: '合成连接',
      endpoint,
      bearer,
    });
    const catalog = await models.integrations.catalog('mock-connection', 1, offered);
    await models.integrations.bind('mock-a', {
      connection: 'mock-connection',
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: catalog.current.catalogDigest!,
      tools: ['synthetic_echo'],
      enabled: true,
    });
    const job = await start('mock-a', 'mock-mcp-enabled');
    expect(job.sessionId).not.toBe(firstSession);
    const rpc = (id: string, method: string, params?: Record<string, unknown>) =>
      models.rpc('mock-a', `Bearer ${job.token}`, { jsonrpc: '2.0', id, method, params });
    const listed = await rpc('mock-list', 'tools/list');
    expect.assert(JSON.stringify(listed).includes(catalog.tools[0].alias));
    expect(JSON.stringify(listed).includes(bearer)).toBe(false);
    expect(JSON.stringify(listed).includes(endpoint)).toBe(false);
    expect(factories).toBe(0);
    const params = { name: catalog.tools[0].alias, arguments: { value: '47' } };
    const pending = rpc('mock-call', 'tools/call', params);
    const end = Date.now() + 3000;
    while (!(await models.interactions.list()).some((item) => item.status === 'pending')) {
      expect.assert(Date.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const approval = (await models.interactions.list()).find((item) => item.status === 'pending')!;
    expect(factories).toBe(0);
    await models.interactions.reply('mock-a', job.id, approval.id, {
      kind: 'decision',
      allow: true,
    });
    const result = await pending;
    expect.assert(JSON.stringify(result).includes('SYNTHETIC:47'));
    expect(JSON.stringify(result).includes(bearer)).toBe(false);
    expect(effects).toBe(1);
    expect(job.toolCount).toBe(1);
    expect(job.trace.at(-1)?.surface).toBe('integration');
    await rpc('mock-call', 'tools/call', params);
    expect(effects).toBe(1);
    job.onLimit = () => {};
    job.limit = job.toolCount;
    expect.assert(
      JSON.stringify(
        await rpc('mock-budget', 'tools/call', { ...params, arguments: { value: '48' } }),
      ).includes('TOOL_LIMIT'),
    );
    expect(effects).toBe(1);
    const enabledSession = await finish('mock-a');
    const journal = JSON.stringify(models.journal.history('mock-a'));
    expect(journal.includes(bearer)).toBe(false);
    const patch = await readFile(path.join(job.privateDir, 'computer.patch.yml'), 'utf8');
    expect(patch.includes(bearer)).toBe(false);
    expect(patch.includes(endpoint)).toBe(false);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await start('mock-a', 'mock-mcp-restart');
    expect(await finish('mock-a')).toBe(enabledSession);
    expect.assert(resumed.includes(enabledSession!));
    await models.integrations.save({
      requestId: 'mock-reconfigure',
      id: 'mock-connection',
      revision: 1,
      name: '合成新连接',
    });
    const changed = await start('mock-a', 'mock-mcp-changed');
    expect(changed.sessionId).not.toBe(enabledSession);
    expect(changed.integrations?.connections.length).toBe(0);
    await finish('mock-a');
    expect(contexts.at(-1)).toContain('recheck');
    expect(contexts.at(-1)).not.toContain(bearer);
    const other = await start('mock-b', 'mock-mcp-other');
    expect(other.integrations?.connections.length).toBe(0);
    await finish('mock-b');
  } finally {
    release?.();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
