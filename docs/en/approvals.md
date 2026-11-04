# Approvals, questions, and risk assessment

[User guide](README.md) · [简体中文](../zh-CN/approvals.md)

Use **Approval mode** below the message input, and review request cards in the conversation or **Inbox**. Manual approval applies to the specific operation shown, not permanent authority for the Bot.

## Conversation approval modes

Updated clients and services (protocol 44 onward) offer three modes for the current Bot's current private conversation:

| Mode | Behavior |
| --- | --- |
| Request approval | Ask before every Linux command, public webpage read, external tool call, or software installation |
| Approve for me (default) | Retain risk review: routine Linux operations run automatically; risky or uncertain operations, unauthorized webpages, and external tools ask |
| Full access | Automatically approve enabled tools through the existing approval gates; records identify automatic policy decisions |

The choice survives a local reload. A new conversation returns to the default. Changes apply to future task starts and continuations. Running tasks, messages inserted into those tasks, and sends awaiting receipt reconciliation retain their captured policy. Questions still require human answers.

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

## Exact Bot rules

Open **Settings → Approval rules**, choose a Bot, or select **Create an exact rule from this request** on an approval card. A one-time answer never creates a rule. Saving and previewing rules do not execute tools or approve the current request.

Rules match an exact URL (including its query), complete command SHA-256 and canonical directory, complete MCP connection/catalog/tool/argument identity, or complete installation-plan digest. Arbitrary regular expressions, command prefixes and native desktop selectors are unavailable. Installation rules can only ask or deny. MCP allow requires a separate purpose confirmation and cannot enable disabled tools.

For an MCP call matching an allow rule in auto mode, choose **Allow once** to approve only that request, or **Confirm purpose for this task and allow** to authorize identical calls in the current task's current human turn. Saving a rule grants neither permission. Purpose confirmation is recorded by the Host with the exact connection, catalog, tool, arguments, rule revision, task and human turn. A new task or human turn, changed source/scope, parameters or versions requires fresh confirmation. Retrying the original request reads its receipt; an unknown outcome must never be replayed. Older clients retain one-time approvals and do not offer purpose confirmation.

Deny takes priority over ask and allow, including in full mode. Allow cannot bypass ask mode, uncertain command risk, file boundaries or human takeover. Interactive and scheduled tasks use separate rule sources. Rules can be disabled, deleted or expired; changing the policy invalidates waiting decisions before dispatch. After an uncertain save, inspect its receipt before retrying the same request. Conflicts retain the draft and require an explicit current-revision choice.

New records show the reason, matched rule revision and checked exact resource. Older records report that no reason was recorded. A service without the rule capability disables editing. This release supports Bot scope; project scope awaits the shared Projects service.
