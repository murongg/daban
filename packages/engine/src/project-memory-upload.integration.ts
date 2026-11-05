import assert from 'node:assert/strict';
import { type ChildProcess, execFile, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  isExecutionRequest,
  isMemoryCandidate,
  isProjectMemoryReceipt,
  isProjectPublicationPreview,
  type ProjectScope,
} from '@daban/protocol';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { syntheticOffice, syntheticPdf } from './documents.fixture.js';
import { RemoteExecutor } from './execution.js';
import { startAgent } from './host-server.js';

const record = (value: unknown): Record<string, unknown> => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

test('synthetic project uploads cross the real Linux runtime sandbox before preview, publication and scoped model reads', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async (t) => {
  // Missing binaries or namespace policy must fail Ubuntu acceptance rather than silently skip it.
  await promisify(execFile)(
    'bwrap',
    [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-all',
      '--disable-userns',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--clearenv',
      '--',
      '/usr/bin/true',
    ],
    { timeout: 5000, maxBuffer: 4096 },
  );
  const root = await mkdtemp(path.join(tmpdir(), 'mock-project-upload-'));
  const deployment = path.resolve('outputs/project-memory-upload/runtime');
  const guestDirectory = path.join(root, 'guest');
  let guest: ChildProcess | undefined;
  let guestExit: Promise<number | null> | undefined;
  let host: Awaited<ReturnType<typeof startAgent>> | undefined;
  let guestErrors = '';
  let closing: Promise<unknown> | undefined;
  const methods: string[] = [];
  const providerErrors: string[] = [];
  const marker = `SYNTHETIC-UPLOAD-${randomUUID()}`;
  const scope: ProjectScope = { projectId: 'mock-upload-project', revision: 1 };
  let reference = { id: '', revision: 1 };
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const offered = Array.isArray(body.tools) ? body.tools : [];
      const names = offered.map((tool) => record(record(tool).function).name);
      const name = names.find(
        (value) =>
          typeof value === 'string' &&
          value.endsWith(providerCalls === 0 ? 'project_memory_read' : 'project_memory_propose'),
      );
      if (providerCalls < 2) assert.equal(typeof name, 'string');
      providerCalls++;
      if (providerCalls >= 2) assert(JSON.stringify(body).includes(marker));
      const argumentsValue =
        providerCalls === 1
          ? reference
          : {
              requestId: 'mock-upload-proposal',
              content: 'SYNTHETIC PARSED PROJECT FACT',
              reason: 'Synthetic document read through the project tool',
              sources: [reference],
            };
      const delta =
        providerCalls <= 2
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `mock-tool-${providerCalls}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(argumentsValue) },
                },
              ],
            }
          : { role: 'assistant', content: 'SYNTHETIC COMPLETE' };
      const frame = {
        id: `mock-frame-${providerCalls}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock-model',
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `${[
          { ...frame, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...frame,
            choices: [
              { index: 0, delta: {}, finish_reason: providerCalls <= 2 ? 'tool_calls' : 'stop' },
            ],
          },
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join('')}data: [DONE]\n\n`,
      );
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const close = () => {
    closing ??= (async () => {
      try {
        await host?.close();
      } finally {
        try {
          if (guest && guest.exitCode === null && guest.signalCode === null) {
            guest.send('close', (error) => {
              if (error) guest?.kill('SIGTERM');
            });
            const timer = setTimeout(() => guest?.kill('SIGKILL'), 5000);
            try {
              await guestExit;
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          provider.closeAllConnections();
          if (provider.listening)
            await new Promise<unknown>((resolve) => provider.close(() => resolve(undefined)));
          await rm(root, { recursive: true, force: true });
        }
      }
    })();
    return closing;
  };
  t.after(close);
  try {
    // The guest receives neither Host/provider credentials nor inherited test-runner flags.
    guest = fork(
      fileURLToPath(new URL('./project-memory-upload.fixture.js', import.meta.url)),
      [deployment, guestDirectory],
      { silent: true, execArgv: [], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } },
    );
    const child = guest;
    guestExit = new Promise((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    child.stderr?.on('data', (value: Buffer) => {
      guestErrors = (guestErrors + value.toString('utf8')).slice(-2048);
    });
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('PROJECT_UPLOAD_RUNTIME_START_TIMEOUT')), 10000);
      child.once('message', (value: unknown) => {
        clearTimeout(timer);
        try {
          const data = record(value);
          assert.equal(typeof data.origin, 'string');
          resolve(String(data.origin));
        } catch (error) {
          reject(error);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error(`PROJECT_UPLOAD_RUNTIME_EXIT:${guestErrors}`));
      });
    });
    const execution = new RemoteExecutor({
      url: `${origin}/exec`,
      token: (await readFile(path.join(guestDirectory, 'token'), 'utf8')).trim(),
      fetcher: async (url, options) => {
        const value: unknown = JSON.parse(String(options?.body));
        assert(isExecutionRequest(value));
        methods.push(value.method);
        return fetch(url, options);
      },
    });
    // Host owns the SDK; use its declared installation without importing application internals.
    const requireHost = createRequire(path.resolve('apps/agent/package.json'));
    host = await startAgent({
      dataRoot: path.join(root, 'host'),
      socketPath: path.join(root, 'host.sock'),
      scope: createHash('sha256').update(root).digest('hex'),
      execution,
      sdkFile: requireHost.resolve('@deepseek-ai/dsh-sdk-client'),
    });
    await host.refreshExecution();
    const service = host;
    const call = (route: string, input: unknown) =>
      new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const connection = request(
          {
            socketPath: service.socketPath,
            path: `/api/${route}`,
            method: 'POST',
            headers: {
              host: '127.0.0.1:8766',
              'x-prototype-token': service.token,
              'content-type': 'application/json',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (value: Buffer) => chunks.push(value));
            res.once('end', () => {
              try {
                resolve({
                  status: res.statusCode ?? 0,
                  value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        connection.setTimeout(20000, () =>
          connection.destroy(Error('PROJECT_UPLOAD_HTTP_TIMEOUT')),
        );
        connection.once('error', reject);
        connection.end(JSON.stringify(input));
      });
    await service.models.profiles.register({
      id: 'mock-uploader',
      name: 'Synthetic uploader',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    assert.equal(
      (
        await call('projects/write', {
          request: {
            requestId: 'mock-create',
            projectId: scope.projectId,
            expectedRevision: 0,
            action: 'create',
            value: { name: 'Synthetic uploads', grants: [{ bot: 'mock-uploader' }] },
          },
        })
      ).status,
      200,
    );
    const files = unzipSync(syntheticOffice('docx'));
    files['word/document.xml'] = strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${marker} 合成中文</w:t></w:r></w:p></w:body></w:document>`,
    );
    const uploads = [
      { name: 'synthetic.pdf', data: syntheticPdf(marker).toString('base64') },
      { name: 'synthetic.docx', data: Buffer.from(zipSync(files)).toString('base64') },
    ];
    for (const file of uploads) {
      const source = { kind: 'upload' as const, file };
      const preview = await call('project-memory/preview', { scope, source });
      assert.equal(preview.status, 200, JSON.stringify(preview.value));
      assert(isProjectPublicationPreview(preview.value));
      assert(preview.value.content.includes(marker));
      if (file.name.endsWith('.docx')) assert(preview.value.content.includes('合成中文'));
      const request = {
        requestId: `mock-publish-${file.name.replace('.', '-')}`,
        scope,
        action: 'publish' as const,
        source,
        digest: preview.value.digest,
      };
      const published = await call('project-memory/write', { request });
      assert.equal(published.status, 200, JSON.stringify(published.value));
      assert(
        isProjectMemoryReceipt(published.value) &&
          published.value.state === 'complete' &&
          published.value.document,
      );
      assert.equal(published.value.document.content, preview.value.content);
      const document = published.value.document;
      assert.equal(
        (
          await service.models.knowledge.project.read(
            scope,
            { id: document.id, revision: 1 },
            'mock-uploader',
          )
        ).content,
        preview.value.content,
      );
      const parses = methods.filter((method) => method === 'documents.extract').length;
      assert.deepEqual((await call('project-memory/write', { request })).value, published.value);
      assert.equal(methods.filter((method) => method === 'documents.extract').length, parses);
      assert.deepEqual(
        (
          await call('project-memory/receipt', {
            scope,
            requestId: request.requestId,
            signature: published.value.signature,
          })
        ).value,
        published.value,
      );
      reference = { id: document.id, revision: 1 };
    }
    assert.equal(methods.filter((method) => method === 'documents.extract').length, 4);
    const corrupt = await call('project-memory/preview', {
      scope,
      source: {
        kind: 'upload',
        file: { name: 'corrupt.pdf', data: Buffer.from('SYNTHETIC CORRUPT').toString('base64') },
      },
    });
    // The executor protocol preserves the error code; RemoteExecutor reports rejected operations as409.
    assert.equal(corrupt.status, 409);
    assert.equal(record(corrupt.value).error, 'DOCUMENT_UNREADABLE');
    assert.equal((await service.models.knowledge.project.list(scope)).length, 2);
    assert.deepEqual(await service.models.knowledge.list('mock-uploader'), []);
    await new Promise<unknown>((resolve) =>
      provider.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = provider.address();
    assert(address && typeof address !== 'string');
    await service.models.settings.configure({
      model: 'provider:mock-upload:mock-model',
      revision: 0,
      requestId: 'mock-model-config',
      apiKey: 'synthetic-key',
      connection: {
        id: 'mock-upload',
        name: 'Synthetic provider',
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        models: [
          { id: 'mock-model', name: 'Mock', vision: false, contextWindow: 100000, maxTokens: 8192 },
        ],
      },
    });
    await service.models.start('mock-uploader', {
      requestId: 'mock-upload-task',
      prompt:
        'SYNTHETIC: read the uploaded project document, propose a sourced memory, then finish.',
      project: scope,
    });
    const job = service.models.jobs.get('mock-uploader')!;
    await job.done;
    assert.equal(job.phase, 'completed', JSON.stringify({ error: job.error, providerErrors }));
    assert.equal(providerCalls, 3);
    const candidates = await service.models.knowledge.project.candidates(scope);
    assert.equal(candidates.length, 1);
    assert(isMemoryCandidate(candidates[0]));
    assert.deepEqual(candidates[0].sources, [reference]);
    const decision = {
      requestId: 'mock-upload-accept',
      scope,
      candidateId: candidates[0].id,
      candidateRevision: candidates[0].revision,
      action: 'accept',
      content: 'SYNTHETIC HUMAN CONFIRMED UPLOAD',
    };
    const accepted = await call('project-memory/decide', { request: decision });
    assert.equal(accepted.status, 200);
    assert(isProjectMemoryReceipt(accepted.value));
    assert.equal(accepted.value.state, 'complete');
    assert.deepEqual(
      (await call('project-memory/receipt', { scope, requestId: decision.requestId })).value,
      accepted.value,
    );
    assert.equal(
      (await service.models.knowledge.project.list(scope)).filter(
        (document) => document.kind === 'confirmed-memory',
      ).length,
      1,
    );
    t.diagnostic(
      JSON.stringify({
        synthetic: true,
        guestProcess: true,
        actualBwrap: true,
        uploads: ['pdf', 'docx'],
        sandboxParses: methods.filter((method) => method === 'documents.extract').length,
        modelRequests: providerCalls,
        sourceRevision: reference.revision,
        confirmedMemories: 1,
      }),
    );
  } catch (error) {
    if (guestErrors) t.diagnostic(guestErrors);
    throw error;
  } finally {
    await close();
  }
});
