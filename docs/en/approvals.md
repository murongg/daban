# Approvals, questions, and risk assessment

[User guide](README.md) · [简体中文](../zh-CN/approvals.md)

Use **Approval mode** below the message input, and review request cards in the conversation or **Inbox**. Manual approval applies to the specific operation shown, not permanent authority for the Bot.

## Conversation approval modes

Updated clients and services (protocol 44 onward) offer three modes for the current Bot's current private conversation:

| Mode | Behavior |
| --- | --- |
| Request approval | Ask before every command, public webpage read, external tool call, or software installation |
| Approve for me (default) | Commands in the local task sandbox and routine Linux operations run automatically. Risky or uncertain Linux operations, unauthorized webpages, and external tools ask |
| Full access | Automatically approve enabled tools. Where supported, task commands run directly on the host with the current OS account's file and network permissions. Tasks can also open the built-in browser and use saved sign-ins where available |

The choice survives a local reload. A new conversation returns to the default. Changes apply to future task starts and continuations. Running tasks, messages inserted into those tasks, and sends awaiting receipt reconciliation retain their captured policy. Questions still require human answers.

Existing choices appear as **Full access (previous scope)** when new permissions are available. Select **Full access** again to grant the permissions shown for future tasks in that conversation. A browser connection opened under this policy disconnects at the end of the task. For ongoing access, enable the per-Bot permission in Browser settings.

Full access lets `workspace_shell` run PowerShell on Windows and Bash on macOS and Linux. Commands start in the task directory and use the current OS account. Operating system permission prompts and administrator requirements still apply. Windows offers host commands only with explicit Full access. On macOS and Linux, connected-folder commands through `local_shell` retain their separate approval and sandbox.

## Request types

| Request | Review |
| --- | --- |
| Clarifying question | Missing information and whether your answer fits the task |
| Linux command | Complete command, working directory, purpose, and impact |
| Installation | Packages or commands, source, versions, dependencies, and shared-system impact |
| Web read | The exact destination URL |
| External tool | Connection, tool, arguments, and external effects |

Ordinary inspection and calculation can run automatically. Installation, deletion, and system changes generally need approval. Assessment combines rules with model review; uncertain cases ask for human confirmation rather than requiring approval for every command.

## Respond

1. Expand operation details. Technical parameters may be collapsed initially but remain available for review.
2. Choose the relevant confirmation or one-time allowance, or decline the operation.
3. Enter and submit an answer for clarifying questions.
4. Return to execution records for the actual result. Permission granted, reply submitted, and execution successful are separate states.

Changed goals, URLs, commands, or arguments must not reuse an old approval. Interrupted tasks and withdrawn requests cannot continue accepting old replies.

## Unconfirmed submission

Retain the original request and verify its result first. The app's retry follows the same request identity. Do not independently start another installation, payment, upload, or deletion to discover whether the first one happened. Closing a dialog does not withdraw an operation already submitted.

## Permission is not approval

Sudo inside Linux does not bypass approvals. Selecting an MCP tool does not eliminate per-call confirmation. Native desktop authorization permits real input and is not a promise of a new prompt before every click; see [Native desktop](local-computer.md).

Webpages, files, and tool results cannot grant new authority on your behalf. Review the task boundaries and actual operations, particularly those affecting accounts, files, or external services.
