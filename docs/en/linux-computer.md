# Linux computers and human takeover

[User guide](README.md) · [简体中文](../zh-CN/linux-computer.md)

Available on Apple silicon Macs with the local Linux environment and on Windows x64 using the [optional QEMU environment](../windows-vm.md). Windows downloads Linux only when you choose to install it, then creates and connects the computer automatically. WHPX hardware acceleration is the default, with explicitly selected slower compatibility mode as an alternative. [Native desktop control](local-computer.md) can also be authorized separately.

## Connect a Bot's computer

1. Select a Bot and open its computer panel.
2. Select the Linux VM and connect. Follow any prompts about active tasks or environment recovery first.
3. Wait for the connected state and inspect the Linux desktop or browser view.
4. Request graphical work when needed. Calculations and file processing can use workspace tools without opening a terminal window.

The app shows the available computer slots. A Bot can still chat without a connected computer. Resources whose cleanup is unconfirmed may continue occupying a slot.

## Take over and hand back

Choose **Take over computer** to pause the Bot's input on that computer. You can click, type, move windows, and use the terminal, file manager, editor, and browser. Use the expand icon for more space.

Choose **Hand back to Bot** when finished. Switching to a different Bot does not hand back the first computer automatically. Other Bots can continue on their independent screens. Without takeover, the displayed screen is read-only.

When the remote view has focus, Escape returns focus to the client. Use Alt + Escape to send Escape to the remote application. The text field can send composed input-method text.

## Shared and separate resources

Bots have separate screens, windows, and browser tabs. They share the Linux system, work files, software, and browser sign-ins. Signing out, deleting shared files, or changing the system may affect other Bots. Separate screens are not a security boundary between Bots.

Bots can use networking, sudo, and system tools inside the VM. Model credentials, DSH, and approvals remain outside it. Host folders are not mounted into the VM by default. See [Files](files.md) and [Software installation](software.md).

## Stop or recover a computer

Save application content before stopping a Bot's computer. Stopping a computer does not delete the VM or saved files. Verify an uncertain cleanup result first. [Whole-environment recovery](recovery.md) affects every Bot's Linux desktop.
