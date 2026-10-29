import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPrototype } from './server.js';

export async function acceptManaged(output: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-managed-model-'));
  const key = '/var/lib/bot-prototype/model/credentials.json',
    before = await stat(key);
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await symlink(key, path.join(root, 'model/credentials.json'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: { dir: path.join(root, 'desktops'), displayBase: 81, limit: 2 },
  });
  const turns: {
    bot: string;
    model?: string;
    session?: string;
    tools: string[];
    result: string;
  }[] = [];
  try {
    assert.ok(app.models);
    const models = app.models,
      computers = app.runtime;
    for (const [id, model] of [
      ['mock-managed-a', 'deepseek-flash'],
      ['mock-managed-b', 'deepseek-v4-pro'],
    ] as const)
      await models.profiles.register({
        id,
        model,
        name: `合成 ${id}`,
        instructions: '',
        memory: 'SYNTHETIC-MEMORY-19',
        color: 'mint',
      });
    async function turn(bot: string, requestId: string, prompt: string) {
      await models.start(bot, { requestId, prompt });
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
      return result;
    }
    assert.equal(computers.status().items.length, 0);
    const hello = await turn(
      'mock-managed-a',
      'mock-19-before',
      '普通问候验收：只回复 MANAGED-HELLO-19，不使用任何工具。',
    );
    assert.equal(hello.tools.length, 0);
    const [a, b] = await Promise.all([
      computers.operate({
        id: 'mock-19-connect-a',
        bot: 'mock-managed-a',
        action: 'connect',
        revision: 0,
      }),
      computers.operate({
        id: 'mock-19-connect-b',
        bot: 'mock-managed-b',
        action: 'connect',
        revision: 0,
      }),
    ]);
    assert.equal(a.state.phase, 'connected');
    assert.equal(b.state.phase, 'connected');
    assert.notEqual(a.state.instance, b.state.instance);
    const browser = computers.browserFor('mock-managed-a');
    for (const bot of ['mock-managed-a', 'mock-managed-b'])
      await browser.tabs!.navigate(
        bot,
        'agent',
        computers.control.state(bot).epoch,
        `${app.url}/fixture/page?bot=${bot}`,
        new AbortController().signal,
        'mock-19-login-setup',
      );
    await browser.act(
      'mock-managed-a',
      'agent',
      computers.control.state('mock-managed-a').epoch,
      (page) => page.locator('#login').click(),
    );
    await browser
      .page('mock-managed-b')
      .waitForFunction(() => document.querySelector('#identity')?.textContent === '示例用户');
    await browser.page('mock-managed-b').locator('#note').fill('MANAGED-B-INDEPENDENT-19');
    const [native, other] = await Promise.all([
      turn(
        'mock-managed-a',
        'mock-19-native',
        '这是授权的合成 Linux 桌面验收，只通过图形桌面完成，不用文件、shell、浏览器或联网工具。先 screenshot(surface=desktop)，再 open_app(app=terminal)，用 act(surface=desktop) 发送 ctrl+c、ctrl+u，输入 printf MANAGED-MODEL-19 > managed-model-a.txt 并发送 Return。用截图确认执行后简短回复。只写这个新合成文件，勿操作其他文件。',
      ),
      turn(
        'mock-managed-b',
        'mock-19-other',
        '普通问候验收：只回复 MANAGED-B-19，不使用任何工具。',
      ),
    ]);
    assert.equal(native.session, hello.session);
    assert.ok(
      native.tools.includes('screenshot') &&
        native.tools.includes('open_app') &&
        native.tools.includes('act'),
    );
    assert.ok(native.tools.every((tool) => ['screenshot', 'open_app', 'act'].includes(tool)));
    assert.equal(other.tools.length, 0);
    const file = path.join(root, 'desktops/shared/managed-model-a.txt');
    assert.equal((await readFile(file, 'utf8')).trim(), 'MANAGED-MODEL-19');
    await writeFile(
      path.join(path.dirname(output), 'managed-model-a.jpg'),
      await computers.frame(
        'mock-managed-a',
        a.state.instance,
        computers.control.state('mock-managed-a').epoch,
      ),
      { mode: 0o600 },
    );
    const stopped = await computers.operate({
      id: 'mock-19-stop-a',
      bot: 'mock-managed-a',
      action: 'stop',
      revision: a.state.revision,
      instance: a.state.instance,
      confirmation: 'close-apps',
    });
    assert.equal(stopped.state.phase, 'disconnected');
    assert.equal(models.tools.hasComputer('mock-managed-a', 'deepseek-flash'), false);
    assert.equal(
      await browser.page('mock-managed-b').locator('#note').inputValue(),
      'MANAGED-B-INDEPENDENT-19',
    );
    const afterStop = await turn(
      'mock-managed-a',
      'mock-19-after-stop',
      '电脑已停止。新的普通问候验收：只回复 MANAGED-STOPPED-19，不使用工具，不继续先前的桌面任务。',
    );
    assert.equal(afterStop.tools.length, 0);
    assert.equal(afterStop.session, hello.session);
    const reconnect = await computers.operate({
      id: 'mock-19-reconnect-a',
      bot: 'mock-managed-a',
      action: 'connect',
      revision: stopped.state.revision,
    });
    assert.notEqual(reconnect.state.instance, a.state.instance);
    const observed = await turn(
      'mock-managed-a',
      'mock-19-reconnected',
      '电脑已经重新连接。只调用 screenshot(surface=desktop) 观察你当前的新屏幕，不做任何输入、不打开应用。然后回复 MANAGED-RECONNECTED-19。',
    );
    assert.equal(observed.session, hello.session);
    assert.ok(observed.tools.length >= 1 && observed.tools.every((tool) => tool === 'screenshot'));
    assert.equal((await readFile(file, 'utf8')).trim(), 'MANAGED-MODEL-19');
    assert.equal((await models.profiles.get('mock-managed-a'))?.memory, 'SYNTHETIC-MEMORY-19');
    assert.equal(
      (await computers.browserFor('mock-managed-a').context.cookies()).find(
        (cookie) => cookie.name === 'demo_session',
      )?.httpOnly,
      true,
    );
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
          syntheticOnly: true,
          protocol: 19,
          turns,
          noGraphicsInitially: true,
          newlyRegisteredLogicalBots: true,
          independentNativeInstances: true,
          sharedLogin: true,
          separateStopAndReconnect: true,
          sessionPreservedBeforeAndAfterAttachment: true,
          memoryAndFilePreserved: true,
          otherBotUnchanged: true,
          oldInstanceReplaced: true,
          credentialMetadataUnchanged: true,
          originalUserServiceChanged: false,
          screenshot: 'managed-model-a.jpg',
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
  await acceptManaged(process.argv[2]);
}
