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
