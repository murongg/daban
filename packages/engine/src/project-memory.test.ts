import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isMemoryProposal,
  type MemoryProposal,
  type ProjectDocument,
  type ProjectScope,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { Knowledge } from './knowledge.js';
import { Projects } from './projects.js';

const scope = { projectId: 'mock-project-a', revision: 1 };
const live = () => true;
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-memory-'));
  let projects = new Projects(path.join(root, 'projects.sqlite'));
  await projects.ready;
  let knowledge = new Knowledge(path.join(root, 'knowledge.sqlite'), projects);
  for (const projectId of [scope.projectId, 'mock-project-b'])
    await projects.write({
      requestId: `create-${projectId}`,
      projectId,
      expectedRevision: 0,
      action: 'create',
      value: { name: projectId, grants: [{ bot: 'mock-alpha' }, { bot: 'mock-beta' }] },
    });
  const publish = async (
    id: string,
    content = 'SYNTHETIC SHARED FACT',
    project: ProjectScope = scope,
  ) => {
    const source = { kind: 'text' as const, title: 'Synthetic reference', content };
    const preview = await knowledge.project.preview(project, source);
    const receipt = await knowledge.project.write({
      requestId: id,
      scope: project,
      action: 'publish',
      source,
      digest: preview.digest,
    });
    if (receipt.state !== 'complete' || !receipt.document) throw Error('MOCK EXPECTED DOCUMENT');
    return receipt.document;
  };
  return {
    get knowledge() {
      return knowledge;
    },
    get projects() {
      return projects;
    },
    publish,
    async reopen() {
      await knowledge.close();
      await projects.close();
      projects = new Projects(path.join(root, 'projects.sqlite'));
      await projects.ready;
      knowledge = new Knowledge(path.join(root, 'knowledge.sqlite'), projects);
      await knowledge.ready;
    },
    async close() {
      await knowledge.close();
      await projects.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const proposal = (document: ProjectDocument, requestId = 'mock-proposal'): MemoryProposal => ({
  requestId,
  scope,
  content: 'SYNTHETIC MEMORY',
  reason: 'Synthetic source evidence',
  sources: [{ id: document.id, revision: document.revision }],
});

test('proposal contracts bound Unicode content, sources, scope and untrusted actor fields', () => {
  const input = proposal({ id: 'mock-document', revision: 1 } as ProjectDocument);
  expect(isMemoryProposal(input)).toBe(true);
  expect(isMemoryProposal({ ...input, content: '🧪'.repeat(2000) })).toBe(true);
  for (const invalid of [
    { ...input, actor: 'human' },
    { ...input, content: ' ' },
    { ...input, content: '🧪'.repeat(2001) },
    { ...input, sources: [] },
    { ...input, sources: Array.from({ length: 11 }, (_, i) => ({ id: `mock-${i}`, revision: 1 })) },
    { ...input, sources: [...input.sources, ...input.sources] },
    { ...input, reason: '' },
    { ...input, scope: { ...scope, revision: 0 } },
    { ...input, sources: [{ id: 'mock-document', revision: -1 }] },
  ])
    expect(isMemoryProposal(invalid)).toBe(false);
});

test('candidate deduplication and receipts are isolated by trusted proposer, including after restart', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const document = await f.publish('mock-publish');
  const input = proposal(document);
  const first = await f.knowledge.project.propose('mock-alpha', input, live);
  expect(
    (await f.knowledge.project.propose('mock-alpha', { ...input, requestId: 'mock-retry' }, live))
      .id,
  ).toBe(first.id);
  const other = await f.knowledge.project.propose('mock-beta', input, live);
  expect(other.id).not.toBe(first.id);
  await expect(f.knowledge.project.candidate(scope, first.id, 'mock-beta')).rejects.toThrow(
    'PROJECT_CANDIDATE_NOT_FOUND',
  );
  expect(await f.knowledge.project.proposalReceipt(scope, 'mock-retry', 'mock-beta')).toStrictEqual(
    { state: 'unknown', requestId: 'mock-retry' },
  );
  await expect(
    f.knowledge.project.propose('mock-alpha', { ...input, content: 'SYNTHETIC DIFFERENT' }, live),
  ).rejects.toThrow('PROJECT_MEMORY_REQUEST_REUSED');
  await expect(
    f.knowledge.project.propose(
      'mock-alpha',
      {
        ...input,
        requestId: 'mock-cross-project',
        scope: { projectId: 'mock-project-b', revision: 1 },
      },
      live,
    ),
  ).rejects.toThrow('PROJECT_MEMORY_SOURCE_CHANGED');
  await f.reopen();
  expect((await f.knowledge.project.propose('mock-alpha', input, live)).id).toBe(first.id);
  expect(
    (await f.knowledge.project.candidates(scope, 'pending', 'mock-beta')).map((item) => item.id),
  ).toStrictEqual([other.id]);
});

test('rejected candidates suppress repeat pending work while stale sources and scope require a new request', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const document = await f.publish('mock-publish');
  const input = proposal(document);
  const rejected = await f.knowledge.project.propose('mock-alpha', input, live);
  await f.knowledge.project.decide({
    requestId: 'mock-reject',
    scope,
    candidateId: rejected.id,
    candidateRevision: 1,
    action: 'reject',
    content: input.content,
  });
  expect(
    await f.knowledge.project.propose(
      'mock-alpha',
      { ...input, requestId: 'mock-rejected-retry' },
      live,
    ),
  ).toMatchObject({ id: rejected.id, state: 'rejected' });
  const pending = await f.knowledge.project.propose('mock-beta', input, live);
  const edit = await f.knowledge.project.write({
    requestId: 'mock-edit',
    scope,
    action: 'update',
    document: { id: document.id, revision: 1 },
    title: document.title,
    content: 'SYNTHETIC REVISED SOURCE',
  });
  if (edit.state !== 'complete' || !edit.document) throw Error('MOCK EXPECTED EDIT');
  expect(await f.knowledge.project.candidates(scope, 'stale')).toMatchObject([
    { id: pending.id, state: 'stale' },
  ]);
  await expect(
    f.knowledge.project.decide({
      requestId: 'mock-stale-accept',
      scope,
      candidateId: pending.id,
      candidateRevision: 1,
      action: 'accept',
      content: input.content,
    }),
  ).rejects.toThrow('PROJECT_MEMORY_CONFLICT');
  const next = {
    ...input,
    requestId: 'mock-new-source',
    sources: [{ id: document.id, revision: 2 }],
  };
  const renewed = await f.knowledge.project.propose('mock-beta', next, live);
  expect(renewed.id).not.toBe(pending.id);
  await expect(
    f.knowledge.project.propose('mock-beta', { ...next, requestId: input.requestId }, live),
  ).rejects.toThrow('PROJECT_MEMORY_REQUEST_REUSED');
  await f.projects.write({
    requestId: 'mock-revoke',
    projectId: scope.projectId,
    expectedRevision: 1,
    action: 'update',
    value: { name: 'Synthetic changed membership', grants: [{ bot: 'mock-beta' }] },
  });
  const changed = { projectId: scope.projectId, revision: 2 };
  expect(await f.knowledge.project.candidates(changed, 'stale', 'mock-beta')).toMatchObject(
    expect.arrayContaining([
      { ...renewed, revision: 2, state: 'stale', updatedAt: expect.any(String) },
    ]),
  );
  const scoped = await f.knowledge.project.propose(
    'mock-beta',
    { ...next, scope: changed, requestId: 'mock-new-scope' },
    live,
  );
  expect(scoped.id).not.toBe(renewed.id);
  await expect(
    f.knowledge.project.read(changed, { id: document.id, revision: 2 }, 'mock-alpha'),
  ).rejects.toThrow('PROJECT_ACCESS_DENIED');
  await expect(
    f.knowledge.project.propose('mock-beta', { ...next, scope, requestId: 'mock-old-scope' }, live),
  ).rejects.toThrow('PROJECT_SCOPE_STALE');
});

test('two human decisions create one memory version and exact retries recover the immutable result', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const document = await f.publish('mock-publish');
  const input = proposal(document);
  const candidate = await f.knowledge.project.propose('mock-alpha', input, live);
  const request = {
    requestId: 'mock-accept',
    scope,
    candidateId: candidate.id,
    candidateRevision: 1,
    action: 'accept',
    content: 'SYNTHETIC HUMAN EDITED FACT',
  };
  const results = await Promise.allSettled([
    f.knowledge.project.decide(request),
    f.knowledge.project.decide({ ...request, requestId: 'mock-other-window' }),
  ]);
  expect(results.map((result) => result.status).sort()).toStrictEqual(['fulfilled', 'rejected']);
  const receipt = await f.knowledge.project.receipt(scope, request.requestId);
  expect(receipt).toMatchObject({
    state: 'complete',
    candidate: { state: 'accepted', revision: 2 },
    document: { kind: 'confirmed-memory', revision: 1, content: request.content },
  });
  expect(
    (await f.knowledge.project.list(scope)).filter((item) => item.kind === 'confirmed-memory'),
  ).toHaveLength(1);
  await f.reopen();
  expect(await f.knowledge.project.decide(request)).toStrictEqual(receipt);
  if (receipt.state !== 'complete' || !receipt.document) throw Error('MOCK EXPECTED ACCEPTANCE');
  expect((await f.knowledge.project.versions(scope, receipt.document.id))[0].origin).toMatchObject({
    kind: 'candidate',
    candidate: { id: candidate.id, revision: 2 },
    sources: input.sources,
  });
  expect(
    await f.knowledge.project.read(scope, { id: receipt.document.id, revision: 1 }, 'mock-beta'),
  ).not.toHaveProperty('origin');
  await f.knowledge.project.write({
    requestId: 'mock-manual-memory-edit',
    scope,
    action: 'update',
    document: { id: receipt.document.id, revision: 1 },
    title: receipt.document.title,
    content: 'SYNTHETIC DIRECT HUMAN EDIT',
  });
  expect((await f.knowledge.project.versions(scope, receipt.document.id))[0].origin).toStrictEqual({
    kind: 'text',
  });
  await f.knowledge.project.write({
    requestId: 'mock-restore-memory',
    scope,
    action: 'restore',
    document: { id: receipt.document.id, revision: 2 },
    targetRevision: 1,
  });
  expect((await f.knowledge.project.versions(scope, receipt.document.id))[0].origin).toMatchObject({
    kind: 'candidate',
    candidate: { id: candidate.id, revision: 2 },
  });
  await expect(
    f.knowledge.project.decide({ ...request, content: 'SYNTHETIC DIFFERENT' }),
  ).rejects.toThrow('PROJECT_MEMORY_REQUEST_REUSED');
});

test('document and pending-candidate quotas roll back complete operations and keep the catalog byte-bounded', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
  const document = await f.publish('mock-first');
  const first = await f.knowledge.project.propose('mock-alpha', proposal(document), live);
  for (let i = 1; i < 200; i++)
    await f.knowledge.project.propose(
      'mock-alpha',
      { ...proposal(document, `mock-proposal-${i}`), content: `SYNTHETIC DISTINCT FACT ${i}` },
      live,
    );
  await expect(
    f.knowledge.project.propose('mock-beta', proposal(document, 'mock-overflow'), live),
  ).rejects.toThrow('PROJECT_MEMORY_LIMIT');
  expect(
    await f.knowledge.project.proposalReceipt(scope, 'mock-overflow', 'mock-beta'),
  ).toStrictEqual({ state: 'unknown', requestId: 'mock-overflow' });
  for (let i = 1; i < 100; i++) {
    const source = {
      kind: 'text' as const,
      title: `${i} ${'合成'.repeat(100)}`,
      content: 'SYNTHETIC DOCUMENT',
    };
    const preview = await f.knowledge.project.preview(scope, source);
    await f.knowledge.project.write({
      requestId: `mock-doc-${i}`,
      scope,
      action: 'publish',
      source,
      digest: preview.digest,
    });
  }
  await expect(f.publish('mock-doc-overflow')).rejects.toThrow('PROJECT_MEMORY_LIMIT');
  await expect(
    f.knowledge.project.decide({
      requestId: 'mock-accept-overflow',
      scope,
      candidateId: first.id,
      candidateRevision: 1,
      action: 'accept',
      content: first.content,
    }),
  ).rejects.toThrow('PROJECT_MEMORY_LIMIT');
  expect((await f.knowledge.project.candidate(scope, first.id, 'mock-alpha')).state).toBe(
    'pending',
  );
  expect((await f.knowledge.project.list(scope)).length).toBe(100);
  expect(await f.knowledge.project.receipt(scope, 'mock-accept-overflow')).toMatchObject({
    state: 'unknown',
  });
  const context = await f.knowledge.project.context(scope, 'mock-alpha');
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(12 * 1024);
  expect(context).toContain('"truncated":true');
  expect(context).not.toContain('SYNTHETIC DISTINCT FACT');
});
