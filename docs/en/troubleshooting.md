# Troubleshooting

[User guide](README.md) · [简体中文](../zh-CN/troubleshooting.md)

Preserve existing conversations, files, and settings before diagnosis. An empty view, timeout, or unconfirmed result does not prove backend data was deleted.

## Cannot start a conversation

1. Use the complete desktop client, not a web UI preview.
2. Complete [model setup](models.md) and check the key, base URL, protocol, and model ID.
3. Test actual inference. Listing success is not inference success; balance, rate limits, model permissions, and networking can cause failure.
4. Handle any active task or pending approval first.

## Search asks for DeepSeek despite another configured model

Other providers work for ordinary conversation, but built-in search currently needs an official DeepSeek connection. Exact public URLs can be read directly, or use an appropriate browser task. See [Web research](web.md).

## A page contains only a title or appears truncated

Ask for a fresh read of the current result. Ordinary articles are extracted before paging; long sources should continue from the same snapshot. Oversized downloads, login, CAPTCHAs, anti-bot responses, and JavaScript pages are not guaranteed to work anonymously. Use a browser or supply original text when needed. HTTP 200 does not prove the intended article was retrieved.

## Images, PDF, or Office files fail

Check model image support for images. PDF/Office needs Linux parsing; scans need OCR and encrypted files need decryption. Check format, size, the four-attachment limit, and upload completion. See [Attachments](attachments.md).

## A computer cannot connect or accept input

Confirm Linux versus native mode. For Linux, check runtime health, available slots, unconfirmed cleanup, and active tasks. Take over before interacting with a read-only screen.

For native control, check the vision model, OS screen/input permissions, temporary authorization, primary display, unlocked state, and pause state. Replacing a temporarily signed Mac development package can invalidate old permission entries. Review the current app in system settings, authorize again as required, and reopen it; do not disable system protections as a repair.

## Saving or an external action is unconfirmed

Verify the original request and actual state first. Do not create another Bot, repeat installation, or resubmit a website form. Closing a dialog does not withdraw a submitted request.

## Schedules or notifications seem missing

Check enablement, time, time zone, Bot availability, wake/power state, backend, and network. Inspect recent firings. Locking is not pausing, and missed occurrences are not necessarily replayed one by one.

OS permissions and focus modes separately affect notifications. Fully quitting stops discovering new notices. Check conversations and Inbox for actual results.

## Missing files or high disk use

Old file links are not immutable backups. Check Files, attachment management, retained originals, and feature-specific trash. VM disks, originals, and installation caches consume space. Attachment quota cleanup does not necessarily shrink database files immediately.

Preserve the active VM, browser profile, user directory, and only remaining backup. [Workspace export](workspace-export.md) does not contain complete copies of them.

## Further diagnosis

In Linux mode, run [Diagnostics](diagnostics.md) before considering [Recovery](recovery.md). Report platform, version, reproduction steps, and the exact error without sharing API keys, complete sensitive exports, or unredacted private screens.
