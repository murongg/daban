import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  const prompts: string[] = [];
  class Harness {
    async start() {}
    async close() {
      release?.();
    }
    session(id = `mock-mcp-session-${++sequence}`) {
      return {
        id,
        run: async (prompt: unknown) => {
          assert.ok(typeof prompt === 'string');
          prompts.push(prompt);
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
    assert.equal(job.phase, 'completed');
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
    assert.equal(factories, 0);
    assert.equal(plain.integrations?.connections.length, 0);
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
    assert.notEqual(job.sessionId, firstSession);
    const rpc = (id: string, method: string, params?: Record<string, unknown>) =>
      models.rpc('mock-a', `Bearer ${job.token}`, { jsonrpc: '2.0', id, method, params });
    const listed = await rpc('mock-list', 'tools/list');
    assert.ok(JSON.stringify(listed).includes(catalog.tools[0].alias));
    assert.equal(JSON.stringify(listed).includes(bearer), false);
    assert.equal(JSON.stringify(listed).includes(endpoint), false);
    assert.equal(factories, 0);
    const params = { name: catalog.tools[0].alias, arguments: { value: '47' } };
    const pending = rpc('mock-call', 'tools/call', params);
    const end = Date.now() + 3000;
    while (!(await models.interactions.list()).some((item) => item.status === 'pending')) {
      assert.ok(Date.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const approval = (await models.interactions.list()).find((item) => item.status === 'pending')!;
    assert.equal(factories, 0);
    await models.interactions.reply('mock-a', job.id, approval.id, {
      kind: 'decision',
      allow: true,
    });
    const result = await pending;
    assert.ok(JSON.stringify(result).includes('SYNTHETIC:47'));
    assert.equal(JSON.stringify(result).includes(bearer), false);
    assert.equal(effects, 1);
    assert.equal(job.toolCount, 1);
    assert.equal(job.trace.at(-1)?.surface, 'integration');
    await rpc('mock-call', 'tools/call', params);
    assert.equal(effects, 1);
    job.onLimit = () => {};
    job.limit = job.toolCount;
    assert.ok(
      JSON.stringify(
        await rpc('mock-budget', 'tools/call', { ...params, arguments: { value: '48' } }),
      ).includes('TOOL_LIMIT'),
    );
    assert.equal(effects, 1);
    const enabledSession = await finish('mock-a');
    const journal = JSON.stringify(models.journal.history('mock-a'));
    assert.equal(journal.includes(bearer), false);
    const patch = await readFile(path.join(job.privateDir, 'computer.patch.yml'), 'utf8');
    assert.equal(patch.includes(bearer), false);
    assert.equal(patch.includes(endpoint), false);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await start('mock-a', 'mock-mcp-restart');
    assert.equal(await finish('mock-a'), enabledSession);
    assert.ok(resumed.includes(enabledSession!));
    await models.integrations.save({
      requestId: 'mock-reconfigure',
      id: 'mock-connection',
      revision: 1,
      name: '合成新连接',
    });
    const changed = await start('mock-a', 'mock-mcp-changed');
    assert.notEqual(changed.sessionId, enabledSession);
    assert.equal(changed.integrations?.connections.length, 0);
    await finish('mock-a');
    assert.ok(prompts.at(-1)?.includes('重新核对'));
    const other = await start('mock-b', 'mock-mcp-other');
    assert.equal(other.integrations?.connections.length, 0);
    await finish('mock-b');
  } finally {
    release?.();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
