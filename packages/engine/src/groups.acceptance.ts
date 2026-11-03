import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model acceptance: only synthetic tasks; the live key stays inside Linux memory.
export async function acceptGroups(output = '/tmp/daban-groups-evidence.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-groups-acceptance-'));
  const settings = new ModelSettings('/var/lib/bot-prototype/model/credentials.json');
  const before = await stat(settings.file);
  let models: ModelRuns | undefined;
  let groups: Groups | undefined;
  const server = createServer(async (request, response) => {
    try {
      const bot = request.url?.match(/^\/mcp\/(mock-alpha|mock-beta)$/)?.[1];
      assert.ok(models && bot && request.method === 'POST');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 512 * 1024);
        chunks.push(Buffer.from(chunk));
      }
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
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    models = new ModelRuns({
      settings,
      workspace,
      dir: path.join(root, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    });
    await models.ready;
    for (const id of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id,
        name: id,
        instructions: `你是 ${id}。严格完成属于自己的子任务，简洁回复。`,
        memory: '',
        color: 'mint',
      });
    groups = new Groups(
      path.join(root, 'groups.sqlite'),
      {
        member: (id) => models!.profiles.get(id),
        directory: () => models!.profiles.list(),
        source: (bot, runId, group) => models!.groupSource(bot, runId, group),
        running: (id) => models!.running(id),
        findRequest: (bot, id) => models!.findRequest(bot, id),
        start: (bot, task, scope) => models!.start(bot, task, scope),
        stopRequest: (bot, id, scope) => models!.stopRequest(bot, id, scope),
      },
      models.attachments,
    );
    await groups.ready;
    models.tools.groups = new GroupTools(groups);
    models.attachmentPinned = (owner, id) => groups!.inputBusy(owner, id);
    const dmPrompt =
      '这是一条合成私聊。记住这条私聊代号 DM-ONLY-739，只回复 DM-ONLY-739，不调用工具。';
    await models.start('mock-alpha', { requestId: 'mock-private-before', prompt: dmPrompt });
    await models.jobs.get('mock-alpha')!.done;
    const privateBefore = models.status().bots['mock-alpha'];
    assert.equal(privateBefore.phase, 'completed', privateBefore.error || 'Private task failed');
    assert.match(privateBefore.result || '', /DM-ONLY-739/);
    await groups.register({
      id: 'mock-live-group',
      name: '合成双成员验收',
      members: ['mock-alpha', 'mock-beta'],
    });
    const prompt =
      '执行一轮双成员合成验收。mock-alpha：首先必须调用 ask_user_question 提问“合成验收格式？”，选项 Markdown 和纯文本，等待实际回答；然后用 read_file 读取 input.csv，将 amount 求和，用 write_file 生成 alpha.txt，内容为 GROUP-SUM=18；然后必须调用 group_handoff 转交给 mock-beta，交接消息包含 alpha.txt 在 /shared 下的准确路径，之后结束本阶段。mock-beta：必须先调用 group_history 读取交接消息，再用 read_file 核对 alpha.txt 的值，用 write_file 生成 beta.md，内容为 GROUP-VERIFIED=18；最后回复 GROUP-DONE-18。mock-beta 不再交接。每个成员只做自己这一段，无须电脑、网页或私聊历史。';
    const input = {
      id: 'mock-live-send',
      group: 'mock-live-group',
      prompt,
      recipients: ['mock-alpha'],
      files: [{ name: 'input.csv', content: 'item,amount\nMOCK-A,7\nMOCK-B,11\n' }],
    };
    await groups.send(input);
    const deadline = Date.now() + 240000;
    let page = await groups.read(input.group);
    let scopedWaitVerified = false;
    while (Date.now() < deadline) {
      await groups.tick();
      for (const request of await models.interactions.list()) {
        if (
          request.conversationId !== input.group ||
          request.status !== 'pending' ||
          request.kind !== 'question'
        )
          continue;
        assert.equal(models.status().bots[request.bot].phase, 'waiting');
        assert.equal(request.questions[0].question, '合成验收格式？');
        scopedWaitVerified = true;
        await models.interactions.reply(request.bot, request.runId, request.id, {
          kind: 'answer',
          answers: request.questions.map((question) => ({
            id: question.id,
            selected: ['Markdown'],
            custom: '',
          })),
        });
      }
      page = await groups.read(input.group);
      if (
        page.deliveries.length &&
        page.deliveries.every((item) =>
          ['completed', 'failed', 'interrupted', 'cancelled'].includes(item.state),
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.deepEqual(
      page.deliveries.map((item) => [item.bot, item.state]),
      [
        ['mock-alpha', 'completed'],
        ['mock-beta', 'completed'],
      ],
      JSON.stringify(page.deliveries),
    );
    assert.equal(scopedWaitVerified, true);
    const alpha = models.status().bots['mock-alpha'],
      beta = models.status().bots['mock-beta'];
    assert.notEqual(alpha.sessionId, privateBefore.sessionId);
    for (const [turn, names] of [
      [alpha, ['read_file', 'write_file', 'group_handoff']],
      [beta, ['group_history', 'read_file', 'write_file']],
    ] as const) {
      assert.equal(turn.conversationId, input.group);
      for (const name of names)
        assert.ok(
          turn.trace?.some((item) => item.name === name && item.phase === 'settled'),
          `Missing ${name}`,
        );
      assert.ok(
        turn.trace?.every((item) => item.surface !== 'desktop' && item.surface !== 'browser'),
      );
    }
    const alphaFile = alpha.files.find((file) => file.name === 'alpha.txt'),
      betaFile = beta.files.find((file) => file.name === 'beta.md');
    assert.ok(alphaFile && betaFile);
    assert.equal(
      (await readFile(path.join(workspace, alphaFile.path), 'utf8')).trim(),
      'GROUP-SUM=18',
    );
    assert.equal(
      (await readFile(path.join(workspace, betaFile.path), 'utf8')).trim(),
      'GROUP-VERIFIED=18',
    );
    assert.match(beta.result || '', /GROUP-DONE-18/);
    assert.ok(!JSON.stringify(page).includes('DM-ONLY-739'));
    const replay = await groups.send(input);
    assert.equal(replay.messages.length, page.messages.length);
    await models.start('mock-alpha', {
      requestId: 'mock-private-after',
      prompt: '只回复刚才这条私聊的代号，不调用工具。',
    });
    await models.jobs.get('mock-alpha')!.done;
    const privateAfter = models.status().bots['mock-alpha'];
    assert.equal(
      privateAfter.phase,
      'completed',
      privateAfter.error || 'Private continuation failed',
    );
    assert.equal(privateAfter.sessionId, privateBefore.sessionId);
    assert.match(privateAfter.result || '', /DM-ONLY-739/);
    const after = await stat(settings.file);
    assert.deepEqual(
      [before.ino, before.size, before.mtimeMs, before.mode],
      [after.ino, after.size, after.mtimeMs, after.mode],
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          passed: true,
          credentialWritten: false,
          credentialMetadataUnchanged: true,
          scopedWaitVerified,
          separateDMSession: true,
          dmResumed: true,
          group: page,
          traces: { alpha: alpha.trace, beta: beta.trace },
          files: [alphaFile, betaFile],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return {
      passed: true,
      stages: page.deliveries.length,
      files: 2,
      scopedWaitVerified,
      separateDMSession: true,
      credentialWritten: false,
    };
  } finally {
    await groups?.close();
    await models?.close();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  acceptGroups(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
