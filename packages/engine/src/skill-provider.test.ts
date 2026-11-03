import { expect, test } from 'vitest';
import { apply, invokedSkills } from './skill-provider.js';
import type { SkillRecipe } from './skills.js';

const recipe: SkillRecipe = {
  name: 'mock-summary',
  description: '合成汇总',
  content: 'SYNTHETIC-INSTRUCTIONS',
  invocation: { modelInvocable: false, userInvocable: true },
};
test('only native slash gestures in the actual accepted human prompt enable explicit invocation', () => {
  expect(
    invokedSkills('请按 /mock-summary 整理，/not-enabled 不在目录里。', [recipe]),
  ).toStrictEqual(['mock-summary']);
  expect(
    invokedSkills('Read /mock-summary/reference.txt and 5/8; do not invoke.', [recipe]),
  ).toStrictEqual([]);
  expect(invokedSkills('/mock-summary\n/mock-summary', [recipe])).toStrictEqual(['mock-summary']);
  expect(
    invokedSkills('/mock-summary', [
      { ...recipe, invocation: { modelInvocable: true, userInvocable: false } },
    ]),
  ).toStrictEqual([]);
});
test('the native registry receives only captured recipes; other wrapped text cannot grant manual invocation', () => {
  const registered: SkillRecipe[] = [];
  const ctx = {
    skills: {
      register: (value: SkillRecipe) => {
        registered.push(value);
        return () => {};
      },
    },
  };
  const config = { skills: [structuredClone(recipe)], invoked: [] as string[] };
  apply(ctx, config);
  expect(registered[0].invocation.userInvocable).toBe(false);
  expect(registered[0].invocation.modelInvocable).toBe(false);
  expect(registered[0].content).toBe(recipe.content);
  config.skills[0].content = 'MUTATED-AFTER-REGISTRATION';
  expect(registered[0].content).toBe(recipe.content);
  registered.length = 0;
  apply(ctx, { skills: [recipe], invoked: ['mock-summary'] });
  expect(registered[0].invocation.userInvocable).toBe(true);
  expect('tools' in registered[0]).toBe(false);
  expect(() => apply(ctx, { skills: [recipe, recipe], invoked: [] })).toThrowError(
    /INVALID_SKILL_SNAPSHOT/,
  );
});
test('standard package loading retains metadata and explains scoped resource tools without granting allowed-tools', () => {
  const registered: (SkillRecipe & { resourceBase?: { description: string } })[] = [];
  apply(
    { skills: { register: (skill) => registered.push(skill) } },
    {
      skills: [
        {
          ...recipe,
          metadata: { license: 'MIT', 'allowed-tools': 'Bash' },
          package: { digest: 'a'.repeat(64), fileCount: 2, bytes: 100 },
          files: [
            { path: 'references/guide.md', size: 20, sha256: 'b'.repeat(64), executable: false },
          ],
        },
      ],
      invoked: ['mock-summary'],
    },
  );
  expect(registered[0].metadata?.license).toBe('MIT');
  expect(registered[0].resourceBase!.description).toMatch(/skill_read/);
  expect(registered[0].resourceBase!.description).toMatch(/skill_prepare/);
  expect('allowedTools' in registered[0]).toBe(false);
});
