# Bot groups and collaboration

[User guide](README.md) · [简体中文](../zh-CN/groups.md)

Use **Create Bot group** beside your Bots. Groups contain existing Bots; they are not a human team-account invitation system.

## Create and send

1. Create the Bots you need.
2. Create a group, enter a name, select 2–8 members, and save.
3. Choose one recipient or all available members.
4. Explain the common goal and division of work, then send.

Example: “Have the researcher assemble evidence, then the writing companion produce a one-page summary; identify missing information first.” Multiple selected recipients work in sequence rather than simultaneously controlling one screen. Members can also hand off work within the group.

Type `@` in the message to choose a current group member. Use the arrow keys and Enter (or Tab) to select; Escape closes the list and Shift+Enter still adds a newline. Mentions remain in the message. When members are mentioned, only those Bots receive the message, in first-mention order, with repeated mentions dispatched once. Without mentions, the recipient control applies. A selected mention retains its Bot identity across draft reloads and renames; an unavailable member blocks sending until the mention is removed or selected again. For duplicate names, choose the specific Bot from the list. Retrying an unconfirmed send retains the original recipients.

## Groups initiated by a Bot

When the current private task needs complementary roles, a Bot can inspect existing available Bots by name and role, choose 1–7 collaborators, and create a group that also includes itself. The group appears in the sidebar. Collaborators work in sequence, and the initiating Bot summarizes last in the group. Ordinary greetings and tasks it can complete alone need no group.

The shared task retains each member's assignment, all requested deliverables and completion checks, including the initiating Bot's final duties. Each member's final response appears automatically in the group conversation.

The Bot shares only the current goal, necessary context, and assignments. The summary is attributed to that Bot. Private chat history, work memory, and attachments are not automatically copied, and group creation grants no additional computer or external-tool permissions. Members cannot create another group from inside a group; they use the existing handoff tools.

Each task, including its retries, can create one collaboration group. Repeating identical arguments returns the existing group without dispatching again; changed arguments are rejected. The receipt survives restarts. Retries never restart stopped work or restore an archived group. A separate task can create its own group.

## Shared context

The group conversation is shared, while members retain individual work memory and workspaces. Joining does not merge all private conversations or knowledge, nor grant computer or external-tool access.

All selected recipients need image-capable models for image input. Inspect group files in the files panel; a message may display fewer file items than the complete output list.

## Edit, copy, and archive

Finish or stop active collaboration before changing members. Stopping does not reverse completed file or external-service effects.

Copying creates an empty group with the same existing Bots. It does not copy conversation history or attachments and does not duplicate the member Bots; their profiles and settings remain shared with the originals.

[Archiving](archives.md) preserves group history, members, files, and drafts. Restoring does not dispatch old messages or change members' private conversations and desktop permissions.

Independent group knowledge libraries and group schedules are not currently provided. Use an individual member's [Knowledge](knowledge.md) or [Schedules](schedules.md).
