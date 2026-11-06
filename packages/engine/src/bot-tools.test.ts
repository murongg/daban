import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { AgentToolRun } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

const input = { name: 'Mock helper', instructions: 'Organize synthetic examples.' };
function value(result: ToolResult): { id: string; name: string } {
  const item = result.content[0];
  expect.assert(item.type === 'text');
  return JSON.parse(item.text);
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bot-tools-'));
  const options = {
    settings: new ModelSettings(path.join(root, 'credentials.json')),
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    nativeOnly: true,
  };
  const models = new ModelRuns(options);
  await models.ready;
  await models.profiles.register({
    id: 'mock-source',
    name: 'Mock source',
    instructions: 'Synthetic source role.',
    memory: 'SYNTHETIC PRIVATE PREFERENCE',
    color: 'mint',
    model: 'deepseek-v4-pro',
  });
  const run: AgentToolRun = {
    id: 'mock-run',
    intentId: 'mock-intent',
    bot: 'mock-source',
    abort: new AbortController(),
    workdir: '/mock/task',
    canonicalRoot: '/mock/task',
    task: { requestId: 'mock-request', prompt: 'Create a synthetic helper Bot.' },
    toolCount: 0,
    limit: 30,
    seen: {},
    trace: [],
  };
  return {
    root,
    options,
    models,
    run,
    async close() {
      await models.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('the built-in skill creates an ordinary Bot without a computer or copying private state', async () => {
  const f = await fixture();
  try {
    const { models, run } = f;
    const skill = (await models.skills.list(run.bot)).items.find(
      (item) => item.name === 'bot-manager',
    );
    expect(skill).toMatchObject({ system: true, enabled: true });
    expect(
      models.tools.list(run.bot, undefined, undefined, run).map((tool) => tool.name),
    ).toContain('bot_create');
    const result = await models.tools.invoke(run, 'bot_create', input);
    expect(result.isError).not.toBe(true);
    const receipt = value(result);
    expect(receipt).toMatchObject({ ...input, color: 'violet', archived: false });
    const created = await models.profiles.get(receipt.id);
    expect(created).toMatchObject({ ...input, memory: '', color: 'violet', revision: 1 });
    expect(created?.model).toBeUndefined();
    expect(models.jobs.size).toBe(0);
    expect((await models.skills.capture(receipt.id)).skills.map((item) => item.name)).toContain(
      'bot-manager',
    );
    expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC PRIVATE PREFERENCE');
    await expect(
      models.skills.update(skill!.id, skill!.revision, 'Synthetic replacement'),
    ).rejects.toMatchObject({ code: 'SKILL_SYSTEM_READ_ONLY' });
    await models.skills.bind(run.bot, {
      id: skill!.id,
      revision: skill!.revision,
      bindingRevision: skill!.bindingRevision,
      enabled: false,
    });
    expect(
      (await models.skills.list(run.bot)).items.find((item) => item.id === skill!.id)?.enabled,
    ).toBe(false);
    expect(
      (await models.skills.list(receipt.id)).items.find((item) => item.id === skill!.id)?.enabled,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('creation retries survive restart and later edits without creating another Bot or overwriting it', async () => {
  const f = await fixture();
  let recovered: ModelRuns | undefined;
  try {
    const { models, run } = f;
    const results = await Promise.all([
      models.tools.invoke(run, 'bot_create', input),
      models.tools.invoke(run, 'bot_create', input),
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    const receipt = value(results[0]);
    expect(value(results[1]).id).toBe(receipt.id);
    await models.profiles.update(receipt.id, 1, {
      name: 'Mock renamed',
      memory: 'SYNTHETIC NEW PRIVATE PREFERENCE',
    });
    const release = models.profiles.reserveLifecycle(receipt.id);
    try {
      await models.profiles.beginLifecycle({
        id: 'mock-archive-created',
        bot: receipt.id,
        revision: 2,
        action: 'archive',
      });
      await models.profiles.finishLifecycle(receipt.id, 'mock-archive-created');
    } finally {
      release();
    }
    await models.close();
    recovered = new ModelRuns(f.options);
    await recovered.ready;
    const retried = await recovered.tools.invoke(
      { ...run, id: 'mock-retry-run' },
      'bot_create',
      input,
    );
    expect(retried.isError).not.toBe(true);
    expect(value(retried)).toMatchObject({ id: receipt.id, name: 'Mock renamed', archived: true });
    expect(JSON.stringify(retried)).not.toContain('SYNTHETIC NEW PRIVATE PREFERENCE');
    const changed = await recovered.tools.invoke(run, 'bot_create', {
      ...input,
      name: 'Mock changed',
    });
    expect(changed).toMatchObject({ isError: true, content: [{ text: 'BOT_REQUEST_ID_REUSED' }] });
    expect(await recovered.profiles.list()).toHaveLength(2);
    const next = await recovered.tools.invoke(
      { ...run, intentId: 'mock-next-intent' },
      'bot_create',
      input,
    );
    expect(next.isError).not.toBe(true);
    expect(value(next).id).not.toBe(receipt.id);
  } finally {
    await recovered?.close();
    await f.close();
  }
});

test('cancelling a queued creation leaves no saved Bot', async () => {
  const f = await fixture();
  try {
    const pending = f.models.tools.invoke(f.run, 'bot_create', input);
    f.run.abort.abort();
    expect(await pending).toMatchObject({ isError: true });
    expect(await f.models.profiles.list()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('creation rejects invalid arguments, missing task ownership and cancelled or archived callers', async () => {
  const f = await fixture();
  try {
    const { models, run } = f;
    for (const args of [
      { ...input, name: '' },
      { ...input, instructions: 'x'.repeat(4001) },
      { ...input, color: 'invalid' },
      { ...input, memory: 'SYNTHETIC UNAUTHORIZED MEMORY' },
      { ...input, id: run.bot },
      { ...input, model: 'deepseek-v4-pro' },
    ]) {
      expect(await models.tools.invoke(run, 'bot_create', args)).toMatchObject({ isError: true });
    }
    const noTask = { ...run, task: undefined };
    expect(
      models.tools.list(run.bot, undefined, undefined, noTask).map((tool) => tool.name),
    ).not.toContain('bot_create');
    expect(await models.tools.invoke(noTask, 'bot_create', input)).toMatchObject({ isError: true });
    expect(
      await models.tools.invoke({ ...run, bot: 'mock-missing' }, 'bot_create', input),
    ).toMatchObject({ isError: true });
    const cancelled = { ...run, abort: new AbortController() };
    cancelled.abort.abort();
    expect(await models.tools.invoke(cancelled, 'bot_create', input)).toMatchObject({
      isError: true,
    });
    const release = models.profiles.reserveLifecycle(run.bot);
    try {
      await models.profiles.beginLifecycle({
        id: 'mock-archive',
        bot: run.bot,
        revision: 1,
        action: 'archive',
      });
      expect(await models.tools.invoke(run, 'bot_create', input)).toMatchObject({ isError: true });
    } finally {
      release();
    }
    expect(await models.profiles.list()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
