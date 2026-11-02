# Install software in Linux

[User guide](README.md) · [简体中文](../zh-CN/software.md)

This guide applies to the Linux VM. Software installed in the shared Linux system can be used by other Bots; it is not installed on your Mac or Windows host.

## Ask a Bot to install

1. Specify the software, purpose, and scope: “Install this CLI in the shared Linux environment and show the proposed installation first.”
2. The Bot may use the software installation flow or VM command/process tools. A software plan or command approval appears when required.
3. Review the source, package or command, version, dependencies, destination, and scope, then approve that operation.
4. Wait for the actual installation result in execution records. Approval means permission to execute, not successful installation.
5. Ask for a version check or application launch. If sharing matters, have another Bot verify the installation is accessible too.

## npm, Codex, and other tools

Node/npm tools and CLIs such as Codex can be installed inside the VM, subject to networking, architecture, licensing, and their own requirements. Application sign-in and model API configuration are separate steps; installation does not establish an authenticated account.

For all Bots to use a tool, request a shared installation location and a command-path check. Local npm dependencies inside a project are not the same as a global system command.

## Slow or uncertain installations

Long operations may continue as background processes. Ask the Bot to inspect the original process and installation record instead of starting another installation because output is temporarily quiet. Check network, repository, dependency, or permission errors before choosing a repair.

Bots have full system privileges, including sudo, inside the VM, while [Approvals](approvals.md) still govern risky actions. Upgrades, removals, and system changes may affect other Bots despite their separate desktops.

Installing real Mac or Windows software through native mode is a host action and does not have the Linux isolation or sharing described here.
