# Getting started

[User guide](README.md) · [简体中文](../zh-CN/getting-started.md)

Daban is a local AI workspace. Configure a model, then create a Bot. Ordinary conversation does not require a connected computer.

## What you need

| Mode | Current support | Use it for |
| --- | --- | --- |
| Apple silicon Mac with a Linux VM | Independent Linux desktops, browser, files, and command tools | Multiple Bots working separately with shared files and browser sign-ins |
| Native macOS desktop (current Mac packages target Apple silicon) | The current user's primary display | Real Mac applications |
| Native Windows x64 desktop | The current user's primary display | Real Windows applications |
| Windows x64 + QEMU/WHPX | Independent Linux desktops, browser, files and command tools | Download and install Linux when needed from the computer panel |

Use a complete desktop package supplied by the maintainer and an API key from a model provider. The provider bills your API usage. Packaged clients include the background service and DSH; Docker, Node.js, and DSH do not need separate installation. A source checkout alone is not a complete desktop distribution.

## First launch

1. On Mac, put the application in a stable location before opening it. On Windows, extract the entire portable package and run `Daban.exe`; do not copy the executable on its own.
2. Choose Simplified Chinese or English.
3. Let Daban download and cache its core runtime components. No VM is needed to start chatting. You can pause and resume this download. Install Linux later if you need an independent computer.
4. Select a provider, enter its API key, and select or enter a model. Verify and save, then choose **Start using Daban**. See [Models & providers](models.md).
5. Add a companion from the [Bot gallery](gallery.md), or [create a Bot](bots.md). A new workspace contains no sample conversations or test Bots.
6. Send a first task, such as: “Turn the following meeting notes into decisions and action items.”

## Connect a computer when needed

Open the Bot's computer panel and choose a [Linux VM](linux-computer.md) or your [native desktop](local-computer.md). Computer operation requires the relevant capabilities and authorization. Chat, writing, and some workspace tools work without a graphical desktop.

## Everyday operation

- Open the [Inbox](inbox.md) for questions and approval requests.
- Store preferences in [Memory](memory.md) and reference material in [Knowledge](knowledge.md).
- Closing a window, quitting the application, and putting the computer to sleep are different actions. Background tasks may continue, but quitting revokes native desktop authorization. Sleep, shutdown, or loss of connectivity can interrupt work.
- Hosted cloud computers, a mobile client, and cross-device synchronization are not currently provided. The execution computer must remain available.

Start with [Troubleshooting](troubleshooting.md) when something goes wrong. Preserve existing data instead of deleting the VM or user directory as a first step.

## Optional Linux computer

The client prepares and caches the core Agent components on first use. Configure a model to start chatting; no VM is required. On Apple silicon Macs, add Linux later from the computer panel or runtime settings. Lima tools, the Linux executor, and the system image download only when you choose to install Linux. Downloads support pause and resume, and verified caches and existing installations are reused. Reserve 40 GB of free disk space for the first Mac Linux installation. The complete Windows package bundles QEMU and Debian for one-click installation. Enabling hardware acceleration may require Windows authorization and a restart; explicitly choosing slower compatibility mode avoids that restart. See [Windows installation and advanced connections](../windows-vm.md).
