import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentToolRun } from './agent-tools.js';
import type { Desktop } from './desktop.js';
import { syntheticOffice, syntheticPdf } from './documents.fixture.js';
import { BotProfiles } from './profiles.js';
import type { Prototype } from './server.js';
import { startPrototype } from './server.js';

const wait = async (action: () => unknown | Promise<unknown>) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      if (await action()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Native application operation did not complete');
};

test('complete Linux desktops: native files/apps, shared browser viewer and both handoffs', {
  skip: process.platform !== 'linux',
  timeout: 120000,
}, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desktop-synthetic-'));
  let app!: Prototype<Desktop>;
  const checks: Record<string, unknown>[] = [];
  try {
    const nativeFetch = fetch;
    let modelChecks = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input) === 'https://api.deepseek.com/v1/models') {
          modelChecks++;
          assert.equal(
            new Headers(init?.headers).get('authorization'),
            'Bearer synthetic-http-model-key',
          );
          assert.equal(init?.body, undefined);
          return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
        }
        return nativeFetch(input, init);
      },
    );
    app = await startPrototype({
      fixture: true,
      profileDir: path.join(dir, 'profile'),
      port: 0,
      desktop: { dir: path.join(dir, 'desktops'), displayBase: 31 },
      interval: 700,
    });
    const runtime = app.runtime;
    assert.equal(
      (await runtime.snapshot()).mode,
      'desktop',
      'the runtime must expose entire X11 desktops',
    );
    const record = (name: string, detail: Record<string, unknown> = {}) =>
      checks.push({ name, passed: true, ...detail });

    await t.test(
      'real groups authenticate input ownership, exact replays, membership CAS and round cancellation',
      async (st) => {
        assert.ok(app.groups);
        assert.ok(app.models);
        st.mock.method(app.models, 'start', async () => {
          throw Object.assign(new Error('MODEL_ALREADY_RUNNING'), {
            code: 'MODEL_ALREADY_RUNNING',
          });
        });
        const request = (route: string, data: unknown, token = app.token) =>
          fetch(`${app.url}/api/groups/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-prototype-token': token },
            body: JSON.stringify(data),
          });
        for (const id of ['mock-group-a', 'mock-group-b'])
          await app.models.profiles.register({
            id,
            name: id,
            instructions: '合成测试',
            memory: '',
            color: 'mint',
          });
        const group = {
          id: 'mock-http-group',
          name: '合成 API 群',
          members: ['mock-group-a', 'mock-group-b'],
        };
        assert.equal((await request('register', group, 'wrong-token')).status, 403);
        assert.equal((await request('register', { ...group, author: 'forged' })).status, 400);
        const registered = await (await request('register', group)).json();
        assert.equal(registered.revision, 1);
        const input = {
          id: 'mock-http-send',
          group: group.id,
          prompt: '合成群任务',
          recipients: group.members,
          files: [{ name: 'mock.csv', content: 'item,count\nmock,47' }],
        };
        assert.equal((await request('send', { ...input, author: 'forged' })).status, 400);
        const sent = await (await request('send', input)).json();
        assert.equal(sent.accepted.id, input.id);
        assert.equal(
          (
            await request('update', {
              group: group.id,
              revision: 1,
              input: { name: '合成新名', members: group.members },
            })
          ).status,
          409,
        );
        const source = await (
          await request('input', { group: group.id, sourceId: input.id, name: 'mock.csv' })
        ).json();
        assert.deepEqual(source.file, input.files[0]);
        assert.equal(
          (
            await request('input', {
              group: 'mock-other-group',
              sourceId: input.id,
              name: 'mock.csv',
            })
          ).status,
          404,
        );
        const cancelled = await (
          await request('cancel', { group: group.id, sourceId: input.id })
        ).json();
        assert.equal(cancelled.cancelledSource, input.id);
        assert.ok(
          cancelled.deliveries.every(
            (delivery: { state: string }) => delivery.state === 'cancelled',
          ),
        );
        const replay = await (await request('send', input)).json();
        assert.equal(
          replay.messages.filter((message: { id: string }) => message.id === input.id).length,
          1,
        );
        assert.equal((await request('send', { ...input, prompt: 'changed' })).status, 409);
        const updated = await (
          await request('update', {
            group: group.id,
            revision: 1,
            input: { name: '合成新名', members: group.members },
          })
        ).json();
        assert.equal(updated.revision, 2);
        assert.equal(
          (
            await request('update', {
              group: group.id,
              revision: 1,
              input: { name: 'stale', members: group.members },
            })
          ).status,
          409,
        );
        record('group-http-boundaries', {
          exactReplay: true,
          sourceOwnership: true,
          membershipCAS: true,
          scopedCancellation: true,
        });
      },
    );

    await t.test(
      'model settings API authenticates verified CAS writes and returns no credential material',
      async () => {
        const request = (route: string, data: unknown, token = app.token) =>
          fetch(`${app.url}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-prototype-token': token },
            body: JSON.stringify(data),
          });
        const input = {
          model: 'deepseek-v4-pro',
          apiKey: 'synthetic-http-model-key',
          revision: 0,
          requestId: 'mock-http-config',
        };
        assert.equal((await request('/api/model/configure', input, 'wrong')).status, 403);
        assert.equal(modelChecks, 0);
        assert.equal((await request('/api/model/check', { revision: 0 })).status, 400);
        assert.equal(
          (await request('/api/model/configure', { ...input, baseUrl: 'https://example.test' }))
            .status,
          400,
        );
        const response = await request('/api/model/configure', input);
        assert.equal(response.status, 200);
        const saved = await response.json();
        assert.equal(saved.revision, 1);
        assert.equal(saved.model, 'deepseek-v4-pro');
        assert.equal(modelChecks, 1);
        assert.deepEqual(await (await request('/api/model/configure', input)).json(), saved);
        assert.equal(modelChecks, 1);
        assert.equal((await request('/api/model/check', { revision: 0 })).status, 409);
        assert.equal(
          (await request('/api/model/check', { revision: 1, url: 'https://example.test' })).status,
          400,
        );
        const checked = await (await request('/api/model/check', { revision: 1 })).json();
        assert.equal(checked.model, 'deepseek-v4-pro');
        const status = await (
          await fetch(`${app.url}/api/model/settings`, {
            headers: { 'x-prototype-token': app.token },
          })
        ).json();
        assert.equal(status.configured, true);
        assert.equal(JSON.stringify([saved, checked, status]).includes(input.apiKey), false);
        assert.equal(JSON.stringify([saved, checked, status]).includes('fingerprint'), false);
        record('model-settings-boundary', {
          verifiedSave: true,
          exactRetry: true,
          staleCheckRefused: true,
          credentialReadback: false,
        });
      },
    );

    await t.test(
      'chat attachment API stages immutable files without adding knowledge and downloads workspace bytes exactly',
      async () => {
        assert.ok(app.models);
        const request = (route: string, data: unknown, token = app.token) =>
          fetch(`${app.url}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-prototype-token': token },
            body: JSON.stringify(data),
          });
        const bytes = syntheticOffice('pptx');
        const file = { name: `${'甲'.repeat(82)}abcd.pptx`, data: bytes.toString('base64') };
        assert.equal(
          (await request('/api/attachments/upload', { bot: 'mock-chat', file }, 'wrong')).status,
          403,
        );
        const response = await request('/api/attachments/upload', { bot: 'mock-chat', file });
        assert.equal(response.status, 200);
        const receipt = await response.json();
        assert.match(receipt.content, /MOCK-PPTX-NOTES-53/);
        const read = await request('/api/attachments/read', { bot: 'mock-chat', id: receipt.id });
        assert.equal(read.status, 200);
        assert.equal((await read.json()).content, receipt.content);
        assert.equal(
          (await request('/api/attachments/read', { bot: 'mock-other', id: receipt.id })).status,
          404,
        );
        assert.deepEqual(
          (
            await (
              await request('/api/attachments/source', { bot: 'mock-chat', id: receipt.id })
            ).json()
          ).file,
          file,
        );
        assert.equal(
          (await request('/api/attachments/source', { bot: 'mock-other', id: receipt.id })).status,
          404,
        );
        assert.equal(
          (await (await request('/api/attachments/upload', { bot: 'mock-chat', file })).json()).id,
          receipt.id,
        );
        assert.equal((await app.models.knowledge.list('mock-chat')).length, 0);
        const workspace = runtime.screens.screen('a').workspace;
        await writeFile(path.join(workspace, file.name), bytes);
        const downloaded = await request('/api/files/download', { path: file.name });
        assert.equal(downloaded.status, 200);
        const original = await downloaded.json();
        assert.equal(Buffer.from(original.data, 'base64').equals(bytes), true);
        assert.equal((await request('/api/files/download', { path: '../escape' })).status, 400);
        assert.equal(
          (await request('/api/files/download', { path: file.name, authority: '/private/key' }))
            .status,
          400,
        );
        assert.equal(
          (
            await request('/api/attachments/upload', {
              bot: 'mock-chat',
              file: { ...file, path: '/private/key' },
            })
          ).status,
          400,
        );
        const scope = { bot: 'mock-chat', id: receipt.id };
        assert.equal(
          (await request('/api/attachments/list', { bot: scope.bot, query: {} }, 'wrong')).status,
          403,
        );
        const catalog = await (
          await request('/api/attachments/list', { bot: scope.bot, query: {} })
        ).json();
        const entry = catalog.items[0];
        const removed = await (
          await request('/api/attachments/trash', { ...scope, version: entry.version })
        ).json();
        assert.equal(removed.deleted, true);
        assert.equal((await request('/api/attachments/read', scope)).status, 409);
        assert.equal((await request('/api/attachments/source', scope)).status, 200);
        const recovered = await (
          await request('/api/attachments/restore', { ...scope, version: removed.version })
        ).json();
        assert.equal(recovered.deleted, false);
        assert.equal(
          (await request('/api/attachments/trash', { ...scope, version: entry.version })).status,
          409,
        );
        const trashed = await (
          await request('/api/attachments/trash', { ...scope, version: recovered.version })
        ).json();
        const purge = { ...scope, version: trashed.version, confirmation: file.name };
        assert.equal(
          (await request('/api/attachments/purge', { ...purge, bot: 'mock-other' })).status,
          404,
        );
        assert.equal(
          (await request('/api/attachments/purge', { ...purge, confirmation: 'wrong.pdf' })).status,
          400,
        );
        assert.equal((await request('/api/attachments/purge', purge)).status, 200);
        assert.equal((await request('/api/attachments/purge', purge)).status, 200);
        assert.equal((await request('/api/attachments/source', scope)).status, 404);
        assert.equal(
          (
            await (
              await request('/api/attachments/list', { bot: scope.bot, query: { trash: true } })
            ).json()
          ).originalBytes,
          0,
        );
        const copied = await (await request('/api/files/download', { path: file.name })).json();
        assert.equal(Buffer.from(copied.data, 'base64').equals(bytes), true);
        await request('/api/attachments/upload', { bot: scope.bot, file });
        assert.equal((await request('/api/attachments/purge', purge)).status, 409);
        record('chat-attachment-api', {
          retentionChecks: true,
          privateOriginal: true,
          noImplicitKnowledge: true,
          binaryDownloadExact: true,
        });
      },
    );

    await t.test(
      'independent full root screens contain real terminal and file-manager windows',
      async () => {
        const state = await runtime.snapshot();
        assert.notEqual(state.bots.a.desktop!.display, state.bots.b.desktop!.display);
        for (const id of ['a', 'b']) {
          const windows = state.bots[id].desktop!.windows;
          assert.ok(windows.some((win) => /xterm/i.test(win.class)));
          assert.ok(windows.some((win) => /thunar/i.test(win.class)));
        }
        const frames = await Promise.all(['a', 'b'].map((id) => runtime.frame(id)));
        assert.notDeepEqual(frames[0], frames[1]);
        if (process.env.EVIDENCE_DIR) {
          await mkdir(process.env.EVIDENCE_DIR, { recursive: true });
          await Promise.all(
            frames.map((frame, i) =>
              writeFile(
                path.join(process.env.EVIDENCE_DIR!, `desktop-${i ? 'b' : 'a'}.jpg`),
                frame,
              ),
            ),
          );
        }
        record('independent-x11-desktops', {
          displays: [state.bots.a.desktop!.display, state.bots.b.desktop!.display],
        });
      },
    );

    await t.test(
      'Bot profile API is authenticated, durable and revision-checked without a computer binding',
      async () => {
        const profile = {
          id: 'mock-profile-api',
          name: '合成资料助手',
          instructions: '先给结论',
          memory: '合成偏好',
          color: 'mint',
        };
        const request = (route: string, data?: unknown, authenticated = true) =>
          fetch(app.url + route, {
            method: data === undefined ? 'GET' : 'POST',
            headers: {
              ...(authenticated ? { 'x-prototype-token': app.token } : {}),
              'content-type': 'application/json',
            },
            body: data === undefined ? undefined : JSON.stringify(data),
          });
        assert.equal((await request('/api/bots', undefined, false)).status, 403);
        const first = await request('/api/bots', profile);
        assert.equal(first.status, 200);
        assert.equal((await first.json()).revision, 1);
        const update = await request(`/api/bots/${profile.id}/profile`, {
          revision: 1,
          patch: { memory: '合成新偏好' },
        });
        assert.equal(update.status, 200);
        assert.equal((await update.json()).revision, 2);
        assert.equal(
          (
            await request(`/api/bots/${profile.id}/profile`, {
              revision: 1,
              patch: { name: '过时修改' },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await request(`/api/bots/${profile.id}/profile`, {
              revision: 2,
              patch: { apiKey: 'synthetic-forbidden' },
            })
          ).status,
          400,
        );
        await request('/api/bots', { ...profile, memory: '过时客户端副本' });
        const state = await (await request('/api/state')).json();
        assert.equal(state.clientProtocol, 18);
        assert.equal(
          state.profiles.find((item: { id: string }) => item.id === profile.id).memory,
          '合成新偏好',
        );
        const recovered = new BotProfiles(path.join(dir, 'model', 'bots'));
        assert.equal((await recovered.get(profile.id))?.memory, '合成新偏好');
        const connection = await (await request('/api/model/settings')).json();
        const scoped = await request(`/api/bots/${profile.id}/profile`, {
          revision: 2,
          patch: { model: 'deepseek-v4-pro' },
        });
        assert.equal(scoped.status, 200);
        assert.equal((await scoped.json()).model, 'deepseek-v4-pro');
        const other = await (
          await request('/api/bots', {
            ...profile,
            id: 'mock-profile-other',
            model: 'deepseek-flash',
          })
        ).json();
        assert.equal(other.model, 'deepseek-flash');
        assert.equal(
          (
            await request(`/api/bots/${profile.id}/profile`, {
              revision: 3,
              patch: { model: 'unknown-model' },
            })
          ).status,
          400,
        );
        const inherited = await (
          await request(`/api/bots/${profile.id}/profile`, { revision: 3, patch: { model: null } })
        ).json();
        assert.equal(inherited.revision, 4);
        assert.equal(inherited.model, undefined);
        assert.equal(inherited.memory, '合成新偏好');
        assert.equal(
          (
            await request(`/api/bots/${profile.id}/profile`, {
              revision: 3,
              patch: { model: 'deepseek-v4-pro' },
            })
          ).status,
          409,
        );
        assert.deepEqual(await (await request('/api/model/settings')).json(), connection);
        assert.equal(
          (await new BotProfiles(path.join(dir, 'model', 'bots')).get(profile.id))?.model,
          undefined,
        );
        record('bot-profile-api', {
          revision: 4,
          persisted: true,
          independentModels: true,
          credentialUnchanged: true,
        });
      },
    );

    await t.test(
      'authenticated document import retains scoped originals, exposes model-readable text and rejects corrupt data atomically',
      async () => {
        assert.ok(app.models);
        const request = (action: string, data: unknown, token = app.token) =>
          fetch(`${app.url}/api/knowledge/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-prototype-token': token },
            body: JSON.stringify(data),
          });
        const file = { name: 'synthetic.xlsx', data: syntheticOffice('xlsx').toString('base64') };
        assert.equal((await request('import', { bot: 'mock-import', file }, 'wrong')).status, 403);
        const response = await request('import', { bot: 'mock-import', file });
        assert.equal(response.status, 200);
        const document = await response.json();
        assert.match(document.content, /MOCK-XLSX-HIDDEN-53/);
        assert.equal(document.source.name, file.name);
        const original = await request('source', { bot: 'mock-import', id: document.id });
        assert.equal(original.status, 200);
        assert.deepEqual((await original.json()).file, file);
        assert.equal((await request('source', { bot: 'mock-other', id: document.id })).status, 404);
        const workdir = runtime.screens.screen('a').workspace;
        const run: AgentToolRun = {
          bot: 'mock-import',
          abort: new AbortController(),
          toolCount: 0,
          limit: 4,
          seen: {},
          trace: [],
          workdir,
          canonicalRoot: workdir,
        };
        const read = await app.models.tools.invoke(run, 'bot_knowledge_read', { id: document.id });
        assert.equal(read.isError, undefined);
        assert.match(JSON.stringify(read.content), /MOCK-XLSX-HIDDEN-53/);
        assert.equal(
          read.content.some((item) => item.type === 'image'),
          false,
        );
        for (const invalid of [
          { name: 'corrupt.pdf', data: Buffer.from('broken').toString('base64') },
          { name: 'empty.pdf', data: syntheticPdf('').toString('base64') },
          { name: '../escape.pdf', data: file.data },
          { name: 'synthetic.docx', data: file.data, path: '/private/secret' },
        ])
          assert.equal(
            (await request('import', { bot: 'mock-import', file: invalid })).status,
            400,
          );
        assert.equal((await app.models.knowledge.list('mock-import')).length, 1);
        const retry = await (await request('import', { bot: 'mock-import', file })).json();
        assert.equal(retry.id, document.id);
        assert.equal(retry.revision, 1);
        record('document-import-api', {
          originalRetained: true,
          hiddenSheetRead: true,
          scoped: true,
          invalidImportsLeftNoDocuments: true,
        });
      },
    );

    await t.test(
      'model memory writes reach the same profile API and stale human edits are rejected',
      async () => {
        assert.ok(app.models);
        const input = {
          id: 'mock-live-memory',
          name: '合成记忆验证',
          instructions: '合成职责',
          memory: '合成旧偏好',
          color: 'mint',
        };
        await app.models.profiles.register(input);
        const workdir = runtime.screens.screen('a').workspace;
        const run: AgentToolRun = {
          bot: input.id,
          abort: new AbortController(),
          toolCount: 0,
          limit: 5,
          seen: {},
          trace: [],
          workdir,
          canonicalRoot: workdir,
        };
        const result = await app.models.tools.invoke(run, 'bot_memory_write', {
          revision: 1,
          content: '模型新保存的合成偏好',
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const state = await (
          await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
        ).json();
        const saved = state.profiles.find((profile: { id: string }) => profile.id === input.id);
        assert.equal(saved.memory, '模型新保存的合成偏好');
        assert.equal(saved.revision, 2);
        const conflict = await fetch(`${app.url}/api/bots/${input.id}/profile`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-prototype-token': app.token },
          body: JSON.stringify({ revision: 1, patch: { memory: '过时的合成草稿' } }),
        });
        assert.equal(conflict.status, 409);
        assert.equal((await app.models.profiles.get(input.id))!.memory, saved.memory);
        record('shared-model-ui-memory', { revision: saved.revision, staleSaveRejected: true });
      },
    );

    await t.test(
      'history tools read public task receipts without waking cold sessions or exposing private metadata',
      async () => {
        assert.ok(app.models);
        await app.models.journal.put({
          bot: 'mock-cold-history',
          runId: 'mock-old-history',
          requestId: 'mock-old-request',
          kind: 'chat',
          prompt: '合成旧任务 ARCHIVE-LOCAL',
          result: '合成旧结论 47',
          phase: 'completed',
          running: false,
          error: '',
          trace: [{ reasoning: 'private-native-reasoning' }],
          sessionId: 'private-native-session',
          outputDirectory: '/private/native-session',
          createdAt: '2026-01-01T00:00:00Z',
        });
        const size = app.models.jobs.size;
        const workdir = runtime.screens.screen('a').workspace;
        const run: AgentToolRun = {
          id: 'mock-live-query',
          bot: 'mock-cold-history',
          abort: new AbortController(),
          toolCount: 0,
          limit: 5,
          seen: {},
          trace: [],
          workdir,
          canonicalRoot: workdir,
        };
        const found = await app.models.tools.invoke(run, 'bot_history_search', {
          query: 'ARCHIVE-LOCAL',
        });
        const read = await app.models.tools.invoke(run, 'bot_history_read', {
          runId: 'mock-old-history',
        });
        assert.equal(found.isError, undefined);
        assert.equal(read.isError, undefined);
        assert.match(JSON.stringify(read), /47/);
        assert.equal(JSON.stringify(read).includes('private-native'), false);
        assert.equal(app.models.jobs.size, size);
        const denied = await app.models.tools.invoke({ ...run, bot: 'b' }, 'bot_history_read', {
          runId: 'mock-old-history',
        });
        assert.match(JSON.stringify(denied), /HISTORY_NOT_FOUND/);
        record('scoped-public-history', {
          coldSessionNotWoken: true,
          privateMetadataExcluded: true,
        });
      },
    );

    await t.test(
      'knowledge API shares owned content and version history with model tools',
      async () => {
        assert.ok(app.models);
        const post = (action: string, data: unknown, authenticated = true) =>
          fetch(`${app.url}/api/knowledge/${action}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(authenticated ? { 'x-prototype-token': app.token } : {}),
            },
            body: JSON.stringify(data),
          });
        const input = {
          bot: 'mock-knowledge-api',
          document: { path: '合成知识.md', revision: 0, content: 'ALPHA-KEEP\n报价 47' },
        };
        assert.equal((await post('write', input, false)).status, 403);
        const saved = await post('write', input);
        assert.equal(saved.status, 200);
        const document = await saved.json();
        const workdir = runtime.screens.screen('a').workspace;
        const run: AgentToolRun = {
          id: 'mock-knowledge-native',
          bot: input.bot,
          abort: new AbortController(),
          toolCount: 0,
          limit: 5,
          seen: {},
          trace: [],
          workdir,
          canonicalRoot: workdir,
        };
        const edited = await app.models.tools.invoke(run, 'bot_knowledge_edit', {
          id: document.id,
          revision: 1,
          oldText: '47',
          newText: '53',
        });
        assert.equal(edited.isError, undefined);
        const current = await (await post('read', { bot: input.bot, id: document.id })).json();
        assert.equal(current.content, 'ALPHA-KEEP\n报价 53');
        assert.equal(
          (
            await post('write', {
              ...input,
              document: { ...input.document, id: document.id, revision: 1, content: '过时编辑' },
            })
          ).status,
          409,
        );
        assert.equal((await post('read', { bot: 'b', id: document.id })).status, 404);
        const history = await (await post('versions', { bot: input.bot, id: document.id })).json();
        assert.equal(history.length, 2);
        assert.equal(history[0].actor, 'bot');
        const removed = await (
          await post('remove', { bot: input.bot, id: document.id, revision: 2 })
        ).json();
        const restored = await (
          await post('restore', {
            bot: input.bot,
            id: document.id,
            revision: removed.revision,
            targetRevision: 1,
          })
        ).json();
        assert.equal(restored.content, input.document.content);
        assert.equal(restored.revision, 4);
        record('versioned-knowledge-api', {
          modelHumanShareAuthority: true,
          crossBotRefused: true,
          restoredRevision: 4,
        });
      },
    );

    await t.test(
      'schedule API persists definitions, validates revisions and refuses unauthenticated mutations',
      async () => {
        const post = (action: string, data: unknown, authenticated = true) =>
          fetch(`${app.url}/api/schedules/${action}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(authenticated ? { 'x-prototype-token': app.token } : {}),
            },
            body: JSON.stringify(data),
          });
        const input = {
          id: 'mock-schedule-api',
          bot: 'mock-profile-api',
          title: '合成定时说明',
          prompt: '只处理合成数据',
          enabled: false,
          rule: { kind: 'every', everySeconds: 86400 },
        };
        assert.equal((await post('create', input, false)).status, 403);
        const created = await post('create', input);
        assert.equal(created.status, 200);
        assert.equal((await created.json()).revision, 1);
        assert.equal(
          (await post('update', { id: input.id, revision: '1', patch: { title: '无效版本类型' } }))
            .status,
          400,
        );
        const changed = await post('update', {
          id: input.id,
          revision: 1,
          patch: { title: '合成新名称' },
        });
        assert.equal(changed.status, 200);
        assert.equal((await changed.json()).revision, 2);
        assert.equal(
          (await post('update', { id: input.id, revision: 1, patch: { enabled: true } })).status,
          409,
        );
        assert.equal((await post('get', { id: input.id })).status, 200);
        assert.ok(
          app.models!.tools.list(input.bot).some((tool) => tool.name === 'bot_schedule_list'),
        );
        const locked = await post('update', { id: input.id, revision: 2, patch: { locked: true } });
        assert.equal(locked.status, 200);
        assert.equal((await locked.json()).locked, true);
        await assert.rejects(
          app.schedules!.update(input.id, 3, { title: '模型不能改动' }, { bot: input.bot }),
          { code: 'SCHEDULE_LOCKED' },
        );
        assert.equal(
          (await post('update', { id: input.id, revision: 3, patch: { locked: false } })).status,
          200,
        );
        assert.equal((await post('remove', { id: input.id, revision: 4 })).status, 200);
        assert.equal((await post('get', { id: input.id })).status, 404);
        record('durable-schedule-api', {
          revision: 4,
          mutationsAuthenticated: true,
          lockedModelMutationRefused: true,
        });
      },
    );

    await t.test(
      'human reply API enforces authentication, ownership, one-shot decisions and exact retry',
      async () => {
        assert.ok(app.models);
        const input = {
          id: 'mock-api-approval',
          sessionId: 'mock-api-session',
          kind: 'approval' as const,
          tool: 'web_fetch' as const,
          url: 'https://example.test/new',
        };
        await app.models.interactions.open('mock-bot', 'mock-api-run', input);
        const reply = {
          id: input.id,
          runId: 'mock-api-run',
          reply: { kind: 'decision', allow: false },
        };
        const post = (bot: string, data: unknown, authenticated = true) =>
          fetch(`${app.url}/api/bots/${bot}/reply`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(authenticated ? { 'x-prototype-token': app.token } : {}),
            },
            body: JSON.stringify(data),
          });
        assert.equal((await post('mock-bot', reply, false)).status, 403);
        assert.equal((await post('other-bot', reply)).status, 404);
        assert.equal(
          (await post('mock-bot', { ...reply, credentials: 'mock-private' })).status,
          400,
        );
        assert.equal((await post('mock-bot', reply)).status, 200);
        assert.equal((await post('mock-bot', reply)).status, 200);
        assert.equal(
          (await post('mock-bot', { ...reply, reply: { kind: 'decision', allow: true } })).status,
          409,
        );
        const state = await fetch(`${app.url}/api/state`, {
          headers: { 'x-prototype-token': app.token },
        }).then((response) => response.json());
        assert.equal(state.clientProtocol, 18);
        assert.equal(
          state.interactions.find((item: { id: string }) => item.id === input.id).status,
          'resolved',
        );
        record('human-reply-api', { refused: true, idempotent: true });
      },
    );

    await t.test(
      'client pointer focus does not scroll the preview away from the click',
      async () => {
        const { chromium } = (await import(
          process.env.PLAYWRIGHT_MODULE || 'playwright'
        )) as typeof import('playwright');
        // The trusted client must not inherit the Bot browser's public-network-only proxy.
        const clientBrowser = await chromium.launch({ headless: true, chromiumSandbox: true });
        const client = await clientBrowser.newContext({
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: { 'x-prototype-token': app.token },
        });
        try {
          const page = await client.newPage();
          await page.goto(app.url);
          await page.locator('[data-bot="a"] .control').click();
          await page.locator('[data-view="a"]').click();
          await page.locator('[data-bot="a"] .control').getByText('交还 Bot').waitFor();
          const viewport = await page.locator('[data-bot="a"] .viewport').boundingBox();
          const before = await page.evaluate(() => scrollY);
          await page.mouse.click(viewport!.x + 15, viewport!.y + 15);
          assert.equal(await page.evaluate(() => scrollY), before);
          record('client-pointer-focus', { scrollPreserved: true });
        } finally {
          const lease = runtime.control.state('a');
          if (lease.owner === 'human')
            await runtime.transfer('a', lease.epoch, 'agent', runtime.screens.instance('a'));
          await clientBrowser.close();
        }
      },
    );

    await t.test('native pointer events can drag an actual terminal window', async () => {
      const lease = await runtime.transfer(
        'a',
        runtime.control.state('a').epoch,
        'human',
        runtime.screens.instance('a'),
      );
      await runtime.openApp('a', lease.epoch, 'terminal', runtime.screens.instance('a'));
      const before = (await runtime.screens.windows('a')).find((win) => /xterm/i.test(win.class));
      const { stdout } = await runtime.screens.run('a', 'xwininfo', ['-id', before!.id]);
      const x = Number(stdout.match(/Absolute upper-left X:\s+(\d+)/)![1]);
      const y = Number(stdout.match(/Absolute upper-left Y:\s+(\d+)/)![1]);
      const start = { x: x + 180, y: y - 10 };
      await runtime.input(
        'a',
        lease.epoch,
        {
          type: 'pointer',
          phase: 'down',
          button: 1,
          ...start,
        },
        runtime.screens.instance('a'),
      );
      await runtime.input(
        'a',
        lease.epoch,
        {
          type: 'pointer',
          phase: 'move',
          button: 1,
          x: start.x + 70,
          y: start.y + 60,
        },
        runtime.screens.instance('a'),
      );
      await runtime.input(
        'a',
        lease.epoch,
        {
          type: 'pointer',
          phase: 'up',
          button: 1,
          x: start.x + 70,
          y: start.y + 60,
        },
        runtime.screens.instance('a'),
      );
      await wait(async () => {
        const after = (await runtime.screens.windows('a')).find((win) => win.id === before!.id);
        return Math.abs(after!.x - before!.x) > 40 && Math.abs(after!.y - before!.y) > 40;
      });
      record('native-window-drag', { actualWindowMoved: true });
      await runtime.transfer('a', lease.epoch, 'agent', runtime.screens.instance('a'));
    });

    for (const id of ['a', 'b'])
      await t.test(
        `desktop ${id}: real terminal creates a file and real editor saves Chinese text`,
        async () => {
          const lease = await runtime.transfer(
            id,
            runtime.control.state(id).epoch,
            'human',
            runtime.screens.instance(id),
          );
          const screen = runtime.screens.screen(id);
          await runtime.openApp(id, lease.epoch, 'terminal', runtime.screens.instance(id));
          await runtime.input(
            id,
            lease.epoch,
            {
              type: 'text',
              text: `printf 'synthetic-${id}\\n' > '${path.join(screen.workspace, `human-${id}.txt`)}'`,
            },
            runtime.screens.instance(id),
          );
          await runtime.input(
            id,
            lease.epoch,
            { type: 'key', key: 'Enter' },
            runtime.screens.instance(id),
          );
          await wait(async () =>
            (await readFile(path.join(screen.workspace, `human-${id}.txt`), 'utf8')).includes(
              `synthetic-${id}`,
            ),
          );
          await runtime.openApp(id, lease.epoch, 'files', runtime.screens.instance(id));
          await runtime.openApp(id, lease.epoch, 'editor', runtime.screens.instance(id));
          await runtime.input(
            id,
            lease.epoch,
            { type: 'key', key: 'ctrl+a' },
            runtime.screens.instance(id),
          );
          await runtime.input(
            id,
            lease.epoch,
            {
              type: 'text',
              text: `桌面 ${id.toUpperCase()} 的合成编辑内容`,
            },
            runtime.screens.instance(id),
          );
          await runtime.input(
            id,
            lease.epoch,
            { type: 'key', key: 'ctrl+s' },
            runtime.screens.instance(id),
          );
          if (process.env.EVIDENCE_DIR)
            await writeFile(
              path.join(process.env.EVIDENCE_DIR!, `editor-${id}.jpg`),
              await runtime.frame(id),
            );
          await wait(
            async () =>
              (await readFile(screen.note, 'utf8')).trim() ===
              `桌面 ${id.toUpperCase()} 的合成编辑内容`,
          );
          record(`native-apps-${id}`, { terminalFileCreated: true, editorFileSaved: true });
        },
      );

    await t.test(
      'the editor launcher can focus a document opened through the file manager',
      async () => {
        const lease = runtime.control.state('a');
        const file = path.join(runtime.screens.screen('a').workspace, 'human-a.txt');
        await runtime.openApp('a', lease.epoch, 'files', runtime.screens.instance('a'));
        await runtime.input(
          'a',
          lease.epoch,
          { type: 'key', key: 'ctrl+l' },
          runtime.screens.instance('a'),
        );
        await runtime.input(
          'a',
          lease.epoch,
          { type: 'text', text: file },
          runtime.screens.instance('a'),
        );
        await runtime.input(
          'a',
          lease.epoch,
          { type: 'key', key: 'Enter' },
          runtime.screens.instance('a'),
        );
        await wait(async () =>
          (await runtime.screens.windows('a')).some(
            (win) => /mousepad/i.test(win.class) && win.title.includes('human-a.txt'),
          ),
        );
        const editor = await runtime.openApp(
          'a',
          lease.epoch,
          'editor',
          runtime.screens.instance('a'),
        );
        assert.ok(editor.title.includes('human-a.txt'));
        record('existing-native-document', { fileManagerOpened: true, editorRemainsUsable: true });
      },
    );

    await t.test(
      'logging in through the GTK browser window shares the session with the other desktop',
      async () => {
        const id = 'a';
        const lease = runtime.control.state(id);
        await runtime.openApp(id, lease.epoch, 'browser', runtime.screens.instance(id));
        const screen = runtime.screens.screen(id);
        let layout!: {
          owner: string;
          epoch: number;
          x: number;
          y: number;
          width: number;
          height: number;
        };
        await wait(async () => {
          layout = JSON.parse(
            await readFile(path.join(screen.directory, 'viewer-layout.json'), 'utf8'),
          );
          return layout.owner === 'human' && layout.epoch === lease.epoch;
        });
        const box = await runtime.browser.page(id).locator('#login').boundingBox();
        await runtime.input(
          id,
          lease.epoch,
          {
            type: 'click',
            x: layout.x + ((box!.x + box!.width / 2) * layout.width) / 960,
            y: layout.y + ((box!.y + box!.height / 2) * layout.height) / 640,
          },
          runtime.screens.instance(id),
        );
        await Promise.all(
          ['a', 'b'].map((key) =>
            runtime.browser
              .page(key)
              .waitForFunction(
                () => document.querySelector('#identity')!.textContent === '示例用户',
              ),
          ),
        );
        await runtime.openApp(
          'b',
          runtime.control.state('b').epoch,
          'browser',
          runtime.screens.instance('b'),
        );
        record('native-viewer-shared-login', { throughX11Input: true, sharedHttpOnlyCookie: true });
      },
    );

    for (const [id, other] of [
      ['a', 'b'],
      ['b', 'a'],
    ])
      await t.test(
        `handoff ${id} fences desktop input while ${other} keeps creating files`,
        async () => {
          for (const key of ['a', 'b']) {
            const lease = runtime.control.state(key);
            if (lease.owner === 'human')
              await runtime.transfer(key, lease.epoch, 'agent', runtime.screens.instance(key));
            await runtime.startWorker(key);
          }
          await wait(
            () => runtime.screens.screen(id).steps >= 1 && runtime.screens.screen(other).steps >= 1,
          );
          assert.ok(
            Number(await runtime.browser.page(id).locator('#count').textContent()) >= 1,
            'native tasks must preserve the original browser automation',
          );
          const beforeLease = runtime.control.state(id);
          const human = await runtime.transfer(
            id,
            beforeLease.epoch,
            'human',
            runtime.screens.instance(id),
          );
          const frozen = runtime.screens.screen(id).steps;
          const before = runtime.screens.screen(other).steps;
          const webBefore = Number(await runtime.browser.page(id).locator('#count').textContent());
          const otherWebBefore = Number(
            await runtime.browser.page(other).locator('#count').textContent(),
          );
          await wait(() => runtime.screens.screen(other).steps >= before + 2);
          assert.equal(runtime.screens.screen(id).steps, frozen);
          assert.equal(
            Number(await runtime.browser.page(id).locator('#count').textContent()),
            webBefore,
          );
          assert.ok(
            Number(await runtime.browser.page(other).locator('#count').textContent()) >
              otherWebBefore,
          );
          await assert.rejects(
            runtime.input(
              id,
              beforeLease.epoch,
              { type: 'key', key: 'Enter' },
              runtime.screens.instance(id),
            ),
            { code: 'STALE_CONTROL' },
          );
          await runtime.openApp(id, human.epoch, 'files', runtime.screens.instance(id));
          await runtime.transfer(id, human.epoch, 'agent', runtime.screens.instance(id));
          await assert.rejects(
            runtime.input(
              id,
              human.epoch,
              { type: 'key', key: 'Enter' },
              runtime.screens.instance(id),
            ),
            {
              code: 'STALE_CONTROL',
            },
          );
          await wait(() => runtime.screens.screen(id).steps > frozen);
          record(`native-handoff-${id}`, {
            frozen,
            otherProgressedBy: runtime.screens.screen(other).steps - before,
            resumed: true,
            staleInputRejected: true,
          });
        },
      );
    await Promise.all(['a', 'b'].map((id) => runtime.stopWorker(id)));
    await t.test(
      'rebuilding both desktop sessions preserves files and shared browser login',
      async () => {
        const saved = await readFile(runtime.screens.screen('a').note, 'utf8');
        const port = Number(new URL(app.url).port);
        await app.close();
        app = await startPrototype({
          fixture: true,
          profileDir: path.join(dir, 'profile'),
          port,
          desktop: { dir: path.join(dir, 'desktops'), displayBase: 31 },
        });
        assert.equal(await readFile(app.runtime.screens.screen('a').note, 'utf8'), saved);
        assert.equal((await app.runtime.snapshot()).sharedLogin, true);
        record('desktop-restart-persistence', { filesUnchanged: true, sharedLoginRetained: true });
      },
    );
    if (process.env.EVIDENCE_DIR)
      await writeFile(
        path.join(process.env.EVIDENCE_DIR!, 'desktop-checks.json'),
        JSON.stringify({ platform: process.platform, checks }, null, 2),
      );
  } finally {
    if (process.env.EVIDENCE_DIR) {
      await mkdir(process.env.EVIDENCE_DIR, { recursive: true });
      try {
        await writeFile(
          path.join(process.env.EVIDENCE_DIR!, 'desktop-log.txt'),
          await readFile(path.join(dir, 'desktops/desktop.log')),
        );
      } catch {}
    }
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
