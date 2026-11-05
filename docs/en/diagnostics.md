# Runtime diagnostics

[User guide](README.md) · [简体中文](../zh-CN/diagnostics.md)

In Linux mode, open **Settings → Computer & permissions → Runtime** and run diagnostics. Checks help locate problems without restarting Linux or rerunning tasks for you.

## Run checks

1. Confirm that you are using the complete desktop client rather than a web UI preview.
2. Start checking and wait for individual results.
3. Expand the complete list and prioritize unavailable or degraded items.
4. Check again after repairing the relevant connection or service. One timeout does not establish data loss.

## Coverage

Checks can cover local configuration, VM, client channel, backend, DSH files, model settings, Bot profiles, knowledge, attachments, approvals, schedules, groups, skills, external-tool settings, computer records, and desktop dependencies.

| State | Meaning and next step |
| --- | --- |
| Ready | This check passed; verify actual task behavior separately |
| Needs attention | Inspect affected records or resources, such as unconfirmed computer cleanup |
| Unconfigured/not ready | Complete configuration or reconnect first |
| Unsupported/unchecked | The current version does not provide a complete conclusion |
| Timeout | Retry after connectivity recovers; content is not thereby proven deleted |

Model diagnostics mainly inspect saved configuration, not successful inference. Use [model testing or connection checks](models.md) for API connectivity. Desktop dependency checks do not prove every graphical application works.

## Report a problem

Include the steps, platform, version, affected check, and error. Hide keys, private content, and sensitive URLs in screenshots. The page is neither a complete log nor a full data backup.

Reconnect, whole-environment recovery, and reinstallation have different effects. Start with [Troubleshooting](troubleshooting.md) and [Recovery](recovery.md).

## Check explicit task requirements

Choose **Check required capabilities** below the composer in a single Bot conversation to see the current requirements summary. Use **Adjust checks** to select model declarations, a minimum input capacity, search, Office parsing, or computer access, then choose **Check selected requirements**. MCP options are read only when you open their selector and include only the exact tools authorized and selected for this Bot on the target Host. The catalog is cached; preflight does not connect to the external MCP service. Ordinary sending does not require a preflight.

The main view shows the results, missing or unconfirmed conditions, and relevant settings actions. Expand **Diagnostic details** to see fact sources and sample times. Saved model configuration does not prove a successful inference call. The input capacity compares the configured context window minus maximum output and does not estimate the complete input for this task. Preflight does not request permissions, take computer control, start a VM, sign in, or repair the environment. Sending still performs the original authorization checks.

A report is marked stale after 30 seconds and expires after five minutes. Changing requirements, models, attachment types, Bot, or Host invalidates the current view. Canceling the wait or closing the panel does not stop background tasks.

In **Diagnostic details**, choose **Preview diagnostic package** to review the exact allowed JSON. Local download occurs only after **Download this package**, and its bytes must match the preview. Bot, connection, and tool identifiers are replaced with package aliases; the package excludes chat content, files, accounts, addresses, and raw errors. There is no send or upload action. Host restart discards previous reports. Older services without the preflight capability retain the existing environment checks.
