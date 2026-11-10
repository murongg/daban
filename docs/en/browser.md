# Browser interaction and shared sign-ins

[User guide](README.md) · [简体中文](../zh-CN/browser.md)

The browser panel is for actual website interaction. The standalone browser needs neither Linux nor native screen-recording or accessibility permissions; text models can use its page-structure tools. Prefer [anonymous web reading](web.md) for public articles.

## Standalone browser

Ask the Bot in chat to use the browser. It requests access there when needed; **Full access** skips that confirmation. The desktop client uses a built-in Chromium view and a dedicated Daban profile, separate from your personal browser. Open the browser panel to watch or take over for sign-in and verification, then choose **Hand back to Bot**.

Each Bot owns its tabs, while the Daban workspace shares standalone-browser sign-ins. Closing the panel does not disconnect the browser. For a browser opened for a task, access ends when the task finishes. The browser profile and sign-ins are retained. Previous URLs await recovery and are not automatically revisited. Standalone, Linux and personal Chrome profiles are separate.

While you have control, the webpage receives mouse input, keyboard input, IME composition and text selection directly. AI control shows a read-only preview. App dialogs, a hidden panel and handback remove the interactive native view. Complete CAPTCHAs, sign-in and verification codes yourself, then explicitly hand control back. The Bot does not solve CAPTCHAs. Some websites restrict embedded browsers or require extra verification; not every sign-in flow is supported.

Switching from the older dedicated Chrome profile requires signing in again the first time. The old profile remains on disk, and existing tab records remain suspended until you reopen them. Direct human downloads use the system save dialog; Bot downloads still go into the managed task directory.

The built-in browser supports the macOS and Windows desktop clients and requires the client to keep running. Quitting Daban disconnects this browser capability; closing its panel does not. The Linux execution service retains headless Chromium and its existing takeover panel; Linux background tasks continue in their independent service.

The standalone browser supports task-file uploads, downloads and text processing. For example, ask the Bot to download a signed-in CSV report, read and summarize it, write an output and upload it to your requested destination. Each transfer is limited to 5 MB. Downloads go into the current task directory and never overwrite an existing file. Relative paths and `/workspace` address the current task; `/shared` provides read-only access to the shared workspace. Arbitrary host files are unavailable. Native mode exposes no shell or process tools; programmatic PDF/Office extraction still requires the Linux workspace. Transfers to a Linux workspace need an executor advertising browser file support; older executors retain page interaction without transfer tools.

Text models use page-structure tools. Image-capable models can also capture the browser and click, type, scroll or drag by coordinates for canvas and other controls. Each operation is bound to its Bot, tab and control lease. Takeover, navigation, failures and uncertain results require a fresh observation; clicks and submissions are never automatically replayed. Passwords, verification codes, page dialogs and ordinary file pickers still require human handling. Coordinate input cannot fill passwords or verification codes either. Model screenshots mask password and verification-code inputs; the human takeover view remains interactive without that mask.

Webpages use Electron and automation reuses open-source Playwright. The standalone browser accesses public websites and retains private-network and local-service restrictions; native desktop authorization is a separate capability. Recognized visible CAPTCHA controls block automation. Take over for other verification challenges as well.

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
