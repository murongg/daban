# Conversations and history

[User guide](README.md) · [简体中文](../zh-CN/conversations.md)

Choose **New chat** in the sidebar to start an ordinary conversation without creating a Bot. Ordinary conversations can use authorized tools too. Questions, writing, and content organization do not require connecting a computer; connect one when a task needs a graphical application.

Choose a Bot for a lasting role, memory, and reference library. An ordinary conversation keeps its own context and does not automatically include another chat or Bot's private material.

## Send a task

1. Describe the goal, source material, and expected result.
2. Add [attachments](attachments.md) or exact public webpage URLs when relevant.
3. Press Enter to send and Shift + Enter for a new line. Text composition with an input method does not immediately send the message.
4. Review [Execution](execution.md) for plans and tool states. Answer questions and approvals in the [Inbox](inbox.md).

“Compare these two proposals by cost, restrictions, and unanswered questions; do not create files” is easier to verify than “Take a look.”

Ordinary chats inherit the workspace model; Bot conversations inherit the Bot's model. The composer model selector applies to future messages in the current conversation. Edit the Bot profile to change its default. Model changes do not switch a running task. Responses can contain Markdown, tables, code, and supported diagrams. Open file outputs from the conversation or the files panel.

## New conversations and saved history

**Recent conversations** lists ordinary chats and Bot conversations together, with the Bot's name beside its topics. Selecting a conversation never runs tasks or replays tools. Titles come from the first message and can be renamed in the header menu. Custom titles and conversation model choices are stored on this device.

Use **New conversation** in a Bot's header to start another topic. The previous topic retains its drafts, attachments, and approval choice. A Bot can have several conversations sharing its lasting role, [Memory](memory.md), and [Knowledge](knowledge.md).

**Conversation history** also offers **Continue this conversation** for older topics. Sending a message explicitly uses the selected conversation's context. Changes to the model or tool authority may rebuild a compatible context from retained history; old permissions and tools are never replayed. Historical file links read files still available now and do not recreate files or prove they have never changed.

Switching conversations or closing the client does not stop running background work. A Bot handles one task at a time: you can draft in another topic and send once it finishes, or choose **Open running conversation** to return. Ordinary chats have separate execution identities. Queued messages stay with their original topic and are not sent automatically after reopening the client.

Ordinary chats, unified recent conversations, and historical continuation require an updated background component. Older components continue to support existing Bot chats and read-only history.

## Long conversations and drafts

- Older context may be compacted as the context budget fills. Saved history and all text currently visible to the model are different things.
- For exact quotations, supply the original document or file again and ask the Bot to verify it.
- Drafts can be retained when navigating away. If an operation is unconfirmed, verify the original request before retrying.
- Voice input is not currently implemented. Changing interface language does not automatically translate user content or model replies.

See [Execution](execution.md) to stop work and [Sidebar organization](organization.md) to find or organize conversations.
