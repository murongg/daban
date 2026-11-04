import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Documents } from './documents.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('MOCK EXPECTED OBJECT');
  return value as Record<string, unknown>;
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-memory-api-'));
  await secureDirectory(root);
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  for (const bot of ['mock-alpha', 'mock-beta'])
    await app.models!.profiles.register({
      id: bot,
      name: bot,
      instructions: '',
      memory: 'SYNTHETIC PRIVATE PREFERENCE',
      color: 'mint',
    });
  for (const projectId of ['mock-project-a', 'mock-project-b'])
    await app.models!.projects.write({
      requestId: `create-${projectId}`,
      projectId,
      expectedRevision: 0,
      action: 'create',
      value: { name: projectId, grants: [{ bot: 'mock-alpha' }, { bot: 'mock-beta' }] },
    });
  return {
    get app() {
      return app;
    },
    async call(action: string, input: unknown, token = app.token) {
      const response = await fetch(`${app.url}/api/project-memory/${action}`, {
        method: 'POST',
        headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const value: unknown = await response.json();
      return { status: response.status, value };
    },
    async reopen() {
      await app.close();
      app = await startPrototype(options);
    },
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const scope = { projectId: 'mock-project-a', revision: 1 };
const source = { kind: 'text', title: 'Synthetic guide', content: 'SYNTHETIC SHARED TEXT' };

test('explicit human publication previews members, isolates projects and recovers one persisted receipt', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  expect((await f.call('status', {})).value).toMatchObject({
    available: true,
    capability: 'project-memory-v1',
  });
  expect((await f.call('preview', { scope, source }, 'mock-denied')).status).toBe(403);
  const preview = await f.call('preview', { scope, source });
  expect(preview.status).toBe(200);
  expect(preview.value).toMatchObject({
    scope,
    title: source.title,
    content: source.content,
    members: [{ bot: 'mock-alpha' }, { bot: 'mock-beta' }],
  });
  expect((await f.call('list', { scope })).value).toStrictEqual([]);
  const request = {
    requestId: 'mock-publish',
    scope,
    action: 'publish',
    source,
    digest: record(preview.value).digest,
  };
  const saved = await f.call('write', { request });
  expect(saved.status).toBe(200);
  const document = record(record(saved.value).document);
  expect(document).toMatchObject({
    projectId: scope.projectId,
    kind: 'reference',
    revision: 1,
    content: source.content,
  });
  expect(
    (await f.call('read', { scope, document: { id: document.id, revision: 1 } })).value,
  ).toStrictEqual(document);
  expect(
    (
      await f.call('read', {
        scope: { projectId: 'mock-project-b', revision: 1 },
        document: { id: document.id, revision: 1 },
      })
    ).status,
  ).toBe(404);
  expect((await f.call('write', { request, actor: { kind: 'human' } })).status).toBe(400);
  expect(
    (
      await f.call('write', {
        request: { ...request, source: { ...source, content: 'SYNTHETIC CHANGED' } },
      })
    ).status,
  ).toBe(409);
  await f.reopen();
  expect((await f.call('receipt', { scope, requestId: request.requestId })).value).toStrictEqual(
    saved.value,
  );
  expect((await f.call('write', { request })).value).toStrictEqual(saved.value);
  expect(await f.app.models!.knowledge.list('mock-alpha')).toStrictEqual([]);
  expect(f.app.models!.jobs.size).toBe(0);
});

test('a selected private historical version is copied only after exact head revalidation and withdrawal preserves history', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const first = await f.app.models!.knowledge.write('mock-alpha', {
    path: 'mock-private.md',
    revision: 0,
    content: 'SYNTHETIC SELECTED OLD VERSION',
  });
  const latest = await f.app.models!.knowledge.write('mock-alpha', {
    id: first.id,
    path: first.path,
    revision: 1,
    content: 'SYNTHETIC PRIVATE NEW VERSION',
  });
  const selected = {
    kind: 'bot-document',
    bot: 'mock-alpha',
    document: { id: first.id, revision: 1 },
    expectedRevision: latest.revision,
  };
  const preview = await f.call('preview', { scope, source: selected });
  expect(preview.status).toBe(200);
  const request = {
    requestId: 'mock-old-version',
    scope,
    action: 'publish',
    source: selected,
    digest: record(preview.value).digest,
  };
  const result = await f.call('write', { request });
  expect(result.status).toBe(200);
  const document = record(record(result.value).document);
  expect(document.content).toBe(first.content);
  expect(JSON.stringify(document)).not.toContain(first.id);
  expect(JSON.stringify(document)).not.toContain(latest.content);
  const withdrawn = await f.call('write', {
    request: {
      requestId: 'mock-withdraw',
      scope,
      action: 'withdraw',
      document: { id: document.id, revision: 1 },
    },
  });
  expect(withdrawn.status).toBe(200);
  expect(record(withdrawn.value).document).toMatchObject({ deleted: true, revision: 2 });
  expect((await f.call('list', { scope })).value).toStrictEqual([]);
  expect((await f.call('versions', { scope, id: document.id })).value).toMatchObject([
    { revision: 2, deleted: true },
    { revision: 1, deleted: false },
  ]);
  expect((await f.app.models!.knowledge.read('mock-alpha', first.id)).content).toBe(latest.content);
  await f.app.models!.knowledge.write('mock-alpha', {
    id: first.id,
    path: first.path,
    revision: latest.revision,
    content: 'SYNTHETIC LATE EDIT',
  });
  expect(
    (await f.call('write', { request: { ...request, requestId: 'mock-new-publication' } })).status,
  ).toBe(409);
  const restored = await f.call('write', {
    request: {
      requestId: 'mock-restore',
      scope,
      action: 'restore',
      document: { id: document.id, revision: 2 },
      targetRevision: 1,
    },
  });
  expect(restored.status).toBe(200);
  expect(record(restored.value).document).toMatchObject({
    content: first.content,
    revision: 3,
    deleted: false,
  });
});

test('candidate inspection and decisions require authenticated human routes and preserve receipt identity', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const preview = await f.call('preview', { scope, source });
  const published = await f.call('write', {
    request: {
      requestId: 'mock-publish-review',
      scope,
      action: 'publish',
      source,
      digest: record(preview.value).digest,
    },
  });
  const document = record(record(published.value).document);
  const candidate = await f.app.models!.knowledge.project.propose(
    'mock-alpha',
    {
      requestId: 'mock-propose-review',
      scope,
      sources: [{ id: document.id, revision: 1 }],
      reason: 'Synthetic evidence',
      content: 'SYNTHETIC CANDIDATE',
    },
    () => true,
  );
  expect((await f.call('candidate', { scope, id: candidate.id })).value).toStrictEqual(candidate);
  expect(
    (
      await f.call('candidate', {
        scope: { projectId: 'mock-project-b', revision: 1 },
        id: candidate.id,
      })
    ).status,
  ).toBe(404);
  const request = {
    requestId: 'mock-human-accept',
    scope,
    candidateId: candidate.id,
    candidateRevision: 1,
    action: 'accept',
    content: 'SYNTHETIC HUMAN EDIT',
  };
  expect((await f.call('decide', { request }, 'mock-denied')).status).toBe(403);
  expect((await f.call('decide', { request, actor: { kind: 'human' } })).status).toBe(400);
  expect((await f.call('decide', { request: { ...request, proposer: 'mock-beta' } })).status).toBe(
    400,
  );
  const decided = await f.call('decide', { request });
  expect(decided.status).toBe(200);
  expect(decided.value).toMatchObject({
    state: 'complete',
    candidate: { state: 'accepted' },
    document: { kind: 'confirmed-memory', content: request.content, revision: 1 },
  });
  await f.reopen();
  expect((await f.call('receipt', { scope, requestId: request.requestId })).value).toStrictEqual(
    decided.value,
  );
  expect((await f.call('decide', { request })).value).toStrictEqual(decided.value);
  expect(
    (await f.call('decide', { request: { ...request, content: 'SYNTHETIC DIFFERENT' } })).status,
  ).toBe(409);
});

test('an accepted upload retry resolves its receipt before attempting extraction again', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const extract = vi
    .spyOn(Documents.prototype, 'extract')
    .mockResolvedValue('SYNTHETIC EXTRACTED TEXT');
  const uploaded = {
    kind: 'upload',
    file: {
      name: 'mock-guide.pdf',
      data: Buffer.from('%PDF-1.7\nSYNTHETIC UPLOAD').toString('base64'),
    },
  };
  const preview = await f.call('preview', { scope, source: uploaded });
  expect(preview.status).toBe(200);
  const request = {
    requestId: 'mock-upload',
    scope,
    action: 'publish',
    source: uploaded,
    digest: record(preview.value).digest,
  };
  const accepted = await f.call('write', { request });
  expect(accepted.status).toBe(200);
  const count = extract.mock.calls.length;
  extract.mockRejectedValue(new Error('SYNTHETIC PARSER UNAVAILABLE'));
  expect((await f.call('write', { request })).value).toStrictEqual(accepted.value);
  expect(extract.mock.calls.length).toBe(count);
});

test('scope changes during upload extraction prevent sharing and extraction failures create no empty document', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const uploaded = {
    kind: 'upload',
    file: {
      name: 'mock-guide.pdf',
      data: Buffer.from('%PDF-1.7\nSYNTHETIC UPLOAD').toString('base64'),
    },
  };
  const extract = vi.spyOn(Documents.prototype, 'extract').mockImplementation(async () => {
    await f.app.models!.projects.write({
      requestId: 'mock-revoke-during-extraction',
      projectId: scope.projectId,
      expectedRevision: 1,
      action: 'update',
      value: { name: 'Synthetic revised scope', grants: [{ bot: 'mock-alpha' }] },
    });
    return 'SYNTHETIC EXTRACTED TEXT';
  });
  expect((await f.call('preview', { scope, source: uploaded })).status).toBe(409);
  const revised = { ...scope, revision: 2 };
  expect((await f.call('list', { scope: revised })).value).toStrictEqual([]);
  extract.mockRejectedValue(new Error('SYNTHETIC PARSER FAILED'));
  expect(
    (
      await f.call('write', {
        request: {
          requestId: 'mock-failed-upload',
          scope: revised,
          action: 'publish',
          source: uploaded,
          digest: 'a'.repeat(64),
        },
      })
    ).status,
  ).toBe(500);
  expect((await f.call('list', { scope: revised })).value).toStrictEqual([]);
});
