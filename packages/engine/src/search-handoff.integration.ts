import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeRequire } from './dsh.js';

interface Agent {
  id: string;
  session: { id: string };
}
interface Handle {
  agent: Agent;
  dispose(): Promise<unknown>;
}
interface NativeContext {
  on(
    event: 'tools/execute',
    listener: (
      execution: {
        name: string;
        callId: string;
        rootCallId: string;
        token: symbol;
        parent?: symbol;
        agent?: Agent;
        arguments: unknown;
      },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): unknown;
  agents: {
    create(options: {
      sessionId: string;
      parentAgent?: Agent;
      meta?: { cwd: string };
    }): Promise<Handle>;
    roots(): Agent[];
    get(id: string): Agent | undefined;
    isOwnedBy(id: string, owner: Agent): boolean;
  };
  tools: {
    execute(input: {
      name: string;
      callId: string;
      arguments: unknown;
      agent: Agent;
      signal: AbortSignal;
    }): Promise<{ isError: boolean; error?: unknown }>;
  };
  fiber: { dispose(): Promise<unknown> };
}
interface Rpc {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

test('the real SDK patch-loader shares native and PTC registry handoffs across two roots and two children', {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-loader-'));
  const sdkFile = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client');
  const requireDsh = runtimeRequire(sdkFile);
  const { boot } = (await import(
    pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href
  )) as {
    boot(name: string, config: string, patches: unknown[]): Promise<NativeContext>;
  };
  const pluginDir =
    process.env.DABAN_SEARCH_HANDOFF_PLUGIN_DIR || path.dirname(fileURLToPath(import.meta.url));
  const contexts: NativeContext[] = [];
  const handles: Handle[] = [];
  const rpcs: { root: string; rpc: Rpc }[] = [];
  const executions: {
    root: string;
    name: string;
    callId: string;
    rootCallId: string;
    token: symbol;
    parent?: symbol;
    agent: Agent;
    arguments: unknown;
  }[] = [];
  const receipts = new Map<string, { root: string; queries: string[] }>();
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(bytes).toString('utf8')) as Rpc;
      const scope = request.url?.slice(1) || '';
      assert.equal(request.headers.authorization, `Bearer synthetic-${scope}`);
      rpcs.push({ root: scope, rpc });
      let result: unknown = { accepted: true };
      if (rpc.method === 'search.claim') {
        assert.equal(rpc.params.modelAttemptId, `synthetic-${scope}-attempt`);
        assert.equal(rpc.params.sessionId, `synthetic-${scope}-session`);
        if (rpc.params.search !== undefined) {
          assert.ok(object(rpc.params.search));
          assert.ok(Array.isArray(rpc.params.search.queries));
          const queries = rpc.params.search.queries;
          assert.ok(queries.every((query): query is string => typeof query === 'string'));
          const claimId = createHash('sha256')
            .update(JSON.stringify([scope, rpc.params.callId]))
            .digest('hex');
          receipts.set(claimId, { root: scope, queries });
          result = { accepted: true, searchReceipt: { claimId } };
        }
      } else if (rpc.method === 'search.query') {
        const receipt = receipts.get(String(rpc.params.claimId));
        assert.ok(
          receipt && receipt.root === scope && receipt.queries.includes(String(rpc.params.query)),
        );
        result = { sources: [{ url: `https://source.example.test/${scope}` }], truncated: false };
      } else assert.equal(rpc.method, 'attempt.fence');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'SYNTHETIC_LOADER_BRIDGE_FAILURE' }));
    }
  });
  try {
    await new Promise<undefined>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const moduleEntry = (id: string, name: string, config: unknown = {}) => ({
      id,
      name: pathToFileURL(requireDsh.resolve(name)).href,
      config,
    });
    for (const id of ['root-a', 'root-b']) {
      const configFile = path.join(root, `${id}.yml`);
      await writeFile(configFile, '[]\n', { mode: 0o600 });
      const bridge = {
        url: `http://127.0.0.1:${address.port}/${id}`,
        capability: `synthetic-${id}`,
      };
      const entries = [
        moduleEntry('timer', '@deepseek-ai/cordis-plugin-timer'),
        moduleEntry('llm', '@deepseek-ai/dsh-llm'),
        moduleEntry('session', '@deepseek-ai/dsh-session'),
        moduleEntry('session-projection', '@deepseek-ai/dsh-session-projection'),
        moduleEntry('filesystem', '@deepseek-ai/dsh-fs-local', { cwd: root }),
        moduleEntry('working-directory', '@deepseek-ai/dsh-working-directory'),
        moduleEntry('system-prompt', '@deepseek-ai/dsh-system-prompt', {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
        }),
        moduleEntry('tools', '@deepseek-ai/dsh-tools'),
        moduleEntry('agent', '@deepseek-ai/dsh-agent'),
        moduleEntry('agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }),
        moduleEntry('approval', '@deepseek-ai/dsh-user-approval', { policy: 'ask' }),
        moduleEntry('web', '@deepseek-ai/dsh-web', { searchProvider: 'daban-host-search' }),
        moduleEntry('tool-web', '@deepseek-ai/dsh-tool-web', {
          search: true,
          fetch: false,
          searchMaxQueries: 4,
          searchMaxResults: 5,
        }),
        {
          id: 'daban-policy',
          name: pathToFileURL(path.join(pluginDir, 'policy.js')).href,
          config: {
            ...bridge,
            limit: 60,
            urls: [],
            attemptId: `synthetic-${id}-attempt`,
          },
        },
        {
          id: 'host-search',
          name: pathToFileURL(path.join(pluginDir, 'search-provider.js')).href,
          config: { ...bridge, sdkFile, runId: id, revision: 1, available: true },
        },
        {
          id: 'pure-program-runtime',
          name: new URL('./ptc.js', import.meta.url).href,
          config: { sdkFile, active: id === 'root-b' },
        },
      ];
      const ctx = await boot('synthetic-search-loader', configFile, [{ insert: entries }]);
      contexts.push(ctx);
      ctx.on('tools/execute', async (execution, next) => {
        assert.ok(execution.agent);
        executions.push({ ...execution, root: id, agent: execution.agent });
        return next();
      });
      const parent = await ctx.agents.create({
        sessionId: `synthetic-${id}-session`,
        meta: { cwd: root },
      });
      handles.push(parent);
      const child = await ctx.agents.create({
        sessionId: `synthetic-${id}-child`,
        parentAgent: parent.agent,
        meta: { cwd: root },
      });
      handles.push(child);
      assert.deepEqual(ctx.agents.roots(), [parent.agent]);
      assert.equal(ctx.agents.get(child.agent.id), child.agent);
      assert.equal(ctx.agents.isOwnedBy(child.agent.id, parent.agent), true);
    }
    for (const [index, ctx] of contexts.entries()) {
      const own = handles.slice(index * 2, index * 2 + 2);
      await Promise.all(
        own.map(async ({ agent }, member) => {
          const ptc = index === 1 && member === 0;
          const query = ptc ? 'synthetic ptc root-b' : `synthetic query ${agent.id}`;
          const result = await ctx.tools.execute({
            name: ptc ? 'run_code' : 'web_search',
            callId: 'synthetic-reused-provider-id',
            arguments: ptc
              ? {
                  description: 'Synthetic nested search',
                  code: `return await tools.web_search({queries:[${JSON.stringify(query)}]});`,
                }
              : { queries: [query] },
            agent,
            signal: new AbortController().signal,
          });
          assert.equal(result.isError, false, JSON.stringify(result.error));
        }),
      );
      const foreign = handles[(1 - index) * 2 + 1].agent;
      assert.equal(ctx.agents.get(foreign.id), undefined);
      assert.equal(ctx.agents.isOwnedBy(foreign.id, own[0].agent), false);
      const denied = await ctx.tools.execute({
        name: 'web_search',
        callId: 'synthetic-foreign',
        arguments: { queries: ['synthetic unauthorized'] },
        agent: foreign,
        signal: new AbortController().signal,
      });
      assert.equal(denied.isError, true);
    }
    assert.deepEqual(failures, []);
    const claims = rpcs.filter(({ rpc }) => rpc.method === 'search.claim');
    const queries = rpcs.filter(({ rpc }) => rpc.method === 'search.query');
    assert.equal(claims.length, 4);
    assert.equal(queries.length, 4);
    assert.equal(new Set(claims.map(({ rpc }) => rpc.params.callId)).size, 4);
    assert.equal(new Set(queries.map(({ rpc }) => rpc.params.claimId)).size, 4);
    for (const [index, id] of ['root-a', 'root-b'].entries()) {
      const sessions = claims
        .filter(({ root, rpc }) => root === id && object(rpc.params.search))
        .map(({ rpc }) => (rpc.params.search as { executionSessionId: string }).executionSessionId);
      assert.deepEqual(
        sessions.sort(),
        handles
          .slice(index * 2, index * 2 + 2)
          .map(({ agent }) => agent.session.id)
          .sort(),
      );
    }
    const parents = executions.filter((execution) => execution.name === 'run_code');
    assert.equal(parents.length, 1);
    for (const parent of parents) {
      const nested = executions.filter((execution) => execution.parent === parent.token);
      assert.equal(nested.length, 1);
      assert.equal(nested[0].name, 'web_search');
      assert.notEqual(nested[0].token, parent.token);
      assert.equal(nested[0].rootCallId, parent.callId);
      assert.equal(nested[0].agent, parent.agent);
      assert.ok(object(nested[0].arguments) && Array.isArray(nested[0].arguments.queries));
      const declaration = claims.find(
        ({ root, rpc }) =>
          root === parent.root &&
          object(rpc.params.search) &&
          JSON.stringify(rpc.params.search.queries) ===
            JSON.stringify((nested[0].arguments as { queries: unknown[] }).queries),
      );
      assert.ok(declaration && object(declaration.rpc.params.search));
      assert.equal(declaration.rpc.params.search.executionSessionId, parent.agent.session.id);
      const claimId = createHash('sha256')
        .update(JSON.stringify([parent.root, declaration.rpc.params.callId]))
        .digest('hex');
      assert.equal(queries.filter(({ rpc }) => rpc.params.claimId === claimId).length, 1);
    }
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    await new Promise<undefined>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});
