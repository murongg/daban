import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Desktop } from './desktop.js';
import type { Prototype } from './server.js';
import { startPrototype } from './server.js';

export async function acceptNative(output: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-native-model-'));
  const credential = '/var/lib/bot-prototype/model/credentials.json',
    before = await stat(credential);
  let app: Prototype<Desktop> | undefined;
  const options = {
    profileDir: path.join(root, 'profile'),
    port: 0,
    fixture: true,
    desktop: { dir: path.join(root, 'desktops'), displayBase: 43 },
  };
  const turns: {
    bot: string;
    session?: string;
    model?: string;
    tools: string[];
    result: string;
  }[] = [];
  try {
    await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
    await symlink(credential, path.join(root, 'model/credentials.json'));
    app = await startPrototype(options);
    const firstInstance = app.runtime.screens.instance('a');
    assert.notEqual(firstInstance, app.runtime.screens.instance('b'));
    await app.runtime.browser.act('a', 'agent', 0, (page) => page.locator('#login').click());
    await app.runtime
      .page('b')
      .waitForFunction(() => document.querySelector('#identity')?.textContent === '示例用户');
    assert.ok(app.models);
    for (const [id, model] of [
      ['a', 'deepseek-flash'],
      ['b', 'deepseek-v4-pro'],
    ] as const)
      await app.models.profiles.register({
        id,
        model,
        name: `合成原生 ${id}`,
        instructions: '',
        memory: '',
        color: 'mint',
      });
    async function turn(bot: string, requestId: string, prompt: string) {
      assert.ok(app?.models);
      await app.models.start(bot, { requestId, prompt });
      const job = app.models.jobs.get(bot)!;
      await job.done;
      assert.equal(job.phase, 'completed', job.error);
      const result = {
        bot,
        session: job.sessionId,
        model: job.model,
        tools: job.trace.map((item) => item.name),
        result: job.result,
      };
      turns.push(result);
      return result;
    }
    const [native, other] = await Promise.all([
      turn(
        'a',
        'mock-native-18-gui',
        '这是授权的合成 Linux 桌面验收，只通过图形桌面完成，不使用文件、shell、浏览器或联网工具。先 screenshot(surface=desktop)，再 open_app(app=terminal) 聚焦终端，用 act(surface=desktop) 发送 ctrl+c、ctrl+u，再输入 printf NATIVE-MODEL-18 > native-model-a.txt 并发送 Return。用截图确认命令执行后简短回复。只写这个新合成文件，勿操作其他文件。',
      ),
      turn(
        'b',
        'mock-native-18-other',
        '这是另一位 Bot 的普通问候验收：只回复 NATIVE-B-18，不使用任何工具。',
      ),
    ]);
    assert.ok(
      native.tools.includes('screenshot') &&
        native.tools.includes('open_app') &&
        native.tools.includes('act'),
    );
    assert.ok(native.tools.every((tool) => ['screenshot', 'open_app', 'act'].includes(tool)));
    assert.equal(other.tools.length, 0);
    const file = path.join(root, 'desktops/shared/native-model-a.txt');
    assert.equal((await readFile(file, 'utf8')).trim(), 'NATIVE-MODEL-18');
    const screenPath = path.join(path.dirname(output), 'native-model-a.jpg');
    await writeFile(
      screenPath,
      await app.runtime.frame('a', firstInstance, app.runtime.control.state('a').epoch),
      { mode: 0o600 },
    );
    await app.close();
    app = await startPrototype(options);
    const secondInstance = app.runtime.screens.instance('a');
    assert.notEqual(secondInstance, firstInstance);
    assert.equal((await readFile(file, 'utf8')).trim(), 'NATIVE-MODEL-18');
    assert.equal((await app.runtime.snapshot()).sharedLogin, true);
    const greeting = await turn(
      'a',
      'mock-native-18-after-restart',
      '新的普通问候验收：只回复 NATIVE-RESTART-18，不使用工具，不继续先前的桌面任务。',
    );
    assert.equal(greeting.session, native.session);
    assert.equal(greeting.tools.length, 0);
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
          protocol: 18,
          turns,
          independentInstances: true,
          screenInstanceChangedOnRestart: true,
          sameDshSessionAfterRestart: true,
          nativeFileVerifiedAndPreserved: true,
          sharedLoginPreserved: true,
          screenshot: path.basename(screenPath),
          credentialMetadataUnchanged: true,
          originalUserServiceChanged: false,
        },
        null,
        2,
      ),
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
  await acceptNative(process.argv[2]);
}
