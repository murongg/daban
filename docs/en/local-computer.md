# Native Mac and Windows desktops

[User guide](README.md) · [简体中文](../zh-CN/local-computer.md)

Native mode controls your real primary display and applications available to the current user. It is different from an isolated Linux desktop.

## Authorize a connection

1. Select an image-capable model for the Bot and let its current task finish.
2. Open the computer panel and select the native Mac or Windows mode.
3. On macOS, use the system-permissions entry to grant screen recording and accessibility access. OS permissions and the Bot's temporary control authorization are separate.
4. Connect and review the Bot, provider, and model in the consent dialog. Authorization allows observing the primary display, sending screen images to that model service, and using keyboard and mouse input.
5. Specify the application and task. Keep the computer unlocked and awake.

Close or move windows you do not want included in model screenshots. Native mode does not automatically grant administrator privileges.

## Pause, resume, and disconnect

- Return to Daban or choose pause to retain input control yourself.
- Emergency pause: **Ctrl + Option + Esc** on Mac; **Ctrl + Alt + Esc** on Windows.
- Review the state in the panel before explicitly resuming or handing back. Focus changes, screen locking, sleep, and stale observations can also pause actions.
- Disconnecting or fully quitting revokes the session authorization. Confirm again on reconnection. Model or connection changes may also require authorization again.

Only one Bot can use the native desktop at a time. Disconnect the existing session before authorizing another Bot. Other Bots do not receive independent Mac or Windows screens.

## Scope and limits

The Bot can observe, click, type, scroll, and use the Dock, Start menu, and real applications. This mode does not expose a host shell or arbitrary host file tools that bypass the GUI. It does not guarantee control of administrator windows, UAC, the secure desktop, or secondary displays.

Native GUI actions affect real files and signed-in accounts. Do not assume the Linux command-approval mechanism prompts before every native click. Set boundaries for consequential actions and take over when human completion is appropriate.

If OS permissions appear enabled but control remains unavailable, see [Troubleshooting](troubleshooting.md).
