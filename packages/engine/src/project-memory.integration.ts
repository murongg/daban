import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Knowledge } from './knowledge.js';
import { BotProfiles } from './profiles.js';
import { Projects } from './projects.js';

test('legacy private knowledge and fifty preferences survive publication, human acceptance, restart and revocation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-memory-integration-'));
  const profiles = new BotProfiles(path.join(root, 'bots'));
  let profile = await profiles.register({
    id: 'mock-alpha',
    name: 'Synthetic reader',
    instructions: '',
    memory: 'SYNTHETIC INITIAL PRIVATE PREFERENCE',
    color: 'mint',
  });
  for (const bot of ['mock-beta', 'mock-outsider'])
    await profiles.register({ id: bot, name: bot, instructions: '', memory: '', color: 'mint' });
  for (let i = 0; i < 60; i++)
    profile = await profiles.update(profile.id, profile.revision, {
      memory: `SYNTHETIC PRIVATE PREFERENCE ${i}`,
    });
  const preferences = async () => {
    const versions = [];
    let before: number | undefined;
    do {
      const page = await profiles.history(profile.id, before === undefined ? {} : { before });
      versions.push(...page.items);
      before = page.nextBefore;
    } while (before !== undefined);
    return versions;
  };
  const history = await preferences();
  assert.equal(history.length, 50);
  const file = path.join(root, 'knowledge.sqlite');
  const bytes = Buffer.from('%PDF-1.7\nSYNTHETIC LEGACY ORIGINAL');
  const legacy = new DatabaseSync(file);
  // This fixture deliberately predates the ORM journal and all project tables.
  legacy.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,bot TEXT NOT NULL,path TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(bot,path));
    CREATE TABLE revisions(document TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,run TEXT,PRIMARY KEY(document,revision));
    CREATE TABLE sources(document TEXT PRIMARY KEY,bot TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,UNIQUE(bot,name));`);
  const stamp = '2026-01-01T00:00:00.000Z';
  const old = 'SYNTHETIC SELECTED OLD TEXT',
    current = 'SYNTHETIC LATEST PRIVATE TEXT';
  legacy
    .prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'mock-private',
      profile.id,
      'mock-guide.pdf.txt',
      2,
      current,
      Buffer.byteLength(current),
      0,
      stamp,
      stamp,
    );
  for (const [index, content] of [old, current].entries())
    legacy
      .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        'mock-private',
        index + 1,
        'mock-guide.pdf.txt',
        content,
        Buffer.byteLength(content),
        0,
        stamp,
        'user',
        null,
      );
  legacy
    .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)')
    .run(
      'mock-private',
      profile.id,
      'mock-guide.pdf',
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      bytes,
    );
  legacy.close();
  let projects = new Projects(path.join(root, 'projects.sqlite'), {
    registered: (bot) => profiles.assertActive(bot),
  });
  await projects.ready;
  let knowledge = new Knowledge(file, projects);
  t.after(async () => {
    await knowledge.close();
    await projects.close();
    await rm(root, { recursive: true, force: true });
  });
  const scope = { projectId: 'mock-project-a', revision: 1 };
  for (const projectId of [scope.projectId, 'mock-project-b'])
    await projects.write({
      requestId: `create-${projectId}`,
      projectId,
      action: 'create',
      expectedRevision: 0,
      value: { name: projectId, grants: [{ bot: 'mock-alpha' }, { bot: 'mock-beta' }] },
    });
  const source = {
    kind: 'bot-document' as const,
    bot: profile.id,
    document: { id: 'mock-private', revision: 1 },
    expectedRevision: 2,
  };
  const preview = await knowledge.project.preview(scope, source);
  const published = await knowledge.project.write({
    requestId: 'mock-publish',
    scope,
    action: 'publish',
    source,
    digest: preview.digest,
  });
  assert(published.state === 'complete' && published.document);
  assert.equal(published.document.content, old);
  const reference = { id: published.document.id, revision: 1 };
  assert.equal((await knowledge.project.read(scope, reference, profile.id)).content, old);
  const proposal = await knowledge.project.propose(
    profile.id,
    {
      requestId: 'mock-propose',
      scope,
      sources: [reference],
      content: 'SYNTHETIC CONFIRMED FACT',
      reason: 'Synthetic published evidence',
    },
    () => true,
  );
  const decision = {
    requestId: 'mock-accept',
    scope,
    candidateId: proposal.id,
    candidateRevision: 1,
    action: 'accept',
    content: 'SYNTHETIC HUMAN CONFIRMED FACT',
  };
  await knowledge.project.decide(decision);
  // Ignore the write acknowledgement: recovery must query the committed operation instead of creating a second version.
  const receipt = await knowledge.project.receipt(scope, decision.requestId);
  assert(receipt.state === 'complete' && receipt.document);
  const confirmed = { id: receipt.document.id, revision: receipt.document.revision };
  await knowledge.close();
  await projects.close();
  projects = new Projects(path.join(root, 'projects.sqlite'), {
    registered: (bot) => profiles.assertActive(bot),
  });
  await projects.ready;
  knowledge = new Knowledge(file, projects);
  await knowledge.ready;
  assert.deepEqual(await knowledge.project.decide(decision), receipt);
  assert.equal(
    (await knowledge.project.list(scope)).filter((item) => item.kind === 'confirmed-memory').length,
    1,
  );
  await projects.write({
    requestId: 'mock-revoke',
    projectId: scope.projectId,
    expectedRevision: 1,
    action: 'update',
    value: { name: 'Synthetic revised grants', grants: [{ bot: 'mock-beta' }] },
  });
  const revised = { ...scope, revision: 2 };
  await assert.rejects(
    knowledge.project.read(revised, reference, profile.id),
    /PROJECT_ACCESS_DENIED/,
  );
  await assert.rejects(
    knowledge.project.read(scope, reference, 'mock-beta'),
    /PROJECT_SCOPE_STALE/,
  );
  await assert.rejects(
    knowledge.project.read(revised, reference, 'mock-outsider'),
    /PROJECT_ACCESS_DENIED/,
  );
  assert.equal(
    (await knowledge.project.read(revised, confirmed, 'mock-beta')).content,
    decision.content,
  );
  assert.equal((await knowledge.read(profile.id, 'mock-private')).content, current);
  assert.equal((await knowledge.versions(profile.id, 'mock-private')).length, 2);
  assert.equal(
    (await knowledge.source(profile.id, 'mock-private')).file.data,
    bytes.toString('base64'),
  );
  assert.deepEqual(
    (await knowledge.list(profile.id)).map((item) => item.id),
    ['mock-private'],
  );
  await assert.rejects(knowledge.read(profile.id, reference.id), /KNOWLEDGE_NOT_FOUND/);
  assert.deepEqual(await preferences(), history);
  assert.equal((await profiles.get(profile.id))?.memory, profile.memory);
});
