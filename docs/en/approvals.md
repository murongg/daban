# Approvals, questions, and risk assessment

[User guide](README.md) · [简体中文](../zh-CN/approvals.md)

Use **Approval mode** below the message input, and review request cards in the conversation or **Inbox**. Manual approval applies to the specific operation shown, not permanent authority for the Bot.

## Conversation approval modes

Updated clients and services (protocol 44 onward) offer three modes for the current Bot's current private conversation:

| Mode | Behavior |
| --- | --- |
| Request approval | Ask before every Linux command, public webpage read, external tool call, or software installation |
| Approve for me (default) | Retain risk review: routine Linux operations run automatically; risky or uncertain operations, unauthorized webpages, and external tools ask |
| Full access | Automatically approve enabled tools through the existing approval gates. Records identify automatic policy decisions. On Daban desktop, tasks can also open the built-in browser and use saved sign-ins |

The choice survives a local reload. A new conversation returns to the default. Changes apply to future task starts and continuations. Running tasks, messages inserted into those tasks, and sends awaiting receipt reconciliation retain their captured policy. Questions still require human answers.

Existing choices appear as **Full access (previous scope)**. Select **Full access** again to let future tasks in that conversation open the built-in browser. A connection opened under this conversation policy disconnects at the end of the task. For ongoing access, enable the per-Bot permission in Browser settings.

These modes control existing approval gates; they do not add approval to each browser or native desktop click. Full access preserves enabled-tool selection, execution and file boundaries, task ownership, human takeover, and request deduplication. It grants no additional host filesystem or shell access and never replays refused or uncertain operations.

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
