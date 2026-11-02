# Work memory and preferences

[User guide](README.md) · [简体中文](../zh-CN/memory.md)

Open a Bot's memory panel for lasting work preferences. Memory is different from conversation history and the document library.

## How memory is created

Daban does not currently turn every conversation into automatic long-term memory. Edit and save it yourself, or explicitly ask the Bot to remember, correct, or forget a preference. Its memory tools and the panel edit the same content.

Suitable examples: “Lead with the conclusion, then evidence” or “Always state the currency for amounts.” Full reports, temporary webpage content, unverified assumptions, passwords, and API keys do not belong here.

## Edit and apply

1. Open memory and read the saved preferences.
2. Edit the full content and save.
3. When using conversation, specify exactly what to retain, change, or remove, and ask the Bot to read back the result.
4. The next task uses the latest saved preferences. An active task does not retroactively change context already used.

Preferences are per Bot; group members retain separate memories. Material from documents and websites should not automatically become a preference or permission grant.

## Revision history

Open history to inspect earlier content. Loading a version only fills the editor; saving applies it. Historical versions are not all automatically sent to the model.

Up to 50 recent versions are retained, with fewer possible for longer content. Clearing current memory does not erase old conversations or retained preference history. An empty editor is not complete data erasure.

## Conflicts and uncertain results

Review the latest saved version if you and a Bot update concurrently. Preserve unrelated preferences instead of overwriting the whole document blindly. Verify unconfirmed operations before writing again.

Use [Knowledge](knowledge.md) for longer sources, [Notes](notes.md) for individual items, and [Shared tasks](tasks.md) for cross-Bot follow-up.
