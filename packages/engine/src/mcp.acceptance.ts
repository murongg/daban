import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMcpCatalog, isMcpSaved, type McpCatalog } from '@daban/protocol';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { IntegrationTools } from './integration-tools.js';
import { McpRemote } from './mcp.js';
import { mcpDigest } from './mcp-catalog.js';
import { startPrototype } from './server.js';
import { tlsFixture } from './tls.fixture.js';

export async function acceptMcp(output: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-mcp-model-'));
  const key = '/var/lib/bot-prototype/model/credentials.json';
  const before = await stat(key);
  const keyHash = createHash('sha256')
    .update(await readFile(key))
    .digest('hex');
  const marker = `SYNTHETIC-MCP-${randomBytes(12).toString('hex')}`;
  let factories = 0;
  let effects = 0;
  const errors: unknown[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'synthetic-daban-service', version: '1.0' });
      server.registerTool(
        'synthetic_echo',
        {
          description: '合成验收专用工具，返回服务端生成的唯一标记。',
          inputSchema: fromJsonSchema<{ value: string }>({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          }),
        },
        async () => {
          effects++;
          return { content: [{ type: 'text', text: marker }] };
        },
      );
      return server;
    },
    { legacy: 'reject', responseMode: 'sse' },
  );
  const handle = toNodeHandler(handler);
  const fixture = await tlsFixture((req, res) =>
    handle(req, res).catch((error) => {
      errors.push(error);
      res.destroy();
    }),
  );
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await symlink(key, path.join(root, 'model/credentials.json'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const turns: {
    bot: string;
    session?: string;
    tools: string[];
    result: string;
    approvals: number;
    effects: number;
  }[] = [];
  try {
    assert.ok(app.models);
    const models = app.models;
    const api = async (route: string, data?: unknown) => {
      const response = await fetch(app.url + route, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          'x-prototype-token': app.token,
          ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    assert.equal((await api('/api/state')).clientProtocol, 30);
    await models.tools.integrations!.close();
    models.tools.integrations = new IntegrationTools(models.integrations, models.interactions, {
      remote: async (config, transport) => {
        factories++;
        return new McpRemote(config, { ...fixture, ...transport });
      },
    });
    for (const id of ['mock-mcp-a', 'mock-mcp-b'])
      await models.profiles.register({
        id,
        name: `合成 ${id}`,
        instructions: '',
        memory: 'SYNTHETIC-MCP-MEMORY',
        color: 'mint',
        model: 'deepseek-flash',
      });
    const saved = await api('/api/mcp/save', {
      type: 'mcp.save',
      input: {
        requestId: 'mock-mcp-create',
        id: 'mock-mcp-connection',
        revision: 0,
        name: '合成外部服务',
        endpoint: fixture.endpoint,
        bearer: 'synthetic-mcp-bearer',
      },
    });
    assert.ok(isMcpSaved(saved));
    assert.equal(JSON.stringify(saved).includes('synthetic-mcp-bearer'), false);
    const catalog: McpCatalog = await api('/api/mcp/check', {
      type: 'mcp.check',
      id: 'mock-mcp-connection',
      revision: 1,
    });
    assert.ok(isMcpCatalog(catalog));
    assert.equal(effects, 0);
    await api('/api/mcp/bind', {
      type: 'mcp.bind',
      bot: 'mock-mcp-a',
      input: {
        connection: 'mock-mcp-connection',
        configRevision: 1,
        bindingRevision: 0,
        catalogDigest: catalog.current.catalogDigest!,
        tools: ['synthetic_echo'],
        enabled: true,
      },
    });
    async function turn(
      bot: string,
      id: string,
      prompt: string,
      decision?: { value: string; allow: boolean },
    ) {
      const beforeEffects = effects;
      const accepted = await api(`/api/bots/${bot}/model`, {
        running: true,
        task: { requestId: id, prompt },
      });
      assert.equal(accepted.requestId, id);
      const job = models.jobs.get(bot)!;
      let approvals = 0;
      const answered = new Set<string>();
      const timer = setTimeout(() => {
        models.stop(bot, 'synthetic-mcp-timeout').catch(() => {});
      }, 120000);
      try {
        while (job.running) {
          for (const item of await models.interactions.list()) {
            if (
              item.bot !== bot ||
              item.runId !== job.id ||
              item.status !== 'pending' ||
              answered.has(item.id)
            )
              continue;
            assert.ok(decision, 'This synthetic turn must not request human input');
            assert.equal(item.kind, 'approval');
            assert.ok(item.kind === 'approval' && item.tool === 'mcp_call');
            assert.equal(item.connection, 'mock-mcp-connection');
            assert.equal(item.operation, 'synthetic_echo');
            assert.equal(item.inputHash, mcpDigest({ value: decision.value }));
            assert.equal(item.origin, new URL(fixture.endpoint).origin);
            assert.ok(++approvals <= 2, 'Synthetic task must not loop on refused approvals');
            answered.add(item.id);
            await api(`/api/bots/${bot}/reply`, {
              id: item.id,
              runId: job.id,
              reply: { kind: 'decision', allow: decision.allow },
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await job.done;
        assert.equal(job.phase, 'completed', job.error);
        const proof = {
          bot,
          session: job.sessionId,
          tools: job.trace.map((item) => item.name),
          result: job.result,
          approvals,
          effects: effects - beforeEffects,
        };
        turns.push(proof);
        return proof;
      } finally {
        clearTimeout(timer);
      }
    }
    const beforeHello = factories;
    const hello = await turn(
      'mock-mcp-a',
      'mock-mcp-hello',
      '普通问候验收：只回复 MCP-HELLO，不使用任何工具。',
    );
    assert.equal(hello.tools.length, 0);
    assert.equal(factories, beforeHello);
    const allowed = await turn(
      'mock-mcp-a',
      'mock-mcp-allowed',
      '这是已配置连接的合成验收。请调用外部 synthetic_echo 工具，参数严格为 {"value":"approved"}，等待人类本次审批；成功后只回复它实际返回的唯一标记，不猜测，不用其他工具。',
      { value: 'approved', allow: true },
    );
    assert.ok(allowed.result.includes(marker));
    assert.equal(allowed.effects, 1);
    assert.equal(allowed.approvals, 1);
    assert.ok(allowed.tools.includes(catalog.tools[0].alias));
    const beforeOther = factories;
    const other = await turn(
      'mock-mcp-b',
      'mock-mcp-other',
      '普通问候验收：只回复 MCP-OTHER，不使用任何工具。',
    );
    assert.equal(other.tools.length, 0);
    assert.equal(factories, beforeOther);
    const refused = await turn(
      'mock-mcp-a',
      'mock-mcp-refused',
      '请调用外部 synthetic_echo，参数严格为 {"value":"denied"}，等待本次审批。如果被拒绝，简单告知未执行，不重试、不换工具或参数，也不要复述之前的工具返回值。',
      { value: 'denied', allow: false },
    );
    assert.equal(refused.approvals, 1);
    assert.equal(refused.effects, 0);
    const history = await api('/api/mcp/calls', { type: 'mcp.calls', bot: 'mock-mcp-a' });
    assert.equal(history.items.length, 2);
    assert.ok(history.items.some((item: { phase: string }) => item.phase === 'settled'));
    assert.ok(history.items.some((item: { phase: string }) => item.phase === 'denied'));
    assert.equal(app.runtime.status().items.length, 0);
    assert.deepEqual(errors, []);
    const after = await stat(key);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(
      createHash('sha256')
        .update(await readFile(key))
        .digest('hex'),
      keyHash,
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          verified: true,
          scope:
            'isolated native DSH with authenticated MCP setup/task/approval/receipt API; no settings UI or original Electron activation',
          clientProtocol: 24,
          protocol: '2026-07-28',
          paidTaskTurns: turns.length,
          effects,
          factories,
          turns,
          originalKeyUnchanged: true,
          graphicsAllocated: 0,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await app.close();
    await fixture.close();
    await handler.close();
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await acceptMcp(process.argv[2] || '/tmp/daban-mcp-model.json');
