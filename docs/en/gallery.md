# Bot gallery

[User guide](README.md) · [简体中文](../zh-CN/gallery.md)

Clients with template-version support can add official or self-hosted galleries, preview and install a specific release, or import an offline v3 Bot package. The server supports Cloudflare Workers/D1/R2 and standalone private deployments. See [Deploy a Bot gallery](gallery-deployment.md).

Saved Bot profiles expose template authoring and version management. Review the role, separately authored default preferences, skills and documents before downloading or publishing. Exported and published versions are immutable. Updating a template uses a three-way comparison and explicit conflict choices; configuration history supports rollback while retaining personal memory, models and permissions. New or changed skills stay disabled until reviewed. Closing the client does not stop accepted tasks; uncertain operations retain a receipt/retry action.

Open **Bot gallery** in the sidebar. Presets provide a role to start from rather than prefilled sample conversations.

## Use a preset

1. Search by name or purpose, or browse categories.
2. Open a preset to review its role and example starting prompts.
3. Choose **Use this Bot** to create an independent Bot.
4. Adjust its name, role, and model, then send your own task.

Current presets cover general assistance, research, writing, data analysis, browsing, translation, product work, content, office work, coding, learning, and ideas. Categories and preset wording may change; use the current app list as the reference.

## What a preset provides

A preset mainly sets a name, color, role, and suggested prompts. It does not connect a computer, sign in to websites, install software, configure API keys, or start a task. Names such as “browser” or “coding” do not grant permissions.

Adding the same preset more than once creates independent Bots. Editing one Bot does not update the others. Refine long-term behavior through the [Bot role](bots.md), [Memory](memory.md), or [Skills](skills.md).

If no preset fits, [create a Bot](bots.md) directly.
