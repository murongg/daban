# Workspace files and previews

[User guide](README.md) · [简体中文](../zh-CN/files.md)

Open **Files** in a Bot's workspace. Actual work files, chat attachments, and knowledge documents serve different purposes.

| Material | Purpose |
| --- | --- |
| Workspace files | Task outputs and files for further work; Linux includes a shared area |
| Chat attachments | Inputs for messages and retained attachment content |
| Knowledge | Long-term textual references belonging to a Bot |
| Local folders | Real computer directories connected to the current Bot for direct search, editing and organization |

## Connect local folders

1. Open **Local folders** next to the composer or in the Files panel, then choose **Add folder**.
2. Select a directory in the native folder picker. Connections belong to the current Bot and can include several directories.
3. You can also send the Bot a local directory path or `file://` link. If that directory is not connected, the Bot can request access; approve by selecting the actual directory in the native picker. The path in the request only points the picker to a starting location. Only the directory you select is connected.
4. Describe the task, for example: “Find text files mentioning budget, change the project status to confirmed, then read it back.” These operations do not start Linux.
5. Review recent changes in the same window. Short text changes retain before/after previews. Deleted regular files stay in `.daban-trash` inside their original directory; **Restore file** returns them without overwriting an existing destination.
6. **Disconnect** revokes subsequent access and keeps the actual files. Reconnecting the same actual directory makes its earlier trash records available for restoration again.

Local tools support directory listing, UTF-8 reads, filename globs and literal content search, text creation and exact edits, directory creation, regular-file moves/renames and recoverable trash. Existing files require the revision observed before a change, preventing overwrites of subsequent human edits. Ask-for-approval mode shows a local-file approval card before modifications.

Connected folders can also enable `local_shell` for command-line processing with installed Python, Node, or other host tools. Each command requires its own approval. The card shows the full command, working directory and authorized folder; the sandbox limits file access to that folder and system tools, blocks network access, and provides no sudo. If the required OS sandbox is unavailable, the command is refused. This capability supports macOS and Linux and does not copy files into the Linux VM.

Text reads/writes are limited to 1 MiB per file. Binary files can be listed, moved and trashed. Searches skip links, `.git`, `node_modules` and Daban trash; narrow searches when results report truncation. History displays the latest 100 changes. Verify actual files before continuing an operation with an uncertain outcome.

## Inspect and use files

1. Open the files panel and refresh its list.
2. Open an available preview or download the file to your computer.
3. Add a file to a message when you want the model to process it, and describe the requested action.
4. Inspect actual outputs instead of relying only on a model's statement that a file was created.

Example: “Generate a CSV from the attachment, save it, and check its headers and row count.” Download and inspect the actual result.

## Sharing and paths

Ordinary tasks use the application-managed native workspace. Bots can list, read, write, and export knowledge text there. On macOS and Linux, Request approval asks before running each task command in the sandbox, and Approve for me runs those commands automatically. Selecting [Full access](approvals.md) lets task commands run directly with the current system account's permissions, using PowerShell on Windows and Bash on macOS and Linux.

Linux keeps separate task and shared directories. A Bot starts installed Linux for commands when you explicitly request execution in the VM. It explicitly transfers additional inputs and brings outputs back. The whole native workspace is never synchronized automatically. Task directories can differ. Ask the Bot to locate an earlier output or shared file instead of guessing an old path. Retained Linux files remain in Linux and can be found with the Linux file tools.

Independent screens do not isolate files. Overwriting, moving, or deleting shared material can affect other Bots. Host files do not automatically appear in the VM simply because they exist in a Mac or Windows folder; use attachments, downloads, or an explicit transfer.

## Limits

- Windows task commands require Full access. Connected-folder commands are available on macOS and Linux and require approval each time. Desktop control requires separate authorization.
- Previews do not replace specialized applications. Large, binary, or complex formats may need downloading.
- Historical links refer to retained current files rather than an immutable complete backup.
- Workspace export excludes native and Linux work files and VM disks. Download important outputs separately. See [Workspace export](workspace-export.md).

See [Attachments](attachments.md) for retained attachment cleanup and [Knowledge](knowledge.md) for document management.
