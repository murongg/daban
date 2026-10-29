import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, invokedSkills } from './skill-provider.js';
import type { SkillRecipe } from './skills.js';

const recipe: SkillRecipe = {
  name: 'mock-summary',
  description: '合成汇总',
  content: 'SYNTHETIC-INSTRUCTIONS',
  invocation: { modelInvocable: false, userInvocable: true },
};
test('only native slash gestures in the actual accepted human prompt enable explicit invocation', () => {
  assert.deepEqual(invokedSkills('请按 /mock-summary 整理，/not-enabled 不在目录里。', [recipe]), [
    'mock-summary',
  ]);
  assert.deepEqual(
    invokedSkills('Read /mock-summary/reference.txt and 5/8; do not invoke.', [recipe]),
    [],
  );
  assert.deepEqual(invokedSkills('/mock-summary\n/mock-summary', [recipe]), ['mock-summary']);
  assert.deepEqual(
    invokedSkills('/mock-summary', [
      { ...recipe, invocation: { modelInvocable: true, userInvocable: false } },
    ]),
    [],
  );
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
  assert.equal(registered[0].invocation.userInvocable, false);
  assert.equal(registered[0].invocation.modelInvocable, false);
  assert.equal(registered[0].content, recipe.content);
  config.skills[0].content = 'MUTATED-AFTER-REGISTRATION';
  assert.equal(registered[0].content, recipe.content);
  registered.length = 0;
  apply(ctx, { skills: [recipe], invoked: ['mock-summary'] });
  assert.equal(registered[0].invocation.userInvocable, true);
  assert.equal('tools' in registered[0], false);
  assert.throws(
    () => apply(ctx, { skills: [recipe, recipe], invoked: [] }),
    /INVALID_SKILL_SNAPSHOT/,
  );
});
