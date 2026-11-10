# Privacy, data scope, and permissions

[User guide](README.md) · [简体中文](../zh-CN/privacy.md)

Daban currently runs locally with model connections you choose; a hosted Daban cloud machine is not required. Local storage does not mean content never leaves the computer. Relevant input is sent to configured remote models or external services when used.

## Where data goes

| Material | Scope |
| --- | --- |
| Conversations, selected documents, images, and tool results | Included in model requests as needed for the task |
| Native desktop screenshots | Can include real primary-display applications and content, sent to the authorized model |
| Model keys, DSH, and approvals | Kept in the local backend outside the VM, not supplied as ordinary VM files |
| Public web retrieval | Anonymous access without shared-browser login cookies |
| Browser interaction | Uses the shared Linux browser or the real native application's state |
| MCP arguments and results | Processed by the selected external service and relevant model |

Keep passwords, API keys, and tokens out of roles, memory, skills, and ordinary chat. Use dedicated credential forms. Review exports before sharing business material.

## Computer permissions

Linux Bots can administer the VM, including networking, sudo, software, and files. Host folders are not mounted by default. Bots share its system, files, and sign-ins; separate screens do not isolate them securely from each other.

Native desktop control operates the current user's real computer. On macOS and Linux, selecting [Full access](approvals.md) also lets task commands run directly on the host with the current account's permissions, including its file and network access. Administrator, secure-desktop, and other protected interfaces require their own system permissions.

## Authorization changes

- VM command approval normally applies to one specific operation.
- Native authorization is bound to the Bot, model, and control session. Disconnecting, quitting, or configuration changes can invalidate it.
- External-tool selection is per Bot and current catalog, with actual calls still requiring approval.
- Importing, copying, or restoring an archive does not automatically renew all old tool or computer permissions.

## Cleanup and retention

Clearing current preferences does not erase old conversations or retained versions. Archiving is not permanent deletion. Purging attachments can break old references. Workspace JSON is not a complete database, original-file, or VM backup; see [Data preservation](workspace-export.md).

Do not assume built-in human multi-account isolation, mobile synchronization, or automatic cloud backup. Bot names, sidebar sections, and independent screens are not sufficient security boundaries for separate identities or sensitive work.
