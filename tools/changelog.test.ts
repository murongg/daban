import { expect, test } from 'vitest';
import { changelogBase, translateChangelog } from './changelog.ts';

const config = {
  url: 'https://models.example.test/v1',
  model: 'synthetic-model',
  key: 'synthetic-key',
};
test('creates both languages using public release records only', async () => {
  const records = 'feat: add synthetic task export (#42)';
  const result = await translateChangelog(records, config, async (url, init) => {
    expect(String(url)).toBe('https://models.example.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-key');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('synthetic-model');
    expect(body.messages[1].content).toBe(records);
    expect(body.messages[0].content.includes('synthetic-key')).toBe(false);
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
  expect(result.zh).toMatch(/合成任务导出/);
  expect(result.en).toMatch(/synthetic task export/);
});
test('does not publish partial translations or hide provider failures', async () => {
  for (const response of [
    Response.json({ error: 'synthetic unauthorized' }, { status: 401 }),
    Response.json({
      choices: [{ message: { content: '{"zh":"更新","en":""}' }, finish_reason: 'stop' }],
    }),
    Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }),
  ])
    await expect(
      translateChangelog('synthetic records', config, async () => response),
    ).rejects.toThrowError();
});

test('changelog comparison uses the previous published version, never an unfinished Git tag or runtime release', () => {
  expect(changelogBase({ tag_name: 'v1.0.0', draft: false, prerelease: false }, 'v1.0.2')).toBe(
    'v1.0.0',
  );
  expect(() =>
    changelogBase(
      { tag_name: 'runtime-' + 'a'.repeat(24), draft: false, prerelease: true },
      'v1.0.2',
    ),
  ).toThrowError(/CHANGELOG_BASE_INVALID/);
  expect(() =>
    changelogBase({ tag_name: 'v1.0.2', draft: false, prerelease: false }, 'v1.0.2'),
  ).toThrowError(/CHANGELOG_ALREADY_PUBLISHED/);
});
