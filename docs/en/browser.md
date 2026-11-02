# Browser interaction and shared sign-ins

[User guide](README.md) · [简体中文](../zh-CN/browser.md)

The Linux browser panel is for actual website interaction. Prefer [anonymous web reading](web.md) for public articles without connecting a computer.

## Open and take over

1. Connect the Bot's [Linux computer](linux-computer.md).
2. Select the browser view in its computer panel.
3. Take over to enter URLs, navigate back or forward, reload, create and close tabs, and interact with pages.
4. Hand back when finished so the Bot can continue.

Bots can use page structure and browser tools as well as desktop observation. Website work does not always require screenshot coordinates.

## Shared sign-ins

Take over to sign in, then hand back. Bots manage their own pages and tabs, but share browser sign-in state in the common environment. Signing out or changing account state in one page may affect others.

This is not the host's Safari, Chrome, or Edge profile, and it does not automatically migrate to another device. Use [native desktop mode](local-computer.md) to interact with the real host browser.

## Dialogs, uploads, and downloads

Watch for page dialogs, new windows, file selection, and downloads. Uploads send the selected material to the destination website. Check actual downloaded content in [Files](files.md). Take over for steps that need human handling, such as sign-in, CAPTCHAs, or payment.

If an operation is unconfirmed, inspect its result or the current page first. Do not repeat a submission, payment, or upload merely because its acknowledgement was not visible.

## Restored pages

After a restart or recovery, previous tabs may await recovery instead of automatically revisiting all historical URLs. Reopen a page when needed. A previously working sign-in is not a guarantee that a website will keep the session indefinitely.

Avoid mixing identities that need strict isolation in the shared browser. See [Privacy and permissions](privacy.md).
