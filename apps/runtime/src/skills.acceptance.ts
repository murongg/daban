import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSkillBindingResult, isSkillCatalogResult, type SkillDocument } from '@daban/protocol';
import { startPrototype } from './server.js';

export async function acceptSkills(output: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-skills-model-'));
  const key = '/var/lib/bot-prototype/model/credentials.json',
    before = await stat(key);
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await symlink(key, path.join(root, 'model/credentials.json'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
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
      if (route === '/api/skills/bind') assert.ok(isSkillBindingResult(value));
      if (route === '/api/skills/list') assert.ok(isSkillCatalogResult(value));
      if (
        (route === '/api/skills/bind' || route === '/api/skills/list') &&
        data &&
        typeof data === 'object' &&
        'bot' in data
      )
        assert.equal(value.bot, data.bot);
      return value;
    };
    assert.equal((await api('/api/state')).clientProtocol, 30);
    for (const id of ['mock-skill-a', 'mock-skill-b'])
      await models.profiles.register({
        id,
        name: `合成 ${id}`,
        instructions: '',
        memory: 'SYNTHETIC-SKILL-MEMORY',
        color: 'mint',
        model: 'deepseek-flash',
      });
    const marker = (kind: string) => `SYNTHETIC-${kind}-${randomBytes(6).toString('hex')}`;
    const manualMarker = marker('MANUAL'),
      automaticMarker = marker('AUTO'),
      changedMarker = marker('CHANGED');
    const document = (name: string, value: string, manual = false) =>
      `---\nname: ${name}\ndescription: 合成技能验收，按说明只回复唯一标记。\ndisable-model-invocation: ${manual}\n---\n此技能只用于已授权的合成验收。不使用电脑、文件、联网或其他工具。加载后只回复这个确切标记：${value}\n`;
    const manual = (await api('/api/skills/import', {
      bot: 'mock-skill-a',
      content: document('mock-manual', manualMarker, true),
    })) as SkillDocument;
    const automatic = (await api('/api/skills/import', {
      bot: 'mock-skill-a',
      content: document('mock-auto', automaticMarker),
    })) as SkillDocument;
    for (const skill of [manual, automatic])
      await api('/api/skills/bind', {
        bot: 'mock-skill-a',
        binding: {
          id: skill.id,
          revision: skill.revision,
          bindingRevision: 0,
          enabled: true,
        },
      });
    assert.equal(
      (await api('/api/skills/list', { bot: 'mock-skill-a' })).catalog.items.filter(
        (item: { enabled: boolean }) => item.enabled,
      ).length,
      2,
    );
    assert.equal(
      (await api('/api/skills/list', { bot: 'mock-skill-b' })).catalog.items.some(
        (item: { enabled: boolean }) => item.enabled,
      ),
      false,
    );
    const turns: { bot: string; session?: string; tools: string[]; result: string }[] = [];
    async function turn(bot: string, id: string, prompt: string) {
      const accepted = await api(`/api/bots/${bot}/model`, {
        running: true,
        task: { requestId: id, prompt },
      });
      assert.equal(accepted.requestId, id);
      const job = models.jobs.get(bot)!;
      await job.done;
      assert.equal(job.phase, 'completed', job.error);
      const value = {
        bot,
        session: job.sessionId,
        tools: job.trace.map((item) => item.name),
        result: job.result,
      };
      turns.push(value);
      await writeFile(
        output,
        JSON.stringify(
          { verified: false, syntheticOnly: true, paidTurns: turns.length, turns },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return value;
    }
    const first = await turn(
      'mock-skill-a',
      'mock-native-manual',
      '/mock-manual\n请按此技能回复，不调用其他工具。',
    );
    assert.equal(first.result.trim(), manualMarker);
    assert.equal(
      first.tools.length,
      0,
      'Native explicit invocation injects context without a model tool call',
    );
    const second = await turn(
      'mock-skill-a',
      'mock-native-auto',
      '请先调用 skill 加载 mock-auto，再按它的说明回复唯一标记。不使用其他工具。',
    );
    assert.equal(second.result.trim(), automaticMarker);
    assert.deepEqual(second.tools, ['skill']);
    assert.equal(second.session, first.session);
    const other = await turn(
      'mock-skill-b',
      'mock-native-other',
      '合成普通问候：只回复 SYNTHETIC-OTHER，完全不要调用工具。',
    );
    assert.equal(other.tools.length, 0);
    const edited = (await api('/api/skills/update', {
      bot: 'mock-skill-a',
      id: automatic.id,
      revision: automatic.revision,
      content: document('mock-auto', changedMarker),
    })) as SkillDocument;
    const changed = await turn(
      'mock-skill-a',
      'mock-native-changed',
      '请先调用 skill 加载 mock-auto，再按当前说明回复唯一标记。不使用其他工具。',
    );
    assert.equal(changed.result.trim(), changedMarker);
    assert.deepEqual(changed.tools, ['skill']);
    assert.notEqual(changed.session, second.session);
    assert.equal(changed.result.includes(automaticMarker), false);
    for (const skill of [manual, edited])
      await api('/api/skills/bind', {
        bot: 'mock-skill-a',
        binding: {
          id: skill.id,
          revision: skill.revision,
          bindingRevision: 1,
          enabled: false,
        },
      });
    const disabled = await turn(
      'mock-skill-a',
      'mock-native-disabled',
      '合成普通问候：只回复 SYNTHETIC-DISABLED，不调用任何工具，不继续旧技能任务。',
    );
    assert.equal(disabled.tools.length, 0);
    assert.notEqual(disabled.session, changed.session);
    const job = models.jobs.get('mock-skill-a')!;
    const disabledPatch = JSON.parse(
      await readFile(path.join(job.privateDir, 'computer.patch.yml'), 'utf8'),
    ) as { insert?: { id: string }[] }[];
    assert.equal(
      disabledPatch.flatMap((row) => row.insert ?? []).some((row) => row.id === 'daban-skills'),
      false,
    );
    assert.equal((await models.profiles.get('mock-skill-a'))?.memory, 'SYNTHETIC-SKILL-MEMORY');
    assert.equal(app.runtime.status().items.length, 0);
    const after = await stat(key);
    assert.deepEqual(
      [after.ino, after.size, after.mtimeMs, after.mode],
      [before.ino, before.size, before.mtimeMs, before.mode],
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          verified: true,
          protocol: 20,
          authenticatedLibraryAndTaskApis: true,
          botBoundCatalogAndBindingReplies: true,
          syntheticOnly: true,
          paidTurns: turns.length,
          turns,
          nativeManualInvocation: true,
          nativeSkillTool: true,
          noDefaultRoots: true,
          perBotIsolation: true,
          changedAndDisabledSkillsRenewSession: true,
          conversationAndMemoryRetained: true,
          noGraphicsStarted: true,
          credentialMetadataUnchanged: true,
          originalUserServiceChanged: false,
          limits: [
            'Single-file Markdown skills only; executable plugins, resource bundles and MCP installation are separate open work',
            'Original Electron UI and candidate activation not exercised by this helper',
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Evidence output path required');
  await acceptSkills(process.argv[2]);
}
