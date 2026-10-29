import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { editorShowsFile, sdkPatch, verifyOutput, verifyTask } from './model.js';

test('DSH profile disables unscoped native tools and registers a scoped tool server', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'a', 'synthetic-capability');
  const compaction = patch.find((row) => 'id' in row && row.id === 'compaction-basic');
  assert.ok(compaction && 'config' in compaction);
  assert.equal((compaction.config as { retainTokens: number }).retainTokens, 4096);
  const disabled = patch.filter((row) => 'disabled' in row);
  for (const id of ['persistent-bash', 'persistent-pwsh', 'tool-fs', 'tool-working-directory'])
    assert.equal(disabled.find((row) => row.id === id)!.disabled, true);
  assert.equal(disabled.find((row) => row.id === 'llm-deepseek')!.disabled, true);
  const provider = patch
    .find((row) => 'insert' in row)!
    .insert.find((row) => row.id === 'desktop-model-provider')!;
  assert.ok('config' in provider && 'providers' in provider.config);
  assert.equal(provider.config.providers['deepseek-official'].api, 'openai-completions');
  assert.equal(
    provider.config.providers['deepseek-official'].baseURL,
    'https://api.deepseek.com/v1',
  );
  const entry = patch
    .find((row) => 'insert' in row)!
    .insert.find((row) => row.id === 'computer-tools')!;
  assert.ok('config' in entry && 'toolCallTimeoutMs' in entry.config && 'url' in entry.config);
  assert.ok(
    entry.config.toolCallTimeoutMs >= 60 * 60 * 1000,
    'human takeover must not inherit a short tool timeout',
  );
  assert.equal(entry.config.url, 'http://127.0.0.1:12345/mcp/a');
  assert.equal(provider.config.providers['deepseek-official'].apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(Object.hasOwn(provider.config.providers['deepseek-official'], 'apiKey'), false);
});

test('general DSH tasks enable the stock anonymous fetch provider and a shared tool budget', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'chief', 'synthetic-capability', {
    requestId: 'mock-web',
    prompt: '读取 https://example.test/',
  });
  const plugins = patch.find((row) => 'insert' in row)!.insert;
  assert.ok(plugins.some((row) => row.name === '@deepseek-ai/dsh-web'));
  assert.ok(plugins.some((row) => row.id === 'web-fetch-http' && row.name.endsWith('/web.js')));
  const web = plugins.find((row) => row.id === 'tool-web');
  assert.ok(web && 'config' in web);
  assert.deepEqual(web.config, {
    search: true,
    fetch: true,
    searchMaxResults: 5,
    searchMaxQueries: 4,
    searchTimeoutMs: 30000,
    fetchTimeoutMs: 30000,
    fetchMaxOutputChars: 50000,
  });
  const search = plugins.find((row) => row.id === 'web-deepseek-api');
  assert.ok(search && 'config' in search);
  assert.deepEqual(search.config, {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1/tools',
    count: 5,
    sendOriginalQuestion: false,
  });
  assert.ok(plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-call-timeout-policy'));
  const budget = plugins.find((row) => row.id === 'daban-budget');
  assert.ok(budget && 'config' in budget);
  assert.deepEqual(budget.config, {
    limit: 60,
    urls: ['https://example.test/'],
  });
  const diagnostic = sdkPatch('http://127.0.0.1:12345', 'a', 'synthetic-capability');
  assert.ok(diagnostic.find((row) => 'insert' in row)!.insert.some((row) => row.id === 'approval'));
  assert.equal(
    diagnostic.find((row) => 'insert' in row)!.insert.some((row) => row.id === 'tool-web'),
    false,
  );
});

test('task verification requires actual correct files and rejects symlink escapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-result-'));
  try {
    const file = path.join(dir, 'report-a.txt');
    await assert.rejects(verifyOutput('a', dir));
    await writeFile(file, 'paid_count=4\npaid_total=999\nshared_login=true\n');
    assert.equal((await verifyOutput('a', dir)).passed, false);
    await writeFile(file, 'paid_count=4\npaid_total=550\nshared_login=true\n');
    assert.equal((await verifyOutput('a', dir)).passed, true);
    const runtime = {
      screens: { windows: async (): Promise<{ class: string; title: string }[]> => [] },
    };
    assert.equal(
      (await verifyTask('a', dir, runtime)).passed,
      false,
      'a file alone does not prove the GUI task finished',
    );
    runtime.screens.windows = async () => [
      { class: 'mousepad.Mousepad', title: `${file} - Mousepad` },
    ];
    assert.equal((await verifyTask('a', dir, runtime)).passed, true);
    await rm(file);
    await symlink('/etc/hosts', file);
    await assert.rejects(verifyOutput('a', dir), { code: 'FILE_NOT_READABLE' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native editor title verification accepts home abbreviation for the same exact file', () => {
  const file = '/home/synthetic-user/tasks/run-123/report-a.txt';
  assert.equal(
    editorShowsFile(
      [{ class: 'mousepad.Mousepad', title: '~/tasks/run-123/report-a.txt - Mousepad' }],
      file,
      '/home/synthetic-user',
    ),
    true,
  );
  assert.equal(
    editorShowsFile(
      [{ class: 'mousepad.Mousepad', title: '~/tasks/other-run/report-a.txt - Mousepad' }],
      file,
      '/home/synthetic-user',
    ),
    false,
  );
});

test('report verification cannot return private bytes when a checked public file is replaced by a link', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-report-link-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report-a.txt'),
    secret = path.join(tmpdir(), `mock-private-report-${path.basename(root)}.txt`);
  t.after(() => rm(secret, { force: true }));
  await writeFile(report, 'paid_count=4\npaid_total=550\nshared_login=true');
  await writeFile(secret, 'SYNTHETIC-PRIVATE-47');
  const canonicalReport = await fs.realpath(report);
  const original = fs.realpath;
  let replaced = false;
  t.mock.method(fs, 'realpath', async (file: Parameters<typeof original>[0]) => {
    const result = await original(file);
    if ((file === report || result === canonicalReport) && !replaced) {
      replaced = true;
      await fs.rm(report);
      await fs.symlink(secret, report);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(verifyOutput('a', root));
  assert.equal(replaced, true);
});
