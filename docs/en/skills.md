# Skill instructions

[User guide](README.md) · [简体中文](../zh-CN/skills.md)

Open **Skills** in a Bot's workspace. Skills hold reusable working instructions; they are not an application store and do not create tool permissions.

## Create or import

1. Create a skill or import a single `SKILL.md`. Complete packages containing scripts, attachments, or executable dependencies are not currently supported.
2. Review its name, purpose, source, and body.
3. Save it to the shared library and enable it separately for each intended Bot.
4. For manual use, add it to the draft, review the command, and send. Adding to a draft does not execute it.

Minimal example:

```markdown
---
name: weekly-summary
description: Summarize supplied weekly work records
---

Check the date range, then summarize completed work, problems, and next steps.
State missing information rather than inventing numbers.
```

Use a short lowercase English name. All Bots share the library, so editing a skill affects future use by other Bots. Enablement remains per Bot, and changes apply to subsequent tasks.

## Automatic and manual invocation

By default, skills can be loaded for relevant tasks or invoked with `/<skill-name>`. `disable-model-invocation: true` restricts automatic invocation; `user-invocable: false` restricts the manual entry point. Check the invocation state shown in the panel.

Disabling one invocation route does not grant permission through another. A skill can use only tools already available to the Bot. It does not bypass installation approvals, external-tool approval, or computer authorization.

## Edit, export, and restore

Save or discard current edits before switching documents. Export the current instructions when needed. Trashing a skill disables it for all Bots. Restoring requires per-Bot enablement again.

The library retains at most 100 skills, including trash. Review third-party instructions before use and keep secrets or executable installation assumptions out of the body. See [Bot transfer](bot-transfer.md) to share selected skills with a Bot.
