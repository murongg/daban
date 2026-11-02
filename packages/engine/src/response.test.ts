import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-response-'));
  await mkdir(path.join(root, 'workspace'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const key = 'mock-private-stream-key-123456';
  await settings.save({ apiKey: key });
  type Gate = {
    ready: Promise<unknown>;
    enter: () => unknown;
    finish: (value: { sessionId: string; finalResponse: string }) => unknown;
    result: Promise<{ sessionId: string; finalResponse: string }>;
    observe?: (value: unknown) => unknown;
    prompt?: string;
  };
  const gates = new Map<string, Gate>();
  class Harness {
    readonly bot: string;
    constructor(options: { processCwd: string }) {
      this.bot = path.basename(options.processCwd);
    }
    async start() {}
    async close() {
      gates.get(this.bot)?.finish({ sessionId: 'mock-stream-session', finalResponse: '合成关闭' });
    }
    session() {
      return {
        id: 'mock-stream-session',
        run: async (prompt: unknown, observer: { onNotification: (value: unknown) => unknown }) => {
          assert.ok(typeof prompt === 'string');
          const gate = gates.get(this.bot)!;
          gate.observe = observer.onNotification;
          gate.prompt = prompt;
          gate.enter();
          return gate.result;
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  };
  const models = new ModelRuns(options);
  const start = async (bot: string, request = `mock-request-${bot}`) => {
    let enter = () => {},
      finish: Gate['finish'] = () => undefined;
    const ready = new Promise<unknown>((resolve) => {
      enter = () => resolve(undefined);
    });
    const result = new Promise<{ sessionId: string; finalResponse: string }>((resolve) => {
      finish = resolve;
    });
    gates.set(bot, { ready, enter, finish, result });
    await models.start(bot, { requestId: request, prompt: '处理合成请求' });
    await ready;
    return models.jobs.get(bot)!;
  };
  const update = (bot: string, revision: number, text: string, sessionId = 'mock-stream-session') =>
    models.rpc(bot, `Bearer ${models.jobs.get(bot)!.token}`, {
      id: revision,
      method: 'response.update',
      params: { sessionId, revision, text, state: 'streaming' },
    });
  const finish = async (bot: string, text: string) => {
    gates.get(bot)!.finish({ sessionId: 'mock-stream-session', finalResponse: text });
    await models.jobs.get(bot)!.done;
  };
  return {
    root,
    key,
    options,
    models,
    start,
    update,
    finish,
    gates,
    close: async () => {
      await models.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('response snapshots commit before publication, reject stale/foreign data and never cross Bot capabilities', async () => {
  const f = await fixture();
  try {
    const a = await f.start('mock-a');
    await f.start('mock-b');
    await f.update('mock-a', 1, '合成回答甲');
    assert.equal(f.models.status().bots['mock-a'].response?.text, '合成回答甲');
    // Every accepted stream is attributed to the turn that produced it, not inferred by the renderer.
    assert.equal(f.models.status().bots['mock-a'].response?.turnId, 'mock-request-mock-a');
    assert.equal(
      f.models.journal.findRequest('mock-a', 'mock-request-mock-a')?.response?.text,
      '合成回答甲',
    );
    assert.equal(
      f.models.journal.findRequest('mock-a', 'mock-request-mock-a')?.response?.turnId,
      'mock-request-mock-a',
    );
    await f.update('mock-a', 3, '合成最新回答');
    await f.update('mock-a', 2, '过期内容');
    assert.equal(f.models.status().bots['mock-a'].response?.revision, 3);
    await assert.rejects(f.update('mock-a', 4, 'foreign', 'other-session'), {
      code: 'INVALID_RESPONSE',
    });
    await assert.rejects(
      f.models.rpc('mock-b', `Bearer ${a.token}`, {
        id: 1,
        method: 'response.update',
        params: {
          sessionId: 'mock-stream-session',
          revision: 1,
          text: 'wrong',
          state: 'streaming',
        },
      }),
      { code: 'UNAUTHORIZED' },
    );
    assert.equal(f.models.status().bots['mock-b'].response, undefined);
  } finally {
    await f.close();
  }
});

test('an old turn snapshot cannot be relabelled or replace the current turn while queued for persistence', async () => {
  const f = await fixture();
  try {
    const job = await f.start('mock-a');
    assert.deepEqual(JSON.parse(await readFile(path.join(job.privateDir, 'turn.json'), 'utf8')), {
      id: job.requestId,
    });
    job.turns![0].result = 'SYNTHETIC ORIGINAL ANSWER';
    job.turns!.push({ id: 'mock-second-turn', prompt: 'SYNTHETIC SECOND REQUEST', result: '' });
    const update = (revision: number, turnId: string, text: string) =>
      f.models.rpc('mock-a', `Bearer ${job.token}`, {
        id: revision,
        method: 'response.update',
        params: { sessionId: job.sessionId, revision, turnId, text, state: 'settled' },
      });
    const stale = await update(1, job.requestId, 'SYNTHETIC OLD ANSWER');
    assert.ok(stale);
    assert.equal((stale.result as { accepted: boolean }).accepted, false);
    assert.equal(job.response, undefined);
    await update(2, 'mock-second-turn', 'SYNTHETIC SECOND PREFIX');
    await update(3, job.requestId, 'SYNTHETIC DELAYED OLD ANSWER');
    const response = f.models.status().bots['mock-a'].response;
    assert.equal(response?.text, 'SYNTHETIC SECOND PREFIX');
    assert.equal(response?.turnId, 'mock-second-turn');
    let release!: () => unknown;
    job.writing = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const queued = update(4, 'mock-second-turn', 'SYNTHETIC QUEUED SECOND PREFIX');
    job.turns!.push({ id: 'mock-third-turn', prompt: 'SYNTHETIC THIRD REQUEST', result: '' });
    release();
    const dropped = await queued;
    assert.ok(dropped);
    assert.equal((dropped.result as { accepted: boolean }).accepted, false);
    assert.equal(f.models.status().bots['mock-a'].response?.text, 'SYNTHETIC SECOND PREFIX');
  } finally {
    await f.close();
  }
});
test('streamed credential prefixes stay private, and concurrent plan persistence retains newer output', async () => {
  const f = await fixture();
  try {
    await f.start('mock-a');
    await f.update('mock-a', 1, `答复：${f.key.slice(0, 16)}`);
    assert.equal(f.models.status().bots['mock-a'].response?.text, '答复：');
    const output = f.update('mock-a', 2, '合成新内容');
    f.gates.get('mock-a')!.observe!({
      method: 'session.event',
      params: {
        sessionId: 'mock-stream-session',
        event: {
          type: 'todo/write',
          data: { todos: [{ content: '合成步骤', status: 'in_progress' }] },
        },
      },
    });
    await output;
    await f.models.journal.writing;
    assert.equal(
      f.models.journal.findRequest('mock-a', 'mock-request-mock-a')?.response?.text,
      '合成新内容',
    );
    await f.models.stop('mock-a');
    const restored = new ModelRuns(f.options);
    await restored.ready;
    assert.equal(restored.status().bots['mock-a'].response?.text, '合成新内容');
    assert.equal(restored.status().bots['mock-a'].phase, 'stopped');
    await restored.close();
  } finally {
    await f.close();
  }
});
test('completed answers are not silently truncated at the old preview limit', async () => {
  const f = await fixture();
  try {
    const job = await f.start('mock-a');
    const text = 'synthetic response. '.repeat(1000);
    await f.finish('mock-a', text);
    assert.equal(f.models.status().bots['mock-a'].result, text);
    const saved = JSON.parse(await readFile(path.join(job.privateDir, 'result.json'), 'utf8'));
    assert.equal(saved.result, text);
  } finally {
    await f.close();
  }
});
test('an in-flight disk write is not exposed through history before the current response commits', async () => {
  const f = await fixture();
  try {
    await f.start('mock-a');
    const update = f.update('mock-a', 1, '合成尚未落盘的增量片段');
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    const visibleBeforeCommit = JSON.stringify(f.models.status()).includes(
      '合成尚未落盘的增量片段',
    );
    await update;
    assert.equal(visibleBeforeCommit, false);
    assert.equal(f.models.status().bots['mock-a'].response?.text, '合成尚未落盘的增量片段');
  } finally {
    await f.close();
  }
});
test('an oversized final answer is an explicit incomplete failure rather than a silently shortened success', async () => {
  const f = await fixture();
  try {
    await f.start('mock-a');
    await f.update('mock-a', 1, '合成已提交的前缀');
    await f.finish('mock-a', 'x'.repeat(65537));
    const result = f.models.status().bots['mock-a'];
    assert.equal(result.phase, 'failed');
    assert.equal(result.result, '');
    assert.equal(result.response?.text, '合成已提交的前缀');
    assert.match(result.error || '', /长度限制/);
  } finally {
    await f.close();
  }
});
