import { isSkillName } from '@daban/protocol';
import type { SkillRecipe } from './skills.js';

export const name = 'daban-skills';
export const inject = ['skills'];
export function invokedSkills(prompt: string, skills: readonly SkillRecipe[]) {
  const allowed = new Set(
    skills.filter((skill) => skill.invocation.userInvocable).map((skill) => skill.name),
  );
  return [
    ...new Set(
      [...prompt.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)]
        .map((match) => match[2])
        .filter((name) => allowed.has(name)),
    ),
  ];
}
interface Context {
  skills: {
    register: (
      skill: SkillRecipe & {
        source: 'custom';
        provider: string;
        resourceBase: { kind: 'opaque'; description: string };
      },
    ) => unknown;
  };
}
export function apply(ctx: Context, config: { skills: SkillRecipe[]; invoked: string[] }) {
  const skills = structuredClone(config.skills);
  if (
    !Array.isArray(skills) ||
    skills.length > 20 ||
    !Array.isArray(config.invoked) ||
    skills.some(
      (skill) =>
        !skill ||
        !isSkillName(skill.name) ||
        typeof skill.description !== 'string' ||
        !skill.description.trim() ||
        skill.description.length > 2000 ||
        typeof skill.content !== 'string' ||
        !skill.content.trim() ||
        skill.content.length > 100000 ||
        skill.content.includes('\0') ||
        !skill.invocation ||
        typeof skill.invocation.modelInvocable !== 'boolean' ||
        typeof skill.invocation.userInvocable !== 'boolean',
    ) ||
    new Set(skills.map((skill) => skill.name)).size !== skills.length ||
    config.invoked.some((name) => !skills.some((skill) => skill.name === name))
  )
    throw new Error('INVALID_SKILL_SNAPSHOT');
  const invoked = new Set(config.invoked);
  for (const skill of skills)
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'custom',
      provider: 'daban-user',
      resourceBase: {
        kind: 'opaque',
        description:
          'Single SKILL.md instructions only; support files and executable plugins were not installed.',
      },
      // The SDK prompt also contains quoted history/files. Only gestures in the original accepted human text may invoke a manual-only recipe.
      invocation: {
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable && invoked.has(skill.name),
      },
    });
}
