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

Ordinary tasks use the application-managed native workspace. Bots can list, read, write, and export knowledge text there without starting a VM. These tools grant neither arbitrary host-file access nor a host shell.

Linux keeps separate task and shared directories. A Bot starts installed Linux when commands or Linux software are needed, explicitly transfers additional inputs, and brings outputs back. The whole native workspace is never synchronized automatically. Task directories can differ. Ask the Bot to locate an earlier output or shared file instead of guessing an old path. Retained Linux files remain in Linux and can be found with the Linux file tools.

Independent screens do not isolate files. Overwriting, moving, or deleting shared material can affect other Bots. Host files do not automatically appear in the VM simply because they exist in a Mac or Windows folder; use attachments, downloads, or an explicit transfer.

## Limits

- Native file tools are limited to the application workspace. Linux shells, processes, and complex document parsing require Linux to be installed and start it on actual use. Native applications and files outside the workspace still require separately authorized desktop control.
- Previews do not replace specialized applications. Large, binary, or complex formats may need downloading.
- Historical links refer to retained current files rather than an immutable complete backup.
- Workspace export excludes native and Linux work files and VM disks. Download important outputs separately. See [Workspace export](workspace-export.md).

See [Attachments](attachments.md) for retained attachment cleanup and [Knowledge](knowledge.md) for document management.
