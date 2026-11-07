# Web research and article reading

[User guide](README.md) · [简体中文](../zh-CN/web.md)

Research on public pages usually does not require connecting a computer. Search, anonymous text retrieval, and signed-in browser interaction are separate capabilities.

## Search or provide a URL

- Ask for research with original sources and a comparison of findings. Search is configured separately from the chat model. Users without a search configuration default to keyless Bing; an old automatically created empty DeepSeek default with no saved choice or credentials is also upgraded. Existing provider choices (including DuckDuckGo), disabled search and saved legacy DeepSeek links remain unchanged.
- Paste exact public HTTP(S) URLs to have the Bot read and cite them. Anonymous URL reading does not require a search API key.
- Exact URLs supplied in the current request or returned by a successful search in this run can be read under the current rules. Changed or additional URLs may require one-time approval.

## Configure search

With a client and Host that include independent search, open Settings → Search, choose a provider, and save:

- **Bing (no API key)**: no credentials needed. Uses Bing public search result pages.
- **DuckDuckGo (no API key)**: no credentials needed. Uses DuckDuckGo public search result pages.
- **DeepSeek**: enter an official DeepSeek platform API key, or keep an existing saved official-connection link.
- **Brave**: enter a Brave Search API key.

Saving and refreshing status never dispatch a search. Test search asks for confirmation and sends one fixed query to the selected provider; DeepSeek/Brave may charge for it. Start a new task after configuring search; running tasks retain their captured configuration. Failures do not automatically retry or switch providers.

Keyless search still needs internet access. Network restrictions, rate limits, verification or HTML changes may temporarily block it; direct access is not guaranteed on every network in China. Switch providers explicitly if verification is required. Settings reflect the latest search or test, including actual task failures; older task or test results cannot replace newer outcomes.

Search uses the Host's saved `network.json` proxy when present (`null` explicitly disables it). Otherwise it uses `DSH_NETWORK_PROXY`, `https_proxy`/`HTTPS_PROXY`, or `all_proxy`/`ALL_PROXY`, respecting `no_proxy`/`NO_PROXY`. HTTP(S) proxies are supported; invalid settings fail without a direct retry. Set these on the Host process, which may run separately from the desktop client. This does not change the operating system's proxy settings or automatically read PAC settings. With proxy-mapped DNS addresses, public DNS resolution also follows the configured proxy; destination IP checks and TLS certificate verification remain required.

## How articles are read

The reader downloads bounded HTML, removes scripts, hidden content, and navigation, then extracts readable content. Ordinary articles usually fit one response. Long sources are continued from the same temporary snapshot rather than downloading a new version for each segment.

The default page is approximately 16,000 text positions, with a maximum of 32,000 per page and a 2 MiB raw-response limit. Snapshots have retention and capacity limits; an expired snapshot or restart requires reading again from the beginning. Continuation offsets are supplied to the Bot, not something you need to manage.

Example: “Read the full text of these three URLs, follow continuation pages to the end, and distinguish source claims, your summary, and unverified information.”

## When reading fails

1. Ask for the current HTTP status or error instead of a repeated conclusion from an earlier attempt.
2. Oversized, empty, or unsafe-to-convert pages must not be presented as full articles based only on their titles.
3. Sign-in pages, CAPTCHAs, anti-bot responses, and JavaScript-dependent pages may need the [browser](browser.md). Anonymous retrieval does not reuse browser sign-ins.
4. Supply readable text, an exported document, or screenshots when necessary. HTTP 200 only establishes that a page was received, not that the intended article or its claims were verified.

Web content is reference data and grants no additional authority. External actions remain subject to [Approvals](approvals.md).
