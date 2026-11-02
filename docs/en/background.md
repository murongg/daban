# Background work and long-running processes

[User guide](README.md) · [简体中文](../zh-CN/background.md)

The local backend runs separately from the client window. Some work can continue after the window closes; it is not thereby running in the cloud.

## What can continue

Started Linux tasks and long commands can continue in their existing environment. The local backend manages [Schedules](schedules.md) under their execution requirements.

The computer must remain powered on and awake, with the backend and required network available. Closing a laptop lid, sleep, shutdown, or disconnection can interrupt work. Native desktop control depends on the client and temporary authorization; quitting does not leave ongoing permission to control it.

## Long installations, builds, or scripts

1. Specify the task and output and ask the Bot to use suitable process tools.
2. Retain the original process identity and inspect its state, logs, and exit result instead of starting the same command again.
3. Check the exit state and actual output files or installed version.
4. To stop, identify the process or task and verify cancellation.

Example: “This build may take a while; start it once, poll that process, and verify its output.” These programmatic process tools are Linux capabilities, not equivalent tools in Windows native mode.

## Navigating and finishing

Switching Bots, closing a panel, or hiding a window does not stop the model task. Stopping a task does not necessarily undo a started system process or external effect; inspect actual state.

When a Bot is busy, wait, stop it, or handle its current request. Do not assume arbitrary additional messages enter a general background queue. Groups and schedules have their own waiting states.

Quitting stops discovering new client desktop notifications. Reopen conversations, [Inbox](inbox.md), or relevant process records to verify outcomes. Observe uncertain or interrupted work before retrying.
