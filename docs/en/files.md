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

## Read-only file review

With a compatible Linux execution service, new tasks record their task directory after inputs are staged and again after known tool calls drain. Open **File review** from execution details or the files panel to compare retained evidence. Before sending, you can explicitly select up to eight existing shared files; a queued selection stays with that request and requires a new run.

Project tasks review their own private task directory and the selected files in that project's shared area. Choices stay bound to the Host, workspace, Bot, chat and project revision. Evidence reads check the original project's current authorization; changing projects does not grant access to an earlier run. A Guest without project review support reports unavailable and never substitutes legacy shared files.

The review shows additions, modifications, deletions, unchanged files and unknown evidence, plus bounded UTF-8 line differences. **Check current state** compares a fresh read with the retained end evidence; it does not replace history. Regular preview and download still read the current file. Missing or unstable baselines, exclusions and size/time limits remain explicit. Binary files have size and digest evidence, without a semantic document comparison.

Two observations do not establish which Bot caused a change, cover external actions, or prove background writers have stopped. Files created and deleted between observations may be invisible. Review has no restore or patch action. Evidence is private to the Host and retained for at most 30 days, 64 terminal runs and 512 MiB; active reviews are not evicted. Older execution services and native-only workspaces report review as unavailable.

## Sharing and paths

The backend manages Linux task and shared directories. Bots can list, read, write, and process files through workspace tools. Task directories can differ. Ask the Bot to locate an earlier output or shared file instead of guessing an old path.

Independent screens do not isolate files. Overwriting, moving, or deleting shared material can affect other Bots. Host files do not automatically appear in the VM simply because they exist in a Mac or Windows folder; use attachments, downloads, or an explicit transfer.

## Limits

- Windows native mode does not offer Linux workspace file, shell, or process tools. Real files remain usable through GUI applications, with supported text and image inputs.
- Previews do not replace specialized applications. Large, binary, or complex formats may need downloading.
- Historical links refer to retained current files rather than an immutable complete backup.
- Workspace export excludes Linux files and VM disks. See [Workspace export](workspace-export.md).

See [Attachments](attachments.md) for retained attachment cleanup and [Knowledge](knowledge.md) for document management.
