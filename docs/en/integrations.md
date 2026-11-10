# External tools and MCP connections

[User guide](README.md) · [简体中文](../zh-CN/integrations.md)

Manage accounts and MCP connections in **Settings → External tools** without choosing a Bot. Enable tools under the target Bot’s **Capabilities → External tools**.

## Add and check

1. In Settings, choose **Custom remote MCP** (or **Add connection** on an older Host), then enter a name and service URL.
2. Enter a Bearer token if authentication is required.
3. Save and check the connection to load its current tool catalog.
4. Under the target Bot’s Capabilities → External tools, open the connection’s Tools and permissions, choose tools, and save.

Current support is public HTTPS Streamable HTTP. Launching local programs, stdio, and custom request headers are not provided. A normal model API endpoint is not an MCP service URL.

Choose **Connect Linear, Sentry, Todoist, Miro, or monday.com** to authorize in the system browser. Connections use the app name and number duplicates. With existing accounts, expand **Add an app** first. monday.com custom clients require administrator approval on the official page; pending approval does not mean the account is connected. After authorization, check the connection, then select and enable tools separately. **Notion connections are not available yet.** OAuth needs the local Electron/Host callback; remote targets can inspect metadata and use custom Bearer, but cannot launch this OAuth flow. Older Hosts support custom MCP; app account connections require an updated Host.

OAuth credentials stay in the Host's private store. A normal refresh retains the reviewed connection revision; a new authorization or scope change requires a new tool review. Cancellation affects only that authorization attempt. Disconnect clears local tokens and disables old bindings; provider-side revocation is reported as unconfirmed. Uncertain token exchanges, refreshes, and already-dispatched tool calls are not automatically replayed. Closing the window leaves accepted tasks running.

Saved URLs and tokens are not fully echoed in the editor. Follow its blank-to-retain instructions; explicitly select token clearing when needed. Recheck authorization after destination or credential changes.

Multiple Bots can use a new connection, with separate tool selections and no default access. You can connect more than one account for a service. Existing private connections remain available only to their original Bot, with existing tool grants retained.

## Authorize each Bot

Saving tool selection makes those tools available to new tasks. Each actual call still requires its own approval: inspect the tool, arguments, destination, and effects. A connected service does not automatically expose every tool to every Bot.

Catalog, authorization, or connection-revision changes can invalidate previous selections. Check and review the current catalog, then save enablement again instead of relying on old descriptions.

## Results, receipts, and disabling

Recent calls show the latest 20 calls for the selected Bot and connection, including arguments, results, and receipts. Receipt inspection does not execute the tool again.

Disabling cancels requests not yet dispatched; requests already sent may have taken effect externally. Verify the receipt and service state before retrying an uncertain operation.

Archiving a Bot-owned connection affects only that Bot. Restore it and select/enable tools again when needed. Archiving a shared connection or disconnecting an account disables access for every Bot using it. Settings lists affected Bots before the action. Descriptions and returned data grant no additional authority. Arguments and results can enter external-service and model processing; see [Privacy and permissions](privacy.md).
