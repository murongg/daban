import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPrototype } from './server.js';

export async function acceptHeadless(output: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-headless-'));
  const credential = '/var/lib/bot-prototype/model/credentials.json',
    before = await stat(credential);
  let app: Awaited<ReturnType<typeof startPrototype>> | undefined;
  try {
    await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
    // Read the existing guest-only key through its path; never duplicate or rewrite the credential.
    await symlink(credential, path.join(root, 'model/credentials.json'));
    // A real private-display IO failure occurs before Xvfb/Chromium can start, while shared files remain valid.
    await mkdir(path.join(root, 'desktops/a/Xauthority'), { recursive: true, mode: 0o700 });
    app = await startPrototype({ profileDir: path.join(root, 'profile'), port: 0, desktop: true });
    assert.throws(() => app!.runtime, { code: 'COMPUTER_NOT_CONNECTED' });
    assert.ok(app.models);
    const models = app.models;
    const call = async (route: string, data?: unknown) => {
      const response = await fetch(`${app!.url}${route}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          'x-prototype-token': app!.token,
          ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const state = await call('/api/state');
    assert.equal(state.clientProtocol, 18);
    assert.equal(state.mode, 'agent');
    assert.equal(state.model.configured, true);
    assert.equal(state.model.available, true);
    assert.equal(state.knowledge.available, true);
    assert.equal(state.groups.available, true);
    assert.equal(state.schedules.available, true);
    assert.deepEqual(state.bots, {});
    for (const id of ['mock-headless-a', 'mock-headless-b']) {
      await call('/api/bots', {
        id,
        name: `合成 ${id}`,
        instructions: '',
        memory: '',
        color: 'mint',
        model: 'deepseek-v4-pro',
      });
      const available = models.tools.list(id).map((tool) => tool.name);
      for (const tool of ['screenshot', 'act', 'open_app', 'browser_navigate'])
        assert.ok(!available.includes(tool));
    }
    const turns: {
      bot: string;
      model?: string;
      session?: string;
      tools: string[];
      result: string;
    }[] = [];
    async function turn(
      bot: string,
      requestId: string,
      prompt: string,
      files?: { name: string; content: string }[],
    ) {
      await call(`/api/bots/${bot}/model`, {
        running: true,
        task: { requestId, prompt, ...(files ? { files } : {}) },
      });
      const job = models.jobs.get(bot)!;
      await job.done;
      assert.equal(job.phase, 'completed', job.error);
      const result = {
        bot,
        model: job.model,
        session: job.sessionId,
        tools: job.trace.map((item) => item.name),
        result: job.result,
      };
      turns.push(result);
      assert.ok(
        !result.tools.some(
          (tool) => ['screenshot', 'act', 'open_app'].includes(tool) || tool.startsWith('browser_'),
        ),
      );
      return { result, job };
    }
    const first = await turn(
      'mock-headless-a',
      'mock-headless-greeting-a',
      '普通问候验收：只回复 HEADLESS-HELLO-47，不使用任何工具。',
    );
    assert.equal(first.result.tools.length, 0);
    const [computed, other] = await Promise.all([
      turn(
        'mock-headless-a',
        'mock-headless-files-a',
        '用户授权的合成文件任务：使用 read_file 读取 input.csv，把记录数量与 amount 合计写入 headless-report.md，正文严格为 COUNT=2 TOTAL=18。先实际读取文件，再用 write_file 保存并重新读取核对。不操作电脑或浏览器。最后简短说明已保存。',
        [{ name: 'input.csv', content: 'item,amount\nMOCK-A,7\nMOCK-B,11\n' }],
      ),
      turn(
        'mock-headless-b',
        'mock-headless-greeting-b',
        '独立普通对话验收：只回复 HEADLESS-B-47，不使用任何工具。',
      ),
    ]);
    assert.equal(other.result.tools.length, 0);
    assert.equal(computed.result.session, first.result.session);
    assert.notEqual(other.result.session, first.result.session);
    assert.ok(computed.result.tools.includes('read_file'));
    assert.ok(computed.result.tools.includes('write_file'));
    assert.equal(
      (await readFile(path.join(computed.job.workdir, 'headless-report.md'), 'utf8')).trim(),
      'COUNT=2 TOTAL=18',
    );
    const listed = await call('/api/files');
    assert.ok(listed.some((file: { name: string }) => file.name === 'headless-report.md'));
    const after = await stat(credential);
    assert.deepEqual(
      [after.ino, after.size, after.mtimeMs, after.mode],
      [before.ino, before.size, before.mtimeMs, before.mode],
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          syntheticOnly: true,
          verified: true,
          failure: 'Real EISDIR before graphical processes start',
          protocol: 18,
          ordinaryServicesReady: true,
          sharedWorkspaceVisible: true,
          computerCapabilitiesAbsent: true,
          actualDshTurns: turns,
          sameDshSessionContinued: true,
          independentSecondBot: true,
          report: 'COUNT=2 TOTAL=18',
          credentialMetadataUnchanged: true,
          originalUserServiceChanged: false,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Evidence output path required');
  await acceptHeadless(process.argv[2]);
}
