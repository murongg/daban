# Reconnect and recover the environment

[User guide](README.md) · [简体中文](../zh-CN/recovery.md)

Distinguish client connectivity, native desktop authorization, and the whole Linux environment before repairing a problem. Do not start by deleting the VM or user data.

## Try reconnecting first

Use reconnect/retry in **Settings → Computer & permissions** to reconnect to the backend rather than restarting all applications. In Linux mode, run [Diagnostics](diagnostics.md) to identify the failing component first.

For native Mac or Windows control, check [authorization](local-computer.md), OS permissions, and pause state. Linux recovery does not repair host screen-recording permissions.

## Recover the whole Linux environment

1. Open the check-and-recover entry in settings.
2. Review every affected Bot computer, not just the selected Bot.
3. Finish running tasks and save unsaved application content.
4. Confirm that content is saved, then explicitly confirm the whole-environment restart.
5. Wait for the result and reconnect the computers you need.

Recovery restarts shared Linux and closes all Bot computers and their applications. Saved files, preferences, and conversations remain. Unsaved application work can be lost, and some sites may require signing in again.

## Unconfirmed recovery

Verify the current recovery result first. Closing the dialog does not withdraw a submitted restart, and reopening does not automatically shut down again. Canceling an unexecuted recovery applies only before the relevant action has run.

New tasks and computer actions can be held during recovery while drafts remain editable and retained history/files stay readable. Existing schedules and queues remain governed by their saved settings. Uncertain operations are not automatically replayed.

After recovery, review [Schedules](schedules.md), recent firings, browser tabs, and unconfirmed work. Verification should come before repeated execution.

Runtime recovery is not restoration from a complete backup and cannot recover permanently deleted originals.
