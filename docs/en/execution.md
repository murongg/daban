# Execution, plans, and stopping

[User guide](README.md) · [简体中文](../zh-CN/execution.md)

Expand execution details above a response to inspect actual tool activity and status. A written plan or a model saying “done” is not sufficient evidence of execution.

## Read the state

- A task can be processing, executing tools, waiting for an answer or approval, waiting for computer handback, completed, failed, or interrupted.
- The task plan describes the current run. An active indicator marks the current step; its completion count refers to that plan.
- Expand tool records for operation details. Commands, URLs, installations, and external tools can have different approval cards.
- A response starting to appear does not establish that every background tool has finished. Check the final state and outputs.

## When input is needed

Answer or approve requests in the current conversation or [Inbox](inbox.md). After human takeover, the Bot waits for handback before continuing the relevant computer actions.

For a generated report, inspect whether input was actually read, calculations ran, a file was produced, and the file can be opened instead of relying only on its written summary.

## Stop a task

Use the stop icon above the composer to request cancellation. Stopping does not undo completed writes, website submissions, installations, or external-service actions. Verify an uncertain operation through its receipt or actual state.

Do not immediately send a duplicate task while cancellation is unconfirmed. Once the original run has ended, describe what remains to do. “Do it again” is not a status check.

## Plans, shared tasks, and schedules

| Feature | Meaning |
| --- | --- |
| Current task plan | Steps for this execution |
| [Shared tasks](tasks.md) | Persistent work records; saving alone does not execute them |
| [Schedules](schedules.md) | Submit work to a specified Bot at a configured time |

Historical execution records do not rerun tools or reuse old approvals. Starting a conversation, stopping a computer, and recovering the environment have different effects. See [Conversations](conversations.md), [Linux computers](linux-computer.md), and [Recovery](recovery.md).
