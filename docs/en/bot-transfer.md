# Import and export Bots

[User guide](README.md) · [简体中文](../zh-CN/bot-transfer.md)

Transfer selected Bot content, not a complete workspace or signed-in environment. Use [Copy Bot](copy-bot.md) for a saved-role copy within the same workspace.

## Export

1. Open the Bot profile and choose export.
2. Review the saved role and select preferences, skill instructions, and current documents to include.
3. Optionally include retained originals, especially PDF/Office files.
4. Download the JSON export.

Only selected saved content is included, not unsaved drafts or every historical document version. Originals can contain information absent from the current text; review before sharing.

## Import

1. Open the new-Bot entry and choose import.
2. Select a UTF-8 JSON file exported by Daban, up to 100 MiB.
3. Review the role, preferences, skills, and documents and confirm the source.
4. Import as a new Bot and wait for completion.
5. Review its model selection and documents, then manually enable imported skills when appropriate.

Imports containing PDF/Office originals require available Linux document parsing. Importing does not start tasks or connect a computer, and imported custom skills are not automatically enabled; the built-in find-skills retains its normal default behavior.

Selected standard skills include their scripts, references and assets. These exports require an updated client with complete package support; legacy instruction-only exports remain readable.

## What does not migrate

Conversations, model connections and API keys, external-tool permissions, desktop authorization, and browser sign-ins are excluded. Import creates a separate identity rather than overwriting an existing Bot. Do not assume tasks, schedules, notes, or anything not explicitly listed in the preview migrated.

## Interruptions and verification

Closing the dialog does not cancel an import already submitted. Use the retained progress entry for uncertain results. If asked to select the file again, select the same content instead of submitting changing copies repeatedly. Verify which Bots exist before starting another import.

Exports may contain business material and preferences; share according to their actual contents. They do not replace [workspace data preservation](workspace-export.md).
