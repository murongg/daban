# External tools and MCP connections

[User guide](README.md) · [简体中文](../zh-CN/integrations.md)

Open **Settings → External tools**. MCP connections expose an external service's tools to Bots; they are separate from model-provider connections.

## Add and check

1. Add a connection with a name and service URL.
2. Enter a Bearer token if authentication is required.
3. Save and check the connection to load its current tool catalog.
4. Open tools and permissions, select a Bot and specific tools, enable their use, and save.

Current support is public HTTPS Streamable HTTP. Launching local programs, stdio, OAuth sign-in, and custom request headers are not provided. A normal model API endpoint is not an MCP service URL.

Saved URLs and tokens are not fully echoed in the editor. Follow its blank-to-retain instructions; explicitly select token clearing when needed. Recheck authorization after destination or credential changes.

## Authorize each Bot

Saving tool selection makes those tools available to new tasks. Each actual call still requires its own approval: inspect the tool, arguments, destination, and effects. A connected service does not automatically expose every tool to every Bot.

Catalog, authorization, or connection-revision changes can invalidate previous selections. Check and review the current catalog, then save enablement again instead of relying on old descriptions.

## Results, receipts, and disabling

Recent calls show the latest 20 calls for the selected Bot and connection, including arguments, results, and receipts. Receipt inspection does not execute the tool again.

Disabling cancels requests not yet dispatched; requests already sent may have taken effect externally. Verify the receipt and service state before retrying an uncertain operation.

Archiving a connection disables access for all Bots. Restore it and select/enable tools again when needed. Descriptions and returned data grant no additional authority. Arguments and results can enter external-service and model processing; see [Privacy and permissions](privacy.md).
