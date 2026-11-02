# Skills

[User guide](README.md) · [简体中文](../zh-CN/skills.md)

Open **Skills** in a Bot's workspace. A skill is a reusable method with optional scripts, references and templates. Enablement is per Bot, and instructions do not grant tool permissions.

## Built-in find-skills

Daban includes its own adaptation of `find-skills`, enabled for Bots by default and independently switchable in the Skills panel. This read-only system skill needs no separate CLI installation.

Ask, for example, “Find a skill for working with PDFs.” The Bot can search skills.sh, SkillsMP and ClawHub, or preview a public GitHub skill directory, then describe its purpose, source, version and files. After confirmation, Daban saves the exact previewed content and enables it for the current Bot from the next task. Other Bots remain unchanged.

Declining prevents repeated installation prompts for the same content within that task. Installing a skill runs no scripts, hooks or dependency installers, and does not provide platform-specific tools. Rate limits or network restrictions can interrupt discovery; retry later or import a local package.

## Local import and enablement

1. Import a skill folder, ZIP or single `SKILL.md`.
2. Review the purpose, file list and contents, then confirm. Installation only saves files.
3. Enable it separately for each intended Bot. Locally imported custom skills start disabled.

Bots share installed skills but keep separate enablement. Edits and replacements apply to future tasks; running tasks retain their captured version. Built-in system skills cannot be edited, replaced or deleted.

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

Trashing disables the skill for all Bots; restoring requires enabling it again. The library retains up to 100 skills including trash, with a 200 MiB resource storage limit.
