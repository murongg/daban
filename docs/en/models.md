# Models & providers

[User guide](README.md) · [简体中文](../zh-CN/models.md)

Open **Settings → Models & providers**. The same setup is available during onboarding.

## Obtain an API key

Use your chosen provider's official console and follow its instructions to enable API access and create a key, then enter it in Daban's dedicated form. Web-chat subscriptions and API credit may be managed separately; check the provider account. Do not send the key to a Bot or include it in a support report.

## Add a connection and models

1. Choose **Add provider**, then a platform preset or a custom connection.
2. Check the API protocol and base URL. Presets fill common defaults; regional, gateway, and account-specific URLs may differ.
3. Enter an API key for this connection. Connections keep separate credentials even when their display names match.
4. Choose **Load model list**, search, and add models. Enter an exact model ID manually if listing is unavailable. The display name is editable.
5. New or changed model IDs trigger automatic context and image-capability matching against models.dev. For existing models, choose **Match model capabilities**. Explicit provider context limits take precedence over the public catalog.
6. Use **Test model** for a real short text request, then verify and save the provider. A successful listing does not prove inference works. Tests and save-time verification may incur small API charges.

Model testing uses a fixed short prompt rather than your conversation and does not automatically save the form. Automatic public-catalog capability matching does not itself invoke a model.

## Choose the protocol

| Connection | Selection and URL |
| --- | --- |
| OpenAI-compatible service | Select the Chat Completions or Responses protocol actually supported by the service |
| Native Claude | Select Claude Messages and enter the service root, without adding `/v1/messages` |
| Native Gemini | Select Gemini GenerateContent; the default base URL includes `/v1beta` |

Presets include OpenAI, Claude, Gemini, Grok, DeepSeek, Qwen, Kimi, Zhipu, MiniMax, Doubao, SiliconFlow, OpenRouter, Hunyuan, Qianfan, Groq, and Together AI. A preset does not mean every platform feature is implemented. Additional authentication schemes such as Azure deployments and AWS Bedrock are not currently provided.

## Capabilities and context limits

- Bot tasks require tool calling. Expand model capabilities to inspect catalog declarations for input/output types, reasoning, tool calling, structured output, and temperature.
- Icons beside model names show text, image, audio, video and PDF input capabilities; hover for details. In the editor, click the image icon to toggle image input and desktop observation. Manual overrides remain available, and unknown or conflicting capabilities are not guessed from the model name.
- Model family marks are recognized from model IDs, while supplier marks still reflect the configured API endpoint. A GPT model routed through a custom supplier can show the OpenAI family mark; the connection still belongs to that supplier.
- Catalog declarations for audio, video, and native PDF input are informational. [Attachment](attachments.md) text extraction is separate from native PDF transmission.
- The context window is the input/output capacity; the output limit is the per-response budget. Catalog maxima do not guarantee your account or gateway provides that capacity.
- A short text test does not validate vision, tool calling, or every long-context case.

## Workspace default and per-Bot selection

The workspace default applies to Bots set to follow the workspace. Choose a specific model in a Bot's profile to override it. Changes apply to the next task; active tasks retain their captured connection.

When editing an existing connection, a blank key retains the saved key only for the same destination and protocol. Changing either requires credentials again. If saving is unconfirmed, verify the original request before creating another connection.

See [Web research](web.md) for the separate search requirements. Keep API keys out of conversations, skills, export packages, and Git.
