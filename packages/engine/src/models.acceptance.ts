import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type DeepSeekModel, isDeepSeekModel } from '@daban/protocol';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model check. The saved credential is read in Linux memory and is never copied or replaced.
export async function acceptModels(output = '/tmp/daban-models-evidence.json') {
  assert.equal(process.platform, 'linux');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-models-acceptance-'));
  class SelectedSettings extends ModelSettings {
    selected: DeepSeekModel = 'deepseek-flash';
    override async privateConfig() {
      const config = await super.privateConfig();
      return config ? { ...config, model: this.selected } : null;
    }
  }
  const settings = new SelectedSettings('/var/lib/bot-prototype/model/credentials.json');
  const credentialBefore = await stat(settings.file);
  let models: ModelRuns | undefined;
  const server = createServer(async (request, response) => {
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) throw new Error('request too large');
        chunks.push(Buffer.from(chunk));
      }
      assert.ok(models);
      const bot = new URL(request.url || '/', 'http://localhost').pathname.match(
        /^\/mcp\/(probe|probe-a|probe-b)$/,
      )?.[1];
      assert.ok(bot);
      const result = await models.rpc(
        bot,
        request.headers.authorization,
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      response.writeHead(result === null ? 202 : 200, { 'content-type': 'application/json' });
      response.end(result === null ? undefined : JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end('{}');
    }
  });
  try {
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const options = {
      settings,
      workspace,
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    };
    models = new ModelRuns(options);
    await models.ready;
    await models.profiles.register({
      id: 'probe',
      name: '合成模型验证',
      instructions: '简洁回答。只处理当前合成验收。',
      memory: '',
      color: 'mint',
    });
    const turns: {
      model: DeepSeekModel;
      bot: string;
      sessionId?: string;
      result?: string;
      toolCount: number;
    }[] = [];
    function completed(bot: string, expected: string, tools = 0) {
      assert.ok(models);
      const state = models.status().bots[bot];
      assert.equal(state.phase, 'completed', state.error || 'Model task failed');
      assert.equal(state.result?.trim(), expected);
      assert.equal(state.toolCount, tools);
      assert.equal(state.files.length, 0);
      assert.ok(isDeepSeekModel(state.model));
      turns.push({
        bot,
        model: state.model,
        sessionId: state.sessionId,
        result: state.result,
        toolCount: state.toolCount,
      });
      return state.sessionId;
    }
    async function turn(requestId: string, prompt: string, bot = 'probe', expected = 'MODEL-47') {
      assert.ok(models);
      await models.start(bot, { requestId, prompt });
      await models.jobs.get(bot)!.done;
      return completed(bot, expected);
    }
    const checks = [await settings.check((await settings.status()).revision)];
    const first = await turn(
      'model-flash-first',
      '这是合成模型验收，合成标记为 MODEL-47。只回复这个标记，不使用工具。',
    );
    const second = await turn(
      'model-flash-second',
      '前一条的合成标记是什么？只回复标记，不使用工具。',
    );
    assert.equal(second, first);
    settings.selected = 'deepseek-v4-pro';
    checks.push(await settings.check((await settings.status()).revision));
    const third = await turn(
      'model-pro-first',
      '请从此前的合成上下文读取标记，只回复标记，不使用工具。',
    );
    assert.notEqual(third, second);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const fourth = await turn(
      'model-pro-restart',
      '继续读取已知合成标记，只回复标记，不使用工具。',
    );
    assert.equal(fourth, third);
    settings.selected = 'deepseek-flash';
    await models.profiles.register({
      id: 'probe-a',
      name: '合成独立模型甲',
      instructions: '只处理当前合成验收，最终仅回复收到的标记。',
      memory: '',
      color: 'mint',
      model: 'deepseek-flash',
    });
    await models.profiles.register({
      id: 'probe-b',
      name: '合成独立模型乙',
      instructions: '只处理当前合成验收，最终仅回复收到的标记。',
      memory: '',
      color: 'violet',
      model: 'deepseek-v4-pro',
    });
    await Promise.all(
      ['probe-a', 'probe-b'].map((bot) =>
        models!.start(bot, {
          requestId: `parallel-${bot}`,
          prompt:
            '这是合成并发验收。必须先用 ask_user_question 询问本轮标记，等待回答；收到后只原样回复回答中的标记，不调用其他工具。',
        }),
      ),
    );
    const deadline = Date.now() + 120000;
    for (;;) {
      const pending = (await models.interactions.list()).filter(
        (item) => ['probe-a', 'probe-b'].includes(item.bot) && item.status === 'pending',
      );
      if (pending.length === 2) break;
      assert.ok(
        Date.now() < deadline,
        'Both real model jobs must enter their independent question wait',
      );
      assert.ok(
        ['probe-a', 'probe-b'].every((bot) => models!.running(bot)),
        'A model stopped before its question was answered',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const captured = {
      a: models.status().bots['probe-a'].model,
      b: models.status().bots['probe-b'].model,
    };
    assert.equal(captured.a, 'deepseek-flash');
    assert.equal(captured.b, 'deepseek-v4-pro');
    await models.profiles.update('probe-b', 1, { model: 'deepseek-flash' });
    assert.equal(models.status().bots['probe-b'].model, 'deepseek-v4-pro');
    for (const item of (await models.interactions.list()).filter(
      (item) => ['probe-a', 'probe-b'].includes(item.bot) && item.status === 'pending',
    )) {
      assert.equal(item.kind, 'question');
      if (item.kind !== 'question') throw new Error('Unexpected approval');
      await models.interactions.reply(item.bot, item.runId, item.id, {
        kind: 'answer',
        answers: item.questions.map((question) => ({
          id: question.id,
          selected: [],
          custom: item.bot === 'probe-a' ? 'MODEL-A-47' : 'MODEL-B-53',
        })),
      });
    }
    await Promise.all(['probe-a', 'probe-b'].map((bot) => models!.jobs.get(bot)!.done));
    completed('probe-a', 'MODEL-A-47', 1);
    completed('probe-b', 'MODEL-B-53', 1);
    await turn('beta-next', '只回复 MODEL-NEXT-59，不用工具。', 'probe-b', 'MODEL-NEXT-59');
    assert.equal(turns.at(-1)!.model, 'deepseek-flash');
    settings.selected = 'deepseek-v4-pro';
    await models.profiles.update('probe-b', 2, { model: null });
    await turn(
      'beta-inherit',
      '只回复 MODEL-INHERIT-61，不用工具。',
      'probe-b',
      'MODEL-INHERIT-61',
    );
    assert.equal(turns.at(-1)!.model, 'deepseek-v4-pro');
    await turn('alpha-fixed', '只回复 MODEL-FIXED-67，不用工具。', 'probe-a', 'MODEL-FIXED-67');
    assert.equal(turns.at(-1)!.model, 'deepseek-flash');
    const credentialAfter = await stat(settings.file);
    assert.deepEqual(
      [credentialAfter.ino, credentialAfter.size, credentialAfter.mtimeMs, credentialAfter.mode],
      [
        credentialBefore.ino,
        credentialBefore.size,
        credentialBefore.mtimeMs,
        credentialBefore.mode,
      ],
    );
    const result = {
      verified: true,
      credentialWritten: false,
      computerAttached: false,
      checks,
      turns,
      parallelCaptured: captured,
      runningModelUnchangedAfterProfileEdit: true,
      credentialMetadataUnchanged: true,
    };
    await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } finally {
    await models?.close();
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptModels(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      turns: result.turns.length,
      credentialWritten: false,
    }),
  );
}
