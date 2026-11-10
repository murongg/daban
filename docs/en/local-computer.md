# Native Mac and Windows desktops

[User guide](README.md) · [简体中文](../zh-CN/local-computer.md)

Native mode controls your real computer. On macOS and Windows, choose an open window for background control or use the primary display in the foreground.

## Authorize a connection

1. Select an image-capable model for the Bot and let its current task finish.
2. Open the computer panel and select the native Mac or Windows mode.
3. On macOS, follow the two-step guide: choose **Enable Accessibility**, then **Enable screen recording**, and enable each permission for the current Daban app in System Settings. Daban checks permissions when you return; you can also choose **Check permissions again**. Reopen the app if macOS asks you to. OS permissions and the Bot's temporary control authorization are separate.
4. Connect and select an open window or **Entire primary display (foreground)**. Review the Bot, provider, and model before authorizing actions and screenshots in the selected scope.
5. Specify the application and task. Keep the computer unlocked and awake.

Close or move windows you do not want included in model screenshots. Native mode does not automatically grant administrator privileges.

## Pause, resume, and disconnect

- Choose **Pause control** in Daban. In foreground mode, returning to Daban also pauses control.
- Emergency pause: **Ctrl + Option + Esc** on Mac; **Ctrl + Alt + Esc** on Windows.
- Review the state in the panel before explicitly resuming or handing back. Focus changes, screen locking, sleep, and stale observations can also pause actions.
- Disconnecting or fully quitting revokes the session authorization. Confirm again on reconnection. Model or connection changes may also require authorization again.

Only one Bot can use the native desktop at a time. Disconnect the existing session before authorizing another Bot. Other Bots do not receive independent Mac or Windows screens.

## Scope and limits

Background mode uses the bundled Cua Driver SDK to capture the authorized window and click supported controls through macOS Accessibility or Windows UI Automation. On macOS, the Bot can also insert text into supported editable fields. On Windows, typing requires foreground mode. The Bot can work while other apps cover the window. Minimized, hidden, and closed windows become unavailable. Connect again to authorize another window. Scrolling, dragging, shortcuts, and custom-drawn controls require foreground mode.

Background clicks briefly show a colored Bot pointer over the target window, beneath any windows covering it. The system pointer stays under your control. Pausing or disconnecting clears the Bot pointer.

In foreground mode, the Bot can observe, click, type, scroll, and use the Dock, Start menu, and real applications. This mode does not expose a host shell or arbitrary host file tools that bypass the GUI. It does not guarantee control of administrator windows, UAC, the secure desktop, or secondary displays.

Native GUI actions affect real files and signed-in accounts. Do not assume the Linux command-approval mechanism prompts before every native click. Set boundaries for consequential actions and take over when human completion is appropriate.

If OS permissions appear enabled but control remains unavailable, see [Troubleshooting](troubleshooting.md).
