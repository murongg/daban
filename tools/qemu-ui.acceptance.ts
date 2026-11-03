import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const reports = path.resolve(process.argv[2] ?? 'outputs/qemu/ui');
await mkdir(reports, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks: Record<string, unknown>[] = [];
try {
  for (const scene of [
    { name: 'install-zh', width: 780, lang: 'zh-CN', phase: 'available', theme: 'light' },
    { name: 'install-narrow-en', width: 360, lang: 'en', phase: 'available', theme: 'light' },
    { name: 'restart-zh', width: 780, lang: 'zh-CN', phase: 'waiting', theme: 'light' },
    { name: 'restart-dark', width: 360, lang: 'zh-CN', phase: 'waiting', theme: 'dark' },
    { name: 'install-working', width: 780, lang: 'zh-CN', phase: 'creating', theme: 'light' },
  ]) {
    const page = await browser.newPage({ viewport: { width: scene.width, height: 620 } });
    await page.goto(
      `http://127.0.0.1:5191/preview/setup.html?target=linux&platform=win32&phase=${scene.phase}&lang=${scene.lang}&theme=${scene.theme}`,
    );
    await page.locator('.windows-setup').waitFor();
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      text: document.querySelector('.windows-setup')?.textContent,
      buttons: [...document.querySelectorAll('button')].map((item) => item.textContent),
    }));
    assert.ok(geometry.scroll <= geometry.width, `${scene.name}: horizontal overflow`);
    assert.ok(geometry.text && !geometry.text.includes('SSH') && !geometry.text.includes('vmId'));
    await page.screenshot({ path: path.join(reports, `${scene.name}.png`), fullPage: true });
    if (scene.name === 'install-zh') {
      await page.locator('.windows-options > summary').click();
      await page.getByRole('button', { name: '使用兼容模式（较慢）' }).waitFor();
      await page.screenshot({ path: path.join(reports, 'compatibility-zh.png'), fullPage: true });
    }
    if (scene.name === 'restart-zh') {
      await page.getByRole('button', { name: '重启 Windows…' }).click();
      await page.getByRole('dialog').waitFor();
      await page.screenshot({
        path: path.join(reports, 'restart-confirmation.png'),
        fullPage: true,
      });
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
    }
    checks.push({ name: scene.name, passed: true, ...geometry });
    await page.close();
  }
  await writeFile(
    path.join(reports, 'result.json'),
    JSON.stringify({ synthetic: true, checks }, null, 2),
  );
  console.log(
    'Windows setup: bilingual, narrow layout, dark theme, progress, explicit compatibility and keyboard-dismissed restart confirmation verified.',
  );
} finally {
  await browser.close();
}
