# Skills

[User guide](README.md) · [简体中文](../zh-CN/skills.md)

Open **Capabilities → Skills** in a Bot's workspace. A skill is a reusable method with optional scripts, references and templates. Enablement is per Bot, and instructions do not grant tool permissions.

## Built-in find-skills

Daban includes its own adaptation of `find-skills`, enabled for Bots by default and independently switchable in the Skills panel. This read-only system skill needs no separate CLI installation.

Ask, for example, “Find a skill for working with PDFs.” The Bot can search skills.sh, SkillsMP and ClawHub, or preview a public GitHub skill directory, then describe its purpose, source, version and files. After confirmation, Daban installs the exact previewed version for the current Bot and enables it. The same task can read the new skill and continue. Other Bots’ installations, versions and enabled states remain unchanged.

Declining prevents repeated installation prompts for the same content within that task. Installing a skill runs no scripts, hooks or dependency installers, and does not provide platform-specific tools. Rate limits or network restrictions can interrupt discovery; retry later or import a local package.

## Built-in bot-manager

`bot-manager` is the unified skill entry point for Bot operations, enabled by default and independently switchable for each Bot. Ask “Create a Bot to organize reference material,” or invoke `/bot-manager`. The Bot proposes a name and role from your purpose; after saving, open the new assistant in the sidebar.

The new Bot follows the workspace model and starts with empty private memory. It does not copy the current Bot's chats, documents, skills or computer authority, or start a task. Identical creation retries in the same task save only one Bot; changed arguments conflict instead of overwriting it. This creates an ordinary Bot; use the gallery to install and upgrade gallery templates.

Creation can currently run directly in conversation. Profile edits, copying, archiving and restoration guide you to the appropriate management surface. Gallery publication, upgrades and rollback require the corresponding runtime capabilities; enabling the skill grants no additional authority.

## Built-in skill-creator

Ask “Turn this workflow into a skill so we can reuse it,” or invoke `/skill-creator`. The Bot drafts the purpose, trigger conditions and procedure in `SKILL.md`, adding text scripts, references or templates when useful.

Drafting only previews the package. **Install and enable** confirms saving for the current Bot, after which the same task can read it and continue. The confirmation shows the skill instructions, file count and digest; when instructions are truncated, review the complete draft in the conversation. Supporting files use relative paths. Import binary resources through the existing package import UI.

Drafting and installation run no scripts, hooks or dependency installers. Declining prevents repeated prompts for identical content in the same task. Saving does not overwrite differing existing content or change another Bot's skills. Use **Capabilities → Skills** to edit an existing skill or replace its package.

## Local import and enablement

1. Import a skill folder, ZIP or single `SKILL.md`.
2. Review the purpose, file list and contents, then confirm. Installation only saves files.
3. Choose **Install and enable** to install only for the current Bot. Saving newly authored skill instructions saves content without automatically enabling them.

Installations, versions, edits and removal belong to each Bot. Identical supporting files are deduplicated internally. **Add to another Bot** creates an independent copy after you choose its recipient; later edits remain independent. Running tasks retain their captured versions, except that an explicitly confirmed new installation can be read within that task. Other later grants are not pulled into it. Built-in skills remain read-only.

Existing shared records are retained and labelled. Create an independent copy before editing one for this Bot; other Bots keep the original content.

## Standard packages

Use the [Agent Skills](https://agentskills.io/specification) directory format:

```text
weekly-summary/
  SKILL.md
  scripts/report.py
  references/guide.md
  assets/template.csv
```

The directory directly contains `SKILL.md` and matches its frontmatter `name`. Other relative files, including binary templates, are preserved. Packages allow up to 200 files and 5 MiB unpacked; ZIP uploads allow 6 MiB. Symlinks, special files and escaping paths are rejected.

```markdown
---
name: weekly-summary
description: Summarize supplied weekly work records
license: MIT
compatibility: Python 3
metadata:
  author: example
---

Read references/guide.md. If calculations are needed, prepare the full directory
and run scripts/report.py from there so it can access assets/.
State missing information rather than inventing numbers.
```

Use a short lowercase English name. License, compatibility, metadata and `allowed-tools` declarations are retained as data, without granting permissions. Namespaced OpenClaw metadata is preserved without automatically executing its installers or hooks.

## How Bots use skills

Enabled Bots can read instructions and supporting files on demand, then prepare a complete directory before using scripts. Linux scripts use the existing command and approval flow. Missing dependencies require a separate installation; execution records determine the actual outcome. Native Mac / Windows mode provides managed resource files for authorized GUI work without adding host shell access.

Skills can load for relevant tasks or be invoked with `/<skill-name>`. `disable-model-invocation: true` restricts automatic invocation, and `user-invocable: false` restricts the manual entry point. Check the invocation state shown in the panel.

## Edit, export and restore

Editing `SKILL.md` preserves supporting files. Use **Replace package** to update the entire directory and review the revision. Preview or download individual files, or export a complete ZIP. A Markdown-only export contains just the instructions; use ZIP or [Bot transfer](bot-transfer.md) for a complete skill.

Trashing removes only this Bot’s installation; restoring requires enabling it again. The library retains up to 100 skills including trash, with a 200 MiB resource storage limit.
