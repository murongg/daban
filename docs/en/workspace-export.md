# Workspace export and data preservation

[User guide](README.md) · [简体中文](../zh-CN/workspace-export.md)

Open **Settings → Data & storage → Export workspace**. This downloads a JSON copy of client workspace state, not a complete application backup.

## Export

1. Save important forms and edits first.
2. Open the data/storage settings and export.
3. Keep `daban-workspace.json` somewhere you can find again.
4. Review its contents before sharing. Do not publish the file directly in Git.

## Scope

| Material | Workspace export |
| --- | --- |
| Private-chat caches, drafts, preferences, and settings | Includes the part saved in the client |
| Attachment references | May include references, not the originals |
| Complete backend group history, knowledge, and databases | No complete copy |
| Attachment originals, Linux outputs, and VM disks | Excluded |
| API keys and native desktop authority | Not exported as transferable authorization |

Do not treat this file as a guarantee of one-click restoration of all history, accounts, and runtime state. A complete environment import/restore flow is not currently provided.

## Preserve important material

Download outputs from [Files](files.md), saved text and originals separately from [Knowledge](knowledge.md), and selected Bot material through [Bot export](bot-transfer.md). Full backend and VM backups need a separate plan.

Uninstalling, clearing user directories, deleting a VM, or reinitializing can lose backend records, sign-ins, and files. Confirm the preservation scope before environment repairs. Rebuildable installation artifacts and the active user environment are different things.

Export is for retention and inspection, not live cross-device synchronization, mobile context synchronization, or automatic cloud backup.
