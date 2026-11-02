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

Ask the Bot to reread current originals when exact figures, quotations, or earlier files matter. Start a new conversation for independent work. Put lasting requirements in [Memory](memory.md) and sources in [Knowledge](knowledge.md).

## Context and output budgets

Review the context window and output limit in [Models](models.md). An excessive value can cause rejection; a small value can constrain work prematurely. Automatic matching is a reference, with the configured service determining actual limits.

## Calls and caching

Responses, some connection checks, model tests, scheduled runs, and model-assisted risk review may consume API usage. Successful webpage retrieval does not make the model's subsequent summary free.

Cache hits depend on the provider's mechanism and request contents. Daban does not guarantee a fixed hit rate or discount. Model changes, role or preference edits, and tool-catalog changes can affect reusable request prefixes. Clearing history or frequently changing connections is not a general cache-improvement method.

Do not assume a complete billing ledger or automatic monthly spending control is available. Check actual billing with your provider, validate short tasks first, and then configure frequent automation.
