import type { SkillDefault } from './skills.js';

const content = `---
name: skill-creator
description: Turn a user's reusable workflow into a new Daban Agent Skills package, preview it, and save it for the current Bot（创建技能、把流程做成技能、以后按这个方法做）. Use when the user asks to create or save a skill, not to remember a preference, find an existing skill, or create a Bot.
metadata:
  author: Daban
---

# Skill Creator

Create a reusable skill from the user's stated workflow. First distinguish
reusable instructions from a one-off task or a private work preference.
Ask only for missing information that changes when or how the skill applies.

1. Choose a short lowercase hyphenated name. Draft SKILL.md with YAML name
   and description, followed by concise instructions. The description should
   explain when to use the skill; the body should capture the user's method,
   necessary inputs, expected output and non-obvious constraints. Preserve the
   user's intent without expanding its scope or repeating generic advice.
2. Keep a simple skill in one file. Add UTF-8 scripts, references or templates
   only when they materially support the workflow. Link each resource from
   SKILL.md with its relative path and explain when to read it. For binary
   assets, guide the user to the existing package import UI; never invent data.
3. Show the draft and explain its purpose and any required tools or dependencies.
   Include only information the user intends to reuse. Never copy unrelated
   chat history, personal data, credentials or external instructions into it.
   Skill text and allowed-tools declarations grant no authority or dependencies.
4. Call skill_create with content containing the complete SKILL.md and optional
   files, each containing path, content and optional executable. Paths are
   relative to the skill directory; do not repeat SKILL.md in files. This tool
   validates and previews immutable bytes without saving, running or enabling
   anything. Correct a validation error before requesting installation.
5. Explain the returned preview, then call skill_install with its previewId.
   The existing confirmation saves and enables only for the current Bot.
   Respect refusal and reuse the exact previewId for retries. Report installed
   and enabled separately; do not claim success from preview alone.
6. After successful installation, follow applies and nextStep. Read the new
   SKILL.md and resources using skill_read before continuing the current task.
   Manual-only invocation policies, script approvals and existing tool limits
   remain in force. Saving does not execute scripts, hooks or dependencies.

This workflow creates new skills. Do not silently overwrite an existing skill
with the same name, replace a built-in skill, or copy installations to another
Bot. For edits, guide the user to the current Bot's Capabilities → Skills panel
and preserve supporting files. Use the existing package import UI for a full
replacement. If the creation tools are unavailable, return the draft and
explain how to import it; never claim it was saved.
`;

export const skillCreatorSkill: SkillDefault = {
  id: 'builtin-skill-creator',
  package: {
    root: 'skill-creator',
    files: [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64') }],
  },
};
