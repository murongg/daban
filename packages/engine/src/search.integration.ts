import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SearchResult } from '@daban/protocol';
import { runtimeRequire } from './dsh.js';
import { ModelRuns } from './model.js';
import { apply as policy } from './policy.js';
import { SearchClient } from './search.js';
import { type SearchProviderContext, apply as searchProvider } from './search-provider.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';
import { apply as webReader } from './web-read.js';

const sdkFile = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client');
const sourceUrl = 'https://source.example.test/original?edition=synthetic';
const snippetUrl = 'https://snippet.example.test/untrusted';
const searchKey = 'synthetic-independent-brave-key';
const modelKey = 'synthetic-custom-inference-key';
const suppliedResult = () =>
  Response.json({
    web: {
      results: [
        {
          url: sourceUrl,
          title: 'Synthetic source',
          description: `Synthetic snippet containing ${snippetUrl}`,
        },
      ],
    },
  });
interface Outcome {
  isError: boolean;
  value?: unknown;
  error?: unknown;
  content?: unknown;
}
interface NativeContext {
  provide(name: string, value: unknown): unknown;
  plugin(plugin: unknown, config?: unknown): Promise<unknown>;
  tools: { execute(input: unknown): Promise<Outcome>; get(name: string, scope?: unknown): unknown };
  web: { registerFetchProvider(provider: unknown): unknown };
  fiber: { dispose(): Promise<unknown> };
}
interface Rpc {
  jsonrpc: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

async function fixture(supplier: typeof fetch = async () => suppliedResult(), legacy = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-integration-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-text' }] }),
  );
  await writeFile(settings.file, JSON.stringify({ apiKey: 'synthetic-old-deepseek-key' }), {
    mode: 0o600,
  });
  const supplierCalls: { url: string; headers: Headers }[] = [];
  const search = new SearchSettings(
    path.join(root, 'search.json'),
    settings,
    new SearchClient(async (input, init) => {
      supplierCalls.push({ url: String(input), headers: new Headers(init?.headers) });
      return supplier(input, init);
    }),
  );
  if (legacy)
    await writeFile(
      search.file,
      JSON.stringify({
        version: 1,
        revision: 0,
        checkRevision: 0,
        enabled: true,
        provider: 'deepseek',
        credential: { kind: 'legacy-linked', connection: 'deepseek-official' },
      }),
      { mode: 0o600 },
    );
  let entered = () => {};
  let release = () => {};
  let gate = Promise.resolve<unknown>(undefined);
  let observed: ((note: unknown) => unknown) | undefined;
  let sequence = 0;
  let eventSequence = 0;
  const environments: NodeJS.ProcessEnv[] = [];
  class Harness {
    constructor(options: { env: NodeJS.ProcessEnv }) {
      environments.push(options.env);
    }
    async start() {}
    async close() {
      release();
    }
    session(id = `mock-search-session-${++sequence}`) {
      return {
        id,
        run: async (_prompt: unknown, observer: { onNotification(note: unknown): unknown }) => {
          observed = observer.onNotification;
          entered();
          await gate;
          return { sessionId: id, finalResponse: 'SYNTHETIC SEARCH COMPLETE' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    search,
    Harness,
    sdkFile,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  await models.ready;
  await models.profiles.register({
    id: 'mock-search-bot',
    name: 'Synthetic search Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  async function start(
    requestId: string,
    prompt = 'Synthetic research with optional public web tools.',
  ) {
    const started = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    gate = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    await models.startHuman('mock-search-bot', { requestId, prompt });
    await started;
    const job = models.jobs.get('mock-search-bot');
    assert.ok(job?.sessionId);
    return job;
  }
  async function finish() {
    const job = models.jobs.get('mock-search-bot');
    assert.ok(job);
    release();
    await job.done;
    assert.equal(job.phase, 'completed', job.error);
  }
  function notify(sessionId: string, type: string, data: unknown) {
    observed?.({
      method: 'session.event',
      params: { sessionId, event: { type, data, seq: ++eventSequence, time: Date.now() } },
    });
  }
  async function close() {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
  return {
    root,
    settings,
    search,
    models,
    supplierCalls,
    environments,
    start,
    finish,
    notify,
    close,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Job = Awaited<ReturnType<Fixture['start']>>;

async function pipeline(f: Fixture, job: Job, urls: string[] = []) {
  assert.ok(job.sessionId);
  const requireDsh = runtimeRequire(sdkFile);
  const cordis = (await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href)) as {
    Context: new () => NativeContext;
  };
  const tools = (await import(
    pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tools')).href
  )) as { ToolRuntime: unknown };
  const web = (await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-web')).href)) as {
    WebRuntime: unknown;
  };
  const native = (await import(
    pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tool-web')).href
  )) as {
    applyWebSearchTool(
      ctx: unknown,
      results: number,
      queries: number,
      timeout: number,
      fetch: boolean,
    ): unknown;
  };
  const ctx = new cordis.Context();
  const rootAgent = { id: 'mock-search-root', session: { id: job.sessionId } };
  const approvals: string[] = [];
  const reads: string[] = [];
  const rpcs: Rpc[] = [];
  const bridgeErrors: string[] = [];
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 1 });
  ctx.provide('agents', {
    roots: () => [rootAgent],
    get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
    isOwnedBy: () => false,
  });
  ctx.provide('approval', {
    request: async (request: { reason: string }) => {
      approvals.push(request.reason);
      return 'rejected';
    },
  });
  await ctx.plugin(tools.ToolRuntime);
  await ctx.plugin(web.WebRuntime, {
    searchProvider: 'daban-host-search',
    fetchProvider: 'synthetic-http',
  });
  const capture = job.searchCapture;
  assert.ok(capture);
  const bridge = {
    url: 'http://127.0.0.1:12345/mcp/mock-search-bot',
    capability: job.token,
  };
  const request = async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${bridge.capability}`);
    const rpc = JSON.parse(String(init.body)) as Rpc;
    if (rpc.method === 'search.query') rpcs.push(rpc);
    return Response.json(
      await f.models
        .rpc('mock-search-bot', `Bearer ${bridge.capability}`, rpc)
        .catch((error: unknown) => {
          bridgeErrors.push(
            `${rpc.method}:${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }),
    );
  };
  policy(
    ctx as unknown as Parameters<typeof policy>[0],
    { ...bridge, limit: job.limit, urls, attemptId: job.attemptId },
    request,
  );
  await searchProvider(
    ctx as unknown as SearchProviderContext,
    {
      sdkFile,
      ...bridge,
      runId: job.id,
      revision: capture.revision,
      available: capture.available,
    },
    request,
  );
  if (capture.available) native.applyWebSearchTool(ctx, 5, 4, 30000, true);
  ctx.web.registerFetchProvider({
    id: 'synthetic-http',
    available: () => true,
    fetch: async (input: { url: string }, signal: AbortSignal) => {
      signal.throwIfAborted();
      reads.push(input.url);
      return {
        url: input.url,
        statusCode: 200,
        body: { kind: 'text', content: 'SYNTHETIC ORIGINAL ARTICLE' },
        truncated: false,
      };
    },
  });
  await webReader(ctx as unknown as Parameters<typeof webReader>[0], { sdkFile });
  async function execute(name: string, args: unknown, callId: string, signal = job.abort.signal) {
    f.notify(job.sessionId!, 'tool/call', { name, callId, arguments: JSON.stringify(args) });
    const result = await ctx.tools.execute({
      name,
      arguments: args,
      callId,
      agent: rootAgent,
      signal,
    });
    f.notify(job.sessionId!, 'tool/result', {
      message: {
        toolCallId: callId,
        isError: result.isError,
        content: Array.isArray(result.content) ? result.content : [],
      },
      error: result.error,
    });
    return result;
  }
  return {
    ctx,
    approvals,
    reads,
    rpcs,
    bridgeErrors,
    execute,
    async close() {
      await ctx.fiber.dispose();
    },
  };
}

test('saved legacy settings, independent Brave and exact-source reading work with a non-DeepSeek model and no computer', {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  let p: Awaited<ReturnType<typeof pipeline>> | undefined;
  try {
    assert.equal((await f.search.status()).credentialSource, 'legacy-linked');
    const linked = await readFile(f.search.file, 'utf8');
    assert.match(linked, /deepseek-official/);
    assert.doesNotMatch(linked, /synthetic-old-deepseek-key/);
    const original = await f.search.capture();
    await f.settings.configure({
      requestId: 'mock-custom-model',
      revision: 0,
      model: 'provider:mock-reasoner:mock-text',
      apiKey: modelKey,
      connection: {
        id: 'mock-reasoner',
        name: 'Synthetic reasoner',
        baseURL: 'https://inference.example.test/v1',
        models: [
          {
            id: 'mock-text',
            name: 'Synthetic text',
            vision: false,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    });
    assert.equal((await f.search.capture()).binding, original.binding);
    assert.equal(f.supplierCalls.length, 0);
    await f.search.configure({
      requestId: 'mock-brave-config',
      revision: 0,
      provider: 'brave',
      enabled: true,
      key: searchKey,
    });
    assert.equal(f.supplierCalls.length, 0);
    const job = await f.start('mock-search-task');
    assert.equal(job.route?.provider, 'mock-reasoner');
    assert.equal(f.models.runtime, undefined);
    assert.equal(f.environments.at(-1)?.DABAN_MODEL_KEY, modelKey);
    assert.equal(f.environments.at(-1)?.DEEPSEEK_API_KEY, undefined);
    assert.ok(!JSON.stringify(f.environments).includes(searchKey));
    const patch = await readFile(path.join(job.privateDir!, 'computer.patch.yml'), 'utf8');
    assert.match(patch, /daban-host-search/);
    assert.match(patch, /dsh-tool-web/);
    assert.ok(!patch.includes(searchKey));
    assert.ok(!patch.includes('dsh-web-deepseek-api'));
    p = await pipeline(f, job);
    const searched = await p.execute(
      'web_search',
      { queries: ['synthetic first query', 'synthetic second query'] },
      'mock-native-search',
    );
    assert.equal(searched.isError, false, JSON.stringify(searched));
    assert.deepEqual(
      (searched.value as SearchResult).sources.map((source) => source.url),
      [sourceUrl],
    );
    assert.equal(f.supplierCalls.length, 2);
    assert.ok(
      f.supplierCalls.every((call) =>
        call.url.startsWith('https://api.search.brave.com/res/v1/web/search?'),
      ),
    );
    assert.ok(
      f.supplierCalls.every(
        (call) =>
          call.headers.get('x-subscription-token') === searchKey &&
          !call.headers.has('authorization'),
      ),
    );
    assert.equal(job.toolCount, 1, 'private RPC and the native tool event share one tool count');
    assert.equal(p.rpcs.length, 2);
    const firstRpc = p.rpcs[0];
    assert.deepEqual(await f.models.rpc('mock-search-bot', `Bearer ${job.token}`, firstRpc), {
      jsonrpc: '2.0',
      id: firstRpc.id,
      result: {
        sources: [
          {
            url: sourceUrl,
            title: 'Synthetic source',
            snippet: `Synthetic snippet containing ${snippetUrl}`,
          },
        ],
        truncated: false,
      },
    });
    assert.equal(f.supplierCalls.length, 2);
    await assert.rejects(
      f.models.rpc('mock-search-bot', 'Bearer synthetic-wrong-token', firstRpc),
      { code: 'UNAUTHORIZED' },
    );
    await assert.rejects(f.models.rpc('mock-other-bot', `Bearer ${job.token}`, firstRpc), {
      code: 'UNAUTHORIZED',
    });
    const forged = await f.models.rpc('mock-search-bot', `Bearer ${job.token}`, {
      ...firstRpc,
      id: 'mock-foreign-session',
      params: { ...firstRpc.params, claimId: '0'.repeat(64) },
    });
    assert.match(JSON.stringify(forged), /UNAUTHORIZED/);
    assert.equal(f.supplierCalls.length, 2);
    const fetched = await p.execute('web_fetch', { url: sourceUrl }, 'mock-read-original');
    assert.equal(fetched.isError, false, JSON.stringify({ fetched, bridgeErrors: p.bridgeErrors }));
    assert.match(JSON.stringify(fetched.value), /SYNTHETIC ORIGINAL ARTICLE/);
    assert.deepEqual(p.reads, [sourceUrl]);
    assert.equal(p.approvals.length, 0);
    assert.equal(
      (await p.execute('web_fetch', { url: `${sourceUrl}&extra=synthetic` }, 'mock-read-altered'))
        .isError,
      true,
    );
    assert.equal(
      (await p.execute('web_fetch', { url: snippetUrl }, 'mock-read-snippet')).isError,
      true,
    );
    assert.equal(p.approvals.length, 2);
    assert.deepEqual(p.reads, [sourceUrl]);
    await f.finish();
    const record = await f.models.journal.read('mock-search-bot', job.id);
    assert.deepEqual(record?.search, { provider: 'brave', revision: 1 });
    const journal = await readFile(path.join(f.models.journal.dir, `${job.id}.json`), 'utf8');
    assert.ok(!journal.includes(searchKey));
    assert.ok(!journal.includes('synthetic first query'));
    assert.ok(!journal.includes('Synthetic snippet'));
    await p.close();
    p = undefined;
    await f.search.configure({
      requestId: 'mock-disable-search',
      revision: 1,
      provider: 'brave',
      enabled: false,
    });
    const disabled = await f.start('mock-disabled-task');
    const disabledPatch = await readFile(
      path.join(disabled.privateDir!, 'computer.patch.yml'),
      'utf8',
    );
    assert.ok(!disabledPatch.includes('daban-host-search'));
    p = await pipeline(f, disabled);
    assert.equal(p.ctx.tools.get('web_search'), undefined);
    assert.ok(p.ctx.tools.get('web_fetch'));
    assert.equal(
      (await p.execute('web_fetch', { url: sourceUrl }, 'mock-old-source')).isError,
      true,
    );
    assert.deepEqual(p.reads, [], 'source authority does not survive a resumed task');
    await f.finish();
    await p.close();
    const explicit = await f.start(
      'mock-explicit-fetch',
      `Synthetic explicit public URL read ${sourceUrl}`,
    );
    p = await pipeline(f, explicit, [sourceUrl]);
    assert.equal(
      (await p.execute('web_fetch', { url: sourceUrl }, 'mock-disabled-fetch')).isError,
      false,
    );
    assert.equal(f.supplierCalls.length, 2);
    await f.finish();
    await p.close();
    p = undefined;
    const reopened = new SearchSettings(f.search.file, f.settings, {
      query: async () => {
        throw new Error('Restart must not search');
      },
    });
    assert.equal((await reopened.status()).enabled, false);
    assert.deepEqual(
      await reopened.saved({ kind: 'configure', requestId: 'mock-disable-search' }),
      await f.search.saved({ kind: 'configure', requestId: 'mock-disable-search' }),
    );
  } finally {
    await p?.close();
    await f.close();
  }
});

for (const change of ['stop', 'configure'] as const)
  test(`late ${change} search results never enter source authority`, {
    timeout: 15000,
  }, async () => {
    let deliver: ((response: Response) => unknown) | undefined;
    const outbound = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    let dispatched = () => {};
    const reached = new Promise<unknown>((resolve) => {
      dispatched = () => resolve(undefined);
    });
    const f = await fixture(async () => {
      dispatched();
      return outbound;
    });
    let p: Awaited<ReturnType<typeof pipeline>> | undefined;
    try {
      await f.search.configure({
        requestId: 'mock-late-config',
        revision: 0,
        provider: 'brave',
        enabled: true,
        key: searchKey,
      });
      const job = await f.start(`mock-${change}-task`);
      p = await pipeline(f, job);
      const pending = p.execute(
        'web_search',
        { queries: ['synthetic delayed query'] },
        'mock-delayed-call',
      );
      await reached;
      if (change === 'stop') await f.models.stop('mock-search-bot');
      else
        await f.search.configure({
          requestId: 'mock-replace-config',
          revision: 1,
          provider: 'brave',
          enabled: true,
          key: 'synthetic-replacement-brave-key',
        });
      deliver?.(suppliedResult());
      const failed = await pending;
      assert.equal(failed.isError, true, JSON.stringify(failed));
      assert.ok(!JSON.stringify(failed.value ?? null).includes(sourceUrl));
      assert.equal(f.supplierCalls.length, 1);
      const read = await p.execute(
        'web_fetch',
        { url: sourceUrl },
        'mock-after-late',
        new AbortController().signal,
      );
      assert.equal(read.isError, true);
      assert.deepEqual(p.reads, []);
      assert.equal(p.approvals.length, change === 'stop' ? 0 : 1);
      if (change === 'configure') await f.finish();
    } finally {
      deliver?.(suppliedResult());
      await p?.close();
      await f.close();
    }
  });

test('the installed DSH pipeline keeps parallel tool batches separate and enforces its four-query boundary', {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  let p: Awaited<ReturnType<typeof pipeline>> | undefined;
  try {
    await f.search.configure({
      requestId: 'mock-parallel-config',
      revision: 0,
      provider: 'brave',
      enabled: true,
      key: searchKey,
    });
    const job = await f.start('mock-parallel-task');
    p = await pipeline(f, job);
    const excessive = await p.execute(
      'web_search',
      {
        queries: [
          'synthetic one',
          'synthetic two',
          'synthetic three',
          'synthetic four',
          'synthetic five',
        ],
      },
      'mock-too-many',
    );
    assert.equal(excessive.isError, true);
    assert.equal(f.supplierCalls.length, 0);
    const outcomes = await Promise.all([
      p.execute('web_search', { queries: ['synthetic parallel first'] }, 'mock-parallel-first'),
      p.execute('web_search', { queries: ['synthetic parallel second'] }, 'mock-parallel-second'),
    ]);
    assert.ok(
      outcomes.every((outcome) => !outcome.isError),
      JSON.stringify(outcomes),
    );
    assert.equal(f.supplierCalls.length, 2);
    assert.deepEqual(p.rpcs.map((rpc) => rpc.params.query).sort(), [
      'synthetic parallel first',
      'synthetic parallel second',
    ]);
    assert.equal(new Set(p.rpcs.map((rpc) => rpc.params.claimId)).size, 2);
    assert.equal(
      job.toolCount,
      2,
      'two admitted executions project once each; the invalid five-query declaration obtains no claim',
    );
    assert.equal(
      job.attemptToolCount,
      3,
      'registry progress includes the rejected call but grants no search authority',
    );
    assert.equal(job.searchClaims?.length, 2);
    await f.finish();
  } finally {
    await p?.close();
    await f.close();
  }
});

test('default keyless DuckDuckGo uses the stock SDK search pipeline and one shared execution claim', {
  timeout: 15000,
}, async () => {
  const f = await fixture(
    async () =>
      new Response(
        `<html><body><table><tr><td><a class="result-link" href="${sourceUrl}">Synthetic DuckDuckGo source</a></td></tr><tr><td class="result-snippet">Synthetic keyless result</td></tr></table></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
    false,
  );
  let p: Awaited<ReturnType<typeof pipeline>> | undefined;
  try {
    assert.equal((await f.search.status()).provider, 'duckduckgo');
    assert.equal(f.supplierCalls.length, 0);
    const job = await f.start('mock-keyless-task');
    p = await pipeline(f, job);
    const result = await p.execute(
      'web_search',
      { queries: ['synthetic first', 'synthetic second'] },
      'mock-keyless-execution',
    );
    assert.equal(result.isError, false, JSON.stringify(result.error));
    assert.equal(f.supplierCalls.length, 2);
    for (const call of f.supplierCalls) {
      assert.equal(new URL(call.url).origin, 'https://lite.duckduckgo.com');
      assert.equal(call.headers.has('authorization'), false);
      assert.equal(call.headers.has('x-subscription-token'), false);
    }
    assert.equal(job.toolCount, 1);
    assert.equal(job.attemptToolCount, 1);
    assert.equal(new Set(p.rpcs.map((rpc) => rpc.params.claimId)).size, 1);
    const fetched = await p.execute('web_fetch', { url: sourceUrl }, 'mock-keyless-source-read');
    assert.equal(fetched.isError, false, JSON.stringify(fetched.error));
    assert.ok(fetched.content);
    const rejected = await p.execute(
      'web_fetch',
      { url: snippetUrl },
      'mock-keyless-untrusted-read',
    );
    assert.equal(rejected.isError, true);
    await f.finish();
    assert.equal((await f.models.journal.read(job.bot, job.id))?.search?.provider, 'duckduckgo');
  } finally {
    await p?.close();
    await f.close();
  }
});
