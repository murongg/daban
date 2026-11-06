import { botManagerSkill } from './bot-manager.js';
import { findSkillsSkill } from './find-skills.js';
import { skillCreatorSkill } from './skill-creator.js';
import type { SkillDefault } from './skills.js';

export const builtinSkills: readonly SkillDefault[] = [
  botManagerSkill,
  findSkillsSkill,
  skillCreatorSkill,
];
