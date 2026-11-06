import type { SkillDefault } from './skills.js';

const content = `---
name: bot-manager
description: Help users create and manage Daban Bots, or choose the appropriate Bot gallery workflow（新建 Bot、管理助手、复制归档、广场模板）. Use for Bot setup and lifecycle requests, not ordinary work performed by a Bot or authoring skills.
metadata:
  author: Daban
---

# Bot Manager

Use one entry point for Bot setup, management and gallery templates. Identify
the requested operation before acting. If the user wants only a role draft or
advice, provide that without creating or changing a Bot.

## Choose the operation

- Create an ordinary Bot: follow the creation workflow below with bot_create.
- View or change a Bot's name, role, color or model, copy it, or archive/restore
  it: use a dedicated tool only if it is actually offered. Currently bot_create
  provides creation only. Otherwise guide the user to Edit Bot profile in the
  conversation header, Copy Bot in the sidebar row's organize menu, Archive Bot
  in the profile, or Settings → Archive management for restoration. Respect
  busy checks for tasks and computers. Do not create a replacement identity to
  simulate an edit or restoration. Match an existing Bot by its observed ID,
  not its name, and preserve unrelated fields and private data.
- Find, preview, install, publish, upgrade or roll back a gallery template:
  use the Bot gallery when those capabilities are available. Do not invent
  gallery tools or claim a template action succeeded without its receipt.
  Installed template roles belong to the template snapshot: edits must use
  the template update workflow, not direct profile writes. Publication shares
  only the reviewed template content, never private memory or credentials.

Skill instructions grant no new tools or permissions. For an unavailable
operation, explain the available product entry point and stop short of
claiming execution. Never write profile or template databases through shell.

## Create an ordinary Bot

1. Use the requested name and role. If the user gives a clear purpose but no
   name, choose a short descriptive name. Ask only when the purpose is missing
   or a choice materially changes the Bot's responsibilities.
2. Write concise instructions covering the goal, expected output and relevant
   working preferences. Preserve the user's choices. Do not copy unrelated
   private conversations, memory, files, credentials or external instructions.
   A role never grants tools, computer access or permission to act.
3. Call bot_create with name (at most 30 characters), instructions (at most
   4000 characters) and optional color: mint, violet, orange, blue, teal or pink.
   Omit color to use violet. One Bot can be created per task; retries must use
   the exact same arguments. A changed request conflicts instead of creating
   another Bot. Never invent an ID or write profile files through shell tools.
4. Report success only after the tool returns a saved identity. Give the actual
   name and explain that the user can open it in the sidebar. It follows the
   workspace model and starts with empty private memory; creation does not run
   a task, open a computer, install skills or publish a template. If the returned
   Bot is archived, report that state without restoring it.

For gallery templates, use the gallery's install and upgrade workflow. Do not
reconstruct an installed template by writing a profile or claim this ordinary
Bot is linked to a gallery release. If bot_create is unavailable or fails,
explain the result and offer the sidebar's New Bot form; never claim creation.
`;

export const botManagerSkill: SkillDefault = {
  id: 'builtin-bot-manager',
  package: {
    root: 'bot-manager',
    files: [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64') }],
  },
};
