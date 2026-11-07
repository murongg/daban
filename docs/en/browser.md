# Browser interaction and shared sign-ins

[User guide](README.md) · [简体中文](../zh-CN/browser.md)

The browser panel is for actual website interaction. The standalone browser needs neither Linux nor native screen-recording or accessibility permissions; text models can use its page-structure tools. Prefer [anonymous web reading](web.md) for public articles.

## Standalone browser

1. Choose **Browser** above the conversation, or in the computer panel.
2. Review the account and page-content scope, then choose **Open browser**. The Agent uses Chrome, Edge or an installed Chromium with a dedicated Daban profile; it does not read your personal browser profile.
3. You have control when it opens. Enter a URL and complete sign-in or verification in the panel.
4. Choose **Hand back to Bot**, then request a website task. The Bot uses the current sign-in to read pages, click and fill forms.

Each Bot owns its tabs, while the Daban workspace shares standalone-browser sign-ins. Closing the panel keeps the browser connected. Disconnect closes that Bot’s tabs and retains the profile. After a backend restart, explicitly reopen and hand back; previous URLs await recovery and are not automatically revisited. Websites may still expire sign-ins.

Standalone, Linux and personal Chrome profiles are separate. Finish the current task and disconnect this Bot’s standalone browser before switching to the desktop or Linux. A running task never switches operation environments because its browser disconnected.

The standalone browser currently offers page reading and interaction, without model upload/download tools or host filesystem access. You can handle page file selection during takeover. Use the Linux browser for workspace file transfers. Private-network and local-service address restrictions remain enforced.

## Open and take over the Linux browser

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
