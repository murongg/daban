# Copy a Bot

[User guide](README.md) · [简体中文](../zh-CN/copy-bot.md)

Open a Bot's sidebar organization menu and choose **Copy Bot** to create another independent companion from its saved role.

## Steps

1. Select an available, non-archived personal Bot and open copying.
2. Review the saved source profile and enter the new name.
3. Choose whether to include saved work preferences.
4. Create the copy and inspect its role and model.

Copying uses saved data, not unsaved source-editor text. If the source changes, load the latest content and review it; the new name and preference choice are retained.

## Scope

| Included | Excluded |
| --- | --- |
| Saved role, color, and model selection | Conversations and historical model context |
| Work preferences you choose to include | Schedules, computer control, and external-tool authorization |
| A new independent Bot identity | Browser sign-ins or a dedicated VM |

Use [Bot transfer](bot-transfer.md) for documents and skill instructions. Linux files and browser state still follow environment-wide sharing.

## Unconfirmed results

Inspect progress or the original result first. Retrying the same request is intended to avoid another creation, rather than deliberately make a second Bot. Closing the dialog does not cancel a creation already submitted.

Editing the new Bot's role or memory does not edit the source. Shared software, files, and the skill library remain shared. Configure models and tool permissions independently for the two Bots.
