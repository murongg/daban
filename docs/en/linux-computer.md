# Linux computers and human takeover

[User guide](README.md) · [简体中文](../zh-CN/linux-computer.md)

Available on Apple silicon Macs with the local Linux environment and on Windows x64 using the [optional QEMU environment](../windows-vm.md). Windows downloads Linux only when you choose to install it, then creates and connects the computer automatically. WHPX hardware acceleration is the default, with explicitly selected slower compatibility mode as an alternative. [Native desktop control](local-computer.md) can also be authorized separately.

## When Linux starts

Ordinary conversations keep using the native background service after Linux is installed. Opening the app, chatting, searching, accessing native task files, opening the computer panel, and checking connection status do not start a stopped VM.

Upgrades from older installations whose background data still lives inside the VM complete the existing migration first, then hand off to native execution when idle. An empty native database never replaces retained guest data.

Linux starts when a Bot invokes a Linux shell, process, or Linux file tool, prepares a skill explicitly for Linux, parses a PDF or Office attachment through Linux, or it gets access to a graphical Linux desktop. Initial installation and an explicit environment recovery can also start Linux. An environment that is not installed must first be installed through the interface; ordinary chat never downloads it automatically.

Native and Linux task directories remain separate. Only captured task inputs are copied to Linux by default. Other files require explicit transfers, and outputs brought back into the native task appear in the files panel. Commands retain their approval and execution receipts; uncertain effects are never replayed automatically. Closing the client neither cancels accepted background tasks nor shuts down the VM automatically.

## Connect a Bot's computer

Ask the Bot to perform the graphical task in Linux. When access is needed, the Bot asks in the conversation and then starts the installed environment. **Full access** skips the confirmation. Use the Linux VM tab in the computer panel to view the connected desktop or browser. Calculations and file processing can still use workspace tools without opening a desktop.

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
