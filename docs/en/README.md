# Daban user guide

[简体中文](../zh-CN/README.md) · [Documentation home](../README.md) · [Project overview](../../README.md)

For a first session, read Getting started, Models & providers, and Conversations and history. Create a Bot when you want an ongoing companion. Later, jump to the feature you need. Each page explains its entry point, operation, scope, and important distinctions.

## Start here

| Feature | Contents |
| --- | --- |
| [Getting started](getting-started.md) | Complete packages, supported platforms, environment and model onboarding |
| [Models & providers](models.md) | Multiple providers/models, testing, listing, and capability matching |
| [Create and manage Bots](bots.md) | Roles, model selection, identity, and data boundaries |
| [Bot gallery](gallery.md) | Create companions from role presets |
| [App updates](updates.md) | Version checks, download progress, installation and task protection |

## Conversations and execution

| Feature | Contents |
| --- | --- |
| [Conversations and history](conversations.md) | Ordinary chats, multiple Bot conversations, drafts, and historical continuation |
| [Context and API usage](context.md) | Compaction, durable memory, caching, and cost boundaries |
| [Attachments](attachments.md) | Text, images, PDF/Office, and retained attachment management |
| [Web research](web.md) | Search, anonymous article reading, paging, and browser differences |
| [Execution](execution.md) | Plans, tool records, states, and stopping |
| [Approvals](approvals.md) | Commands, installations, URLs, and external operations |
| [Background work](background.md) | Windows, background services, long processes, and sleep |

## Computers and files

| Feature | Contents |
| --- | --- |
| [Linux computers](linux-computer.md) | Independent screens, takeover, handback, and shared environment |
| [Native Mac / Windows](local-computer.md) | Primary display, OS permissions, pause, and temporary consent |
| [Browser](browser.md) | Tabs, sign-ins, website interaction, and restored pages |
| [Workspace files](files.md) | Previews, downloads, message input, and shared paths |
| [Software installation](software.md) | Linux applications, npm/CLIs, approval, and actual outcomes |

## Memory, material, and collaboration

| Feature | Contents |
| --- | --- |
| [Work memory](memory.md) | Explicit preferences, revisions, and forgetting scope |
| [Documents and knowledge](knowledge.md) | Imports, originals, text snapshots, and revision restoration |
| [Bot notes](notes.md) | Individual items, drafts, states, and trash |
| [Shared tasks](tasks.md) | Work lists, boards, progress, and the distinction from execution |
| [Task comments](comments.md) | Shared discussion and posting verification |
| [Bot groups](groups.md) | Members, recipients, sequential collaboration, and copying |
| [Schedules](schedules.md) | Timing, zones, enablement, locks, and firing history |
| [Skills](skills.md) | SKILL.md, the shared library, per-Bot enablement, and invocation |
| [External tools](integrations.md) | MCP connections, catalogs, authorization, and receipts |

## Discovery and organization

| Feature | Contents |
| --- | --- |
| [Inbox](inbox.md) | Task questions and approval requests |
| [Desktop notifications](notifications.md) | OS notifications, tests, and per-Bot settings |
| [Sidebar organization](organization.md) | Search, pins, unread markers, and sections |

## Copy, transfer, and preserve

| Feature | Contents |
| --- | --- |
| [Copy a Bot](copy-bot.md) | Create an independent copy within the workspace |
| [Bot import/export](bot-transfer.md) | Selectively transfer roles, preferences, skills, and documents |
| [Workspace export](workspace-export.md) | JSON scope, exclusions, and complete-backup distinctions |
| [Archives](archives.md) | Archive and restore Bots or groups |

## Settings, recovery, and help

| Feature | Contents |
| --- | --- |
| [Settings](settings.md) | Categories, appearance, language, and saving |
| [Environment recovery](recovery.md) | Reconnection, whole-Linux restart, and affected resources |
| [Diagnostics](diagnostics.md) | Checks, limitations, and reporting problems |
| [Privacy and permissions](privacy.md) | Data destinations, sharing boundaries, and authorization lifetime |
| [Shortcuts and icons](shortcuts.md) | Messages, search, remote input, and emergency pause |
| [Troubleshooting](troubleshooting.md) | Models, web reading, attachments, computers, and disk use |

## Platform differences

| Capability | Linux mode on Apple silicon Mac | Native Mac / Windows mode |
| --- | --- | --- |
| Chat, Bots, memory, text documents, notes, and shared tasks | Requires relevant backend/model support | Requires relevant backend/model support |
| Independent Linux screens for multiple Bots | Available within computer slots | Not provided; one Bot controls the native desktop at a time |
| Linux commands, long processes, and shared software | Supported | Equivalent programmatic tools are not provided |
| PDF / Office text extraction | Supported | Mac needs available Linux parsing; currently unavailable in Windows native mode |
| Real host applications | Switch to and authorize native control | Primary display and current-user privileges |

Availability follows the actual client and backend. Hosted cloud machines, a mobile client, and live cross-device synchronization are not provided. Saving a work item does not execute it; exporting JSON is not a complete backup. See the [developer guide (Chinese)](../development.md) for source work.
