# Workspace files and previews

[User guide](README.md) · [简体中文](../zh-CN/files.md)

Open **Files** in a Bot's workspace. Actual work files, chat attachments, and knowledge documents serve different purposes.

| Material | Purpose |
| --- | --- |
| Workspace files | Task outputs and files for further work; Linux includes a shared area |
| Chat attachments | Inputs for messages and retained attachment content |
| Knowledge | Long-term textual references belonging to a Bot |

## Inspect and use files

1. Open the files panel and refresh its list.
2. Open an available preview or download the file to your computer.
3. Add a file to a message when you want the model to process it, and describe the requested action.
4. Inspect actual outputs instead of relying only on a model's statement that a file was created.

Example: “Generate a CSV from the attachment, save it, and check its headers and row count.” Download and inspect the actual result.

## Sharing and paths

The backend manages Linux task and shared directories. Bots can list, read, write, and process files through workspace tools. Task directories can differ. Ask the Bot to locate an earlier output or shared file instead of guessing an old path.

Independent screens do not isolate files. Overwriting, moving, or deleting shared material can affect other Bots. Host files do not automatically appear in the VM simply because they exist in a Mac or Windows folder; use attachments, downloads, or an explicit transfer.

## Limits

- Windows native mode does not offer Linux workspace file, shell, or process tools. Real files remain usable through GUI applications, with supported text and image inputs.
- Previews do not replace specialized applications. Large, binary, or complex formats may need downloading.
- Historical links refer to retained current files rather than an immutable complete backup.
- Workspace export excludes Linux files and VM disks. See [Workspace export](workspace-export.md).

See [Attachments](attachments.md) for retained attachment cleanup and [Knowledge](knowledge.md) for document management.
