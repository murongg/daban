# Approvals, questions, and risk assessment

[User guide](README.md) · [简体中文](../zh-CN/approvals.md)

Review request cards in the conversation or **Inbox**. Approval applies to the specific operation shown, not permanent authority for the Bot.

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
