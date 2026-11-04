# Context, durable memory, and API usage

[User guide](README.md) · [简体中文](../zh-CN/context.md)

Saved conversations can outlast the amount of text a model can read in one request. Distinguish these forms of context to reduce omissions, repeated instructions, and unnecessary calls.

| Material | Purpose |
| --- | --- |
| Current conversation context | Messages and tool results available for the current exchange |
| Saved history | Retained material for inspection, not necessarily all current model context |
| Work memory | Explicitly saved lasting preferences for later tasks |
| Knowledge library | Durable documents searched and read when needed |

## Long conversations

The context budget depends on the selected model configuration. Long runs may organize or compact earlier context so work can continue. Compaction does not delete visible history and does not automatically create durable memory.

Oversized tool text is trimmed first. If pressure remains, the agent creates a summary while retaining recent original messages. Retention, summary allowance and headroom adapt to model capacity and the configured output budget. Trimming makes no model call; summarization consumes additional usage.

When a model connection, persona or skill change requires a fresh session, the Bot recovers the initial request, an applicable saved compaction checkpoint, task state and budgeted recent records. Omitted or shortened material includes exact read-back references. Starting a new conversation does not automatically restore the previous conversation's context.

You can ask the Bot to find the exact passage containing a reference in an earlier tool output. It can list its saved current or historical tool results, then search and page their visible text within the same Bot and conversation. This does not expose system prompts, private SDK logs or reasoning. Unrecorded content and non-text artifacts require checking their original source again.

Ask the Bot to reread current originals when exact figures, quotations, or earlier files matter. Start a new conversation for independent work. Put lasting requirements in [Memory](memory.md) and sources in [Knowledge](knowledge.md).

## Inspecting context captures

Services that advertise support provide a Context inspector beside task execution records. Read the latest saved capture or select a historical capture. Refresh reads existing records without invoking a model, tools, or compaction. Closing the panel does not stop background work. Unsupported services disable the entry; legacy tasks have no capture, and current settings are never used to reconstruct their historical input.

Every capture is partial evidence. Provider input samples, next-request estimates, and route capacity can describe different moments. SDK system/tool/message composition is also an estimate. These figures are displayed separately from the ten categories of source materials provided by the Host this turn. They are not balanced into a total or presented as billing. Unknown values remain unknown rather than zero or remaining capacity.

Source counts do not prove retention after compaction. Attachment references do not prove their bodies were read, and a skill catalog does not prove full skills were loaded. Role and preference bodies are not returned. Visible source references bind a capture, Bot, and conversation; every paginated read rechecks ownership and only returns previously saved ordinary text. System prompts, reasoning, and private SDK logs are excluded.

Summary and prune boundaries appear only after commitment. Their SDK node identities are not transcript sequence numbers and cannot be used for navigation. At most 20 captures are retained, with further reference and boundary limits; an evicted capture produces an explicit expiration error. Capture failures affect diagnostics only, and previously saved evidence remains historical.

## Context and output budgets

Review the context window and output limit in [Models](models.md). An excessive value can cause rejection; a small value can constrain work prematurely. Automatic matching is a reference, with the configured service determining actual limits.

The current request, tool definitions and images also need room. Reduce the output limit or select a larger window when output consumes almost the entire context capacity. Budgets include estimation, and summaries can omit details; reread exact sources for numbers and quotations. Recovered records do not renew previous approvals or establish the current screen or file state.

## Calls and caching

Responses, some connection checks, model tests, scheduled runs, and model-assisted risk review may consume API usage. Successful webpage retrieval does not make the model's subsequent summary free.

Cache hits depend on the provider's mechanism and request contents. Daban does not guarantee a fixed hit rate or discount. Model changes, role or preference edits, and tool-catalog changes can affect reusable request prefixes. Clearing history or frequently changing connections is not a general cache-improvement method.

Do not assume a complete billing ledger or automatic monthly spending control is available. Check actual billing with your provider, validate short tasks first, and then configure frequent automation.
