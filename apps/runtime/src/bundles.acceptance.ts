import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import {
  type BotProfile,
  botBundleText,
  isBotBundle,
  isBotProfile,
  isDocumentUpload,
  type KnowledgeDocument,
  type SkillDocument,
} from '@daban/protocol';

assert.equal(process.platform, 'linux');
assert.equal(userInfo().username, 'bot-prototype');
assert.equal(
  JSON.parse(readFileSync('/var/lib/bot-prototype/verify-portable-owner.json', 'utf8')).purpose,
  'synthetic-portability',
);
assert.equal(existsSync('/var/lib/bot-prototype/model/credentials.json'), false);
const token = readFileSync('/var/lib/bot-prototype/model/control-token', 'utf8').trim();
const api = async (route: string, data?: unknown) => {
  const response = await fetch(`http://127.0.0.1:8766${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'x-prototype-token': token,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  assert.equal(response.ok, true, typeof value.error === 'string' ? value.error : 'API failed');
  return value;
};
const state = await api('/api/state');
assert.equal(state.clientProtocol, 30);
assert.equal(state.model.configured, false);
assert.ok(
  Object.values(state.model.bots).every((value) => !(value as { running: boolean }).running),
);
const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
assert.ok(input && typeof input === 'object' && 'mode' in input);
if (input.mode === 'seed') {
  assert.ok('file' in input && isDocumentUpload(input.file));
  const id = `portable-source-${randomUUID().slice(0, 12)}`;
  const profile = (await api('/api/bots', {
    id,
    name: '合成迁移验收',
    instructions: '只处理用户提供的合成资料，先给结论。',
    memory: 'SYNTHETIC PORTABLE PREF: use concise numbered answers.',
    color: 'violet',
    model: 'deepseek-v4-pro',
  })) as BotProfile;
  assert.ok(isBotProfile(profile));
  const content =
    '---\nname: portable-native-outline\ndescription: Synthetic portability workflow\n---\nUse only synthetic input to write an outline.';
  const skill = (await api('/api/skills/import', { bot: id, content })) as SkillDocument;
  await api('/api/skills/bind', {
    bot: id,
    binding: { id: skill.id, revision: skill.revision, bindingRevision: 0, enabled: true },
  });
  const original = (await api('/api/knowledge/import', {
    bot: id,
    file: input.file,
  })) as KnowledgeDocument;
  const edited = (await api('/api/knowledge/write', {
    bot: id,
    document: {
      id: original.id,
      revision: original.revision,
      path: 'portable/current.md',
      content: 'SYNTHETIC CURRENT KNOWLEDGE AFTER EDIT',
    },
  })) as KnowledgeDocument;
  const selection = {
    bot: id,
    revision: profile.revision,
    memory: true,
    originals: true,
    skills: [{ id: skill.id, revision: skill.revision }],
    knowledge: [{ id: edited.id, revision: edited.revision }],
  };
  const bundle = await api('/api/bundles/export', selection);
  assert.ok(isBotBundle(bundle));
  console.log(
    JSON.stringify({
      mode: 'seed',
      profile,
      selection,
      canonical: botBundleText(bundle),
      originalSha256: createHash('sha256')
        .update(Buffer.from(input.file.data, 'base64'))
        .digest('hex'),
      providerConfigured: false,
    }),
  );
} else if (input.mode === 'verify') {
  assert.ok(
    'source' in input &&
      typeof input.source === 'string' &&
      input.source.startsWith('portable-source-'),
  );
  assert.ok(
    'name' in input &&
      typeof input.name === 'string' &&
      'originalSha256' in input &&
      typeof input.originalSha256 === 'string',
  );
  const profiles = (await api('/api/bots')) as BotProfile[];
  const imported = profiles.filter((profile) => profile.name === input.name);
  assert.equal(imported.length, 1);
  assert.notEqual(imported[0].id, input.source);
  assert.equal(imported[0].model, undefined);
  assert.equal(imported[0].memory, 'SYNTHETIC PORTABLE PREF: use concise numbered answers.');
  const catalog = await api('/api/skills/list', { bot: imported[0].id });
  assert.ok(catalog.catalog.items.every((item: { enabled: boolean }) => !item.enabled));
  const documents = (await api('/api/knowledge/list', {
    bot: imported[0].id,
  })) as KnowledgeDocument[];
  assert.equal(documents.length, 1);
  const document = await api('/api/knowledge/read', { bot: imported[0].id, id: documents[0].id });
  assert.equal(document.content, 'SYNTHETIC CURRENT KNOWLEDGE AFTER EDIT');
  const original = await api('/api/knowledge/source', { bot: imported[0].id, id: document.id });
  assert.equal(original.sha256, input.originalSha256);
  const source = profiles.find((profile) => profile.id === input.source)!;
  assert.equal(source.model, 'deepseek-v4-pro');
  assert.equal(source.revision, 1);
  const settings = await api('/api/model/settings');
  assert.equal(settings.configured, false);
  console.log(
    JSON.stringify({
      verified: true,
      imported: imported[0],
      sourceProfileRetained: true,
      preferencesRetained: true,
      currentTextRetained: true,
      originalBytesShaMatched: true,
      skillsDisabled: true,
      modelInheritsWorkspace: true,
      providerConfigured: false,
      paidModelTaskTurns: 0,
    }),
  );
} else throw new Error('Unknown acceptance mode');
