import { expect, test } from 'vitest';
import { changelogBase, formatReleaseNotes, translateChangelog } from './changelog.ts';

const config = {
  url: 'https://models.example.test/v1',
  model: 'synthetic-model',
  key: 'synthetic-key',
};
const translation = {
  zh: {
    summary: '本次更新完善合成任务导出。',
    maintenance: ['更新合成构建配置 (`abc1234`)'],
    fixes: ['修复合成导出文件名 (#44)'],
    improvements: ['优化合成导出进度提示 (#43)'],
    features: ['支持 **合成任务导出** (#42)'],
    breaking: ['合成导出格式改为 JSON，需要更新读取脚本 (#45)'],
  },
  en: {
    summary: 'This release improves synthetic task export.',
    maintenance: ['Update synthetic build configuration (`abc1234`)'],
    fixes: ['Fix synthetic export filenames (#44)'],
    improvements: ['Improve synthetic export progress messages (#43)'],
    features: ['Add **synthetic task export** (#42)'],
    breaking: ['Synthetic exports now use JSON; update reader scripts (#45)'],
  },
};

function completion(content: unknown) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
  });
}

test('creates both languages using public release records only', async () => {
  const records = 'feat: add synthetic task export (#42)';
  const result = await translateChangelog(records, config, async (url, init) => {
    expect(String(url)).toBe('https://models.example.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-key');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('synthetic-model');
    expect(body.messages[1].content).toBe(records);
    expect(body.messages[0].content.includes('synthetic-key')).toBe(false);
    expect(body.response_format).toEqual({ type: 'json_object' });
    return completion(translation);
  });
  expect(result).toEqual({
    zh: [
      '本次更新完善合成任务导出。',
      '## 重要变更\n\n- 合成导出格式改为 JSON，需要更新读取脚本 (#45)',
      '## 新增功能\n\n- 支持 **合成任务导出** (#42)',
      '## 体验优化\n\n- 优化合成导出进度提示 (#43)',
      '## 问题修复\n\n- 修复合成导出文件名 (#44)',
      '## 维护更新\n\n- 更新合成构建配置 (`abc1234`)',
    ].join('\n\n'),
    en: [
      'This release improves synthetic task export.',
      '## Breaking changes\n\n- Synthetic exports now use JSON; update reader scripts (#45)',
      '## Features\n\n- Add **synthetic task export** (#42)',
      '## Improvements\n\n- Improve synthetic export progress messages (#43)',
      '## Fixes\n\n- Fix synthetic export filenames (#44)',
      '## Maintenance\n\n- Update synthetic build configuration (`abc1234`)',
    ].join('\n\n'),
  });
});

test('omits empty categories and normalizes surrounding whitespace', async () => {
  const notes = {
    zh: {
      summary: '  修复合成导出问题。  ',
      breaking: [],
      features: [],
      improvements: [],
      fixes: ['  修复合成文件名 (#44)  ', '保留[原始记录](https://example.test/changes/44)'],
      maintenance: [],
    },
    en: {
      summary: '  Fix synthetic export issues.  ',
      breaking: [],
      features: [],
      improvements: [],
      fixes: [
        '  Fix synthetic filenames (#44)  ',
        'Keep [source records](https://example.test/changes/44)',
      ],
      maintenance: [],
    },
  };
  const result = await translateChangelog('synthetic records', config, async () =>
    completion(notes),
  );
  expect(result).toEqual({
    zh: '修复合成导出问题。\n\n## 问题修复\n\n- 修复合成文件名 (#44)\n- 保留[原始记录](https://example.test/changes/44)',
    en: 'Fix synthetic export issues.\n\n## Fixes\n\n- Fix synthetic filenames (#44)\n- Keep [source records](https://example.test/changes/44)',
  });
});

test('rejects malformed or mismatched structured notes before publishing', async () => {
  for (const zh of [
    null,
    'Free-form Markdown is no longer the model response format.',
    { ...translation.zh, summary: '' },
    { ...translation.zh, summary: 'Summary\n## Injected heading' },
    { ...translation.zh, summary: '## Model-supplied heading' },
    { ...translation.zh, features: ['First line\n- Nested bullet'] },
    { ...translation.zh, features: ['- Model-supplied bullet'] },
    { ...translation.zh, features: ['<details>Model-supplied HTML</details>'] },
    { ...translation.zh, features: [''] },
    { ...translation.zh, features: [42] },
    { ...translation.zh, fixes: 'A category must be an array.' },
    { ...translation.zh, maintenance: undefined },
    { ...translation.zh, features: [] },
    { ...translation.zh, extra: 'Unexpected category' },
  ]) {
    await expect(
      translateChangelog('synthetic records', config, async () =>
        completion({ ...translation, zh }),
      ),
    ).rejects.toThrowError(/CHANGELOG_TRANSLATION_INVALID/);
  }
  const empty = {
    summary: 'Synthetic empty release.',
    breaking: [],
    features: [],
    improvements: [],
    fixes: [],
    maintenance: [],
  };
  await expect(
    translateChangelog('synthetic records', config, async () =>
      completion({ zh: empty, en: empty }),
    ),
  ).rejects.toThrowError(/CHANGELOG_TRANSLATION_INVALID/);
});

test('formats versioned downloads and nests bilingual sections above collapsed source records', () => {
  const translated = {
    zh: '合成更新摘要。\n\n## 新增功能\n\n- 新增合成导出 (#42)',
    en: 'Synthetic release summary.\n\n## Features\n\n- Add synthetic export (#42)',
  };
  const records =
    '## Synthetic source records\n\n- Synthetic export (#42)\n\n[Compare](https://example.test/compare/v1.0.0...v1.1.0)';
  expect(formatReleaseNotes('v1.1.0', translated, records)).toEqual({
    zh: `# v1.1.0\n\n${translated.zh}\n`,
    en: `# v1.1.0\n\n${translated.en}\n`,
    release: [
      '## 中文',
      '合成更新摘要。',
      '### 新增功能\n\n- 新增合成导出 (#42)',
      '## English',
      'Synthetic release summary.',
      '### Features\n\n- Add synthetic export (#42)',
      '---',
      '<details>\n<summary>原始记录 / Original change records</summary>',
      records,
      '</details>\n',
    ].join('\n\n'),
  });
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
