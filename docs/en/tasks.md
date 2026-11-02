# Shared tasks and boards

[User guide](README.md) · [简体中文](../zh-CN/tasks.md)

Open **Tasks** in the sidebar for durable work records shared by you and all Bots. These records differ from one conversation's execution plan.

## Create work

1. Create a task and enter its title, description, and latest progress.
2. Select a state and save.
3. To execute it, separately ask a Bot in conversation to read and carry out that task.
4. Inspect actual results before updating progress and status.

You can also ask: “Record this as shared work, but do not execute it yet.” Saving, changing status, commenting, and marking completion do not automatically start a Bot.

## Lists, boards, and status

Search by keyword and filter by all, incomplete, completed, or trash. List and board views show the same data; trash uses a list. Load more when needed. Loaded counts are not necessarily total counts.

Newer services support to-do, in-progress, review, blocked, completed, and closed states; older services may expose only the three basic states. Status is a work record. Completed or closed does not establish that execution or output verification occurred.

## Collaboration and discussion

Bots can read, record progress, and update shared work when explicitly requested. Open a task's discussion for additional context; see [Task comments](comments.md). Saved descriptions and comments are not execution authority by themselves.

## Drafts and conflicts

Unsaved edits can remain locally. When backend content changes, inspect its current description and progress. Retain fields you edited, use newer values for untouched fields, and review before saving.

Verify the original operation if submission is unconfirmed. Reopening mainly reads the outcome; do not create another task just to check whether the first creation succeeded.

## Trash and restore

Trashing retains content for restoration. It does not stop a Bot already working or delete its output files. Use [Stop task](execution.md) to cancel execution.
