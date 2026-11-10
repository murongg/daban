# Native Mac and Windows desktops

[User guide](README.md) · [简体中文](../zh-CN/local-computer.md)

Ask the Bot in chat to use an application on your Mac or Windows PC. Use a model that supports images, and name the application and what you want done. The Bot requests access in the conversation and continues the task when you allow it. **Full access** skips this confirmation for the current task.

On macOS, first enable **Accessibility** and **Screen Recording** for Daban in System Settings. The native desktop tab guides you through setup. If macOS asks you to reopen Daban, do so. These system permissions are required in every approval mode.

The Bot can also request the built-in browser or an installed Linux desktop in chat. Neither needs a separate approval in the computer panel. Full access applies to those requests as well.

## Background control

Daban uses the bundled Cua Driver to capture and operate one window of the authorized app. The Bot does not take over the system pointer. It can launch a supported Mac app in the background. On Windows, open the target app before asking the Bot to use it.

The Bot can click supported controls and enter text in supported macOS fields. A window can be covered by another app, but it must not be minimized, hidden or closed. Some controls, scrolling, dragging and shortcuts are unavailable in the background. Daban does not switch to foreground control when a background action fails.

Background clicks briefly show the colored Bot pointer. It glides from the previous click when the clicks are in the same window on the same display.

## Pause and disconnect

- Pause, resume or disconnect from the native desktop tab while a task is using it.
- For emergency pause, use **Ctrl + Option + Esc** on Mac or **Ctrl + Alt + Esc** on Windows.
- Only one Bot can control a native window at a time. Native window access ends when the task ends or you disconnect.

If system permissions appear enabled but control remains unavailable, see [Troubleshooting](troubleshooting.md).
