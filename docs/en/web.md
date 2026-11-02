# Web research and article reading

[User guide](README.md) · [简体中文](../zh-CN/web.md)

Research on public pages usually does not require connecting a computer. Search, anonymous text retrieval, and signed-in browser interaction are separate capabilities.

## Search or provide a URL

- Ask for research with original sources and a comparison of findings. Built-in search currently uses a configured official DeepSeek connection. A connection to another model provider alone does not enable this search service.
- Paste exact public HTTP(S) URLs to have the Bot read and cite them. Anonymous URL reading does not require the DeepSeek search connection.
- Exact URLs supplied in the current request or returned by a successful search in this run can be read under the current rules. Changed or additional URLs may require one-time approval.

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
