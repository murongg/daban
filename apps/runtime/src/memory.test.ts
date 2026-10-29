import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { MemoryTools, memoryToolList } from './memory.js';
import { BotProfiles, personaKey } from './profiles.js';
import { WorkspaceFiles } from './workspace.js';

function value(result: ToolResult) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return JSON.parse(block.type === 'text' ? block.text : '') as {
    content: string;
    revision: number;
  };
}
test('memory tools use the existing Bot profile, isolate ownership and reject stale or malformed saves', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-memory-tools-'));
  try {
    const profiles = new BotProfiles(path.join(root, 'profiles'));
    const first = await profiles.register({
      id: 'mock-alpha',
      name: '合成甲',
      instructions: '合成职责',
      memory: '保留的合成偏好',
      color: 'mint',
    });
    const other = await profiles.register({
      id: 'mock-beta',
      name: '合成乙',
      instructions: first.instructions,
      color: first.color,
      memory: '另一位的合成偏好',
    });
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const tools = new AgentTools(undefined, new WorkspaceFiles(workspace));
    tools.memory = new MemoryTools(profiles);
    const run: AgentToolRun = {
      bot: 'mock-alpha',
      abort: new AbortController(),
      toolCount: 0,
      limit: 30,
      seen: {},
      trace: [],
      workdir: workspace,
      canonicalRoot: workspace,
    };
    assert.ok(
      memoryToolList.every((tool) => tools.list(run.bot).some((entry) => entry.name === tool.name)),
    );
    assert.deepEqual(value(await tools.invoke(run, 'bot_memory_read')), {
      content: first.memory,
      revision: 1,
    });
    const content = `${first.memory}\n新增合成代号 MOCK-VEGA`;
    const saved = value(await tools.invoke(run, 'bot_memory_write', { revision: 1, content }));
    assert.equal(saved.content, content);
    assert.equal((await profiles.get(run.bot))!.memory, content);
    assert.equal((await profiles.history(run.bot, {})).items[0].source, 'agent');
    assert.equal(personaKey(await profiles.get(run.bot)), personaKey(first));
    assert.deepEqual(
      value(await tools.invoke(run, 'bot_memory_write', { revision: 1, content })),
      saved,
      'an exact lost-response retry is a readback, not another mutation',
    );
    for (const bad of [
      { revision: saved.revision, content, bot: other.id },
      { revision: saved.revision, content, name: '越权改名' },
      { revision: 0, content },
      { revision: saved.revision, content: 'x'.repeat(12001) },
      { revision: saved.revision, content: 'bad\0text' },
    ])
      assert.equal((await tools.invoke(run, 'bot_memory_write', bad)).isError, true);
    assert.equal((await tools.invoke(run, 'bot_memory_read', { bot: other.id })).isError, true);
    const human = await profiles.update(run.bot, saved.revision, {
      memory: '人类新保存的合成偏好',
    });
    assert.match(
      JSON.stringify(
        await tools.invoke(run, 'bot_memory_write', {
          revision: saved.revision,
          content: '过时的模型修改',
        }),
      ),
      /BOT_PROFILE_CONFLICT/,
    );
    assert.equal((await profiles.get(run.bot))!.memory, human.memory);
    assert.deepEqual(await profiles.get(other.id), other);
    const forgotten = value(
      await tools.invoke(run, 'bot_memory_write', { revision: human.revision, content: '' }),
    );
    assert.equal(forgotten.content, '');
    assert.equal(value(await tools.invoke(run, 'bot_memory_read')).content, '');
    assert.equal(
      JSON.stringify(value(await tools.invoke(run, 'bot_memory_read'))).includes('MOCK-VEGA'),
      false,
    );
    assert.ok(
      (await profiles.history(run.bot, {})).items.some((item) =>
        item.content.includes('MOCK-VEGA'),
      ),
    );
    const restored = new BotProfiles(path.join(root, 'profiles'));
    assert.equal((await restored.get(run.bot))!.memory, '');
    assert.match(
      JSON.stringify(await tools.invoke({ ...run, bot: 'missing' }, 'bot_memory_read')),
      /BOT_PROFILE_NOT_FOUND/,
    );
    assert.ok(run.trace.every((entry) => entry.surface === 'memory'));
    assert.equal(JSON.stringify(run.trace).includes('MOCK-VEGA'), false);
    const limited = { ...run, toolCount: 0, limit: 1, trace: [] };
    await tools.invoke(limited, 'bot_memory_read');
    assert.match(
      JSON.stringify(
        await tools.invoke(limited, 'bot_memory_write', {
          revision: forgotten.revision,
          content: '不得写入',
        }),
      ),
      /TOOL_LIMIT/,
    );
    const stopped = { ...run, abort: new AbortController() };
    stopped.abort.abort();
    assert.match(
      JSON.stringify(
        await tools.invoke(stopped, 'bot_memory_write', {
          revision: forgotten.revision,
          content: '不得写入',
        }),
      ),
      /MODEL_CANCELLED/,
    );
    assert.equal((await profiles.get(run.bot))!.memory, '');
    await tools.drain(run);
    profiles.get = async () => {
      throw Object.assign(new Error('EACCES: /private/mock-profile-store/mock-alpha.json'), {
        code: 'EACCES',
      });
    };
    const failure = JSON.stringify(await tools.invoke(run, 'bot_memory_read'));
    assert.match(failure, /EACCES/);
    assert.equal(failure.includes('/private/mock-profile-store'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
