import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPrototype } from './server.js';

export async function previewBrowser() {
  assert.equal(process.platform, 'linux');
  const dir = await mkdtemp(path.join(tmpdir(), 'daban-browser-preview-'));
  const app = await startPrototype({
    profileDir: path.join(dir, 'profile'),
    port: 18768,
    desktop: { dir: path.join(dir, 'desktops'), displayBase: 51 },
  });
  assert.equal((await app.runtime.snapshot()).mode, 'desktop');
  await app.runtime.context.route('**/fixture/human', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>合成浏览器验收</title><style>body{font:18px system-ui;padding:40px;color:#252523}button,input{font:inherit;padding:10px;margin:10px 10px 10px 0}h1{font-size:30px}</style></head><body><h1>合成浏览器工作台</h1><p>本页仅用于验证独立操作、弹窗和文件选择。</p><button onclick="window.answer=prompt('填写合成任务名称','测试任务');document.querySelector('#result').textContent=window.answer===null?'已取消':'已收到回复'">打开网页提问</button><input type="file" id="file" style="display:none" onchange="document.querySelector('#result').textContent=this.files[0]?.name||'未选择文件'"><button onclick="document.querySelector('#file').click()">选择合成文件</button><p><input aria-label="合成备注" placeholder="输入本页备注"></p><output id="result">等待操作</output></body></html>`,
    }),
  );
  await writeFile(
    '/tmp/daban-browser-client-preview.json',
    JSON.stringify({ dir, origin: app.url, pid: process.pid }),
    { mode: 0o600 },
  );
  console.log('BROWSER_CLIENT_PREVIEW_READY');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    close().catch(() => process.exit(1));
  });
  process.once('SIGTERM', () => {
    close().catch(() => process.exit(1));
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await previewBrowser();
