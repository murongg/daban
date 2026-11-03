import assert from 'node:assert/strict';
import test from 'node:test';
import { changelogBase, translateChangelog } from './changelog.ts';

const config = {
  url: 'https://models.example.test/v1',
  model: 'synthetic-model',
  key: 'synthetic-key',
};
test('creates both languages using public release records only', async () => {
  const records = 'feat: add synthetic task export (#42)';
  const result = await translateChangelog(records, config, async (url, init) => {
    assert.equal(String(url), 'https://models.example.test/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'synthetic-model');
    assert.equal(body.messages[1].content, records);
    assert.equal(body.messages[0].content.includes('synthetic-key'), false);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              zh: '### 新功能\n- 支持合成任务导出 (#42)',
              en: '### Features\n- Add synthetic task export (#42)',
            }),
          },
          finish_reason: 'stop',
        },
      ],
    });
  });
  assert.match(result.zh, /合成任务导出/);
  assert.match(result.en, /synthetic task export/);
});
test('does not publish partial translations or hide provider failures', async () => {
  for (const response of [
    Response.json({ error: 'synthetic unauthorized' }, { status: 401 }),
    Response.json({
      choices: [{ message: { content: '{"zh":"更新","en":""}' }, finish_reason: 'stop' }],
    }),
    Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }),
  ])
    await assert.rejects(translateChangelog('synthetic records', config, async () => response));
});

test('changelog comparison uses the previous published version, never an unfinished Git tag or runtime release', () => {
  assert.equal(
    changelogBase({ tag_name: 'v1.0.0', draft: false, prerelease: false }, 'v1.0.2'),
    'v1.0.0',
  );
  assert.throws(
    () =>
      changelogBase(
        { tag_name: 'runtime-' + 'a'.repeat(24), draft: false, prerelease: true },
        'v1.0.2',
      ),
    /CHANGELOG_BASE_INVALID/,
  );
  assert.throws(
    () => changelogBase({ tag_name: 'v1.0.2', draft: false, prerelease: false }, 'v1.0.2'),
    /CHANGELOG_ALREADY_PUBLISHED/,
  );
});
