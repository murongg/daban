# Conversation approval modes

Current UI record · 2026-11-03. This addition follows the incumbent client surface in [client.md](client.md) and preserves the visual system in [DESIGN.md](../../DESIGN.md).

## Scope and behavior

The live private-conversation composer shows **Approval mode / 审批模式** beside the model picker when the connected service supports protocol 44 or later.

| Value | English / Chinese label | Meaning |
| --- | --- | --- |
| `ask` | Request approval / 请求批准 | Request approval before Linux commands, public webpage reads, external tool calls and software installation. |
| `auto` | Approve for me / 帮我批准 | Default. Retain risk review: routine Linux operations run automatically; risky or uncertain operations, unauthorized webpages and external tools ask. |
| `full` | Full access / 完全访问权限 | Automatically approve enabled tools through existing approval gates, with an explicit conversation-policy source in approval records. |

The local choice belongs to the current Bot and chat revision and survives reload. Starting a new conversation restores `auto`. Future task starts and continuations capture the selected policy; running tasks, messages inserted into them, pending requests and sends awaiting receipt reconciliation retain their captured policy. Questions always require a human answer.

Full access preserves enabled-tool selection, execution-environment and file-access boundaries, task ownership, human takeover, cancellation and request deduplication. It grants no additional host access and does not replay refused or uncertain operations. The modes govern existing approval gates; they do not introduce a prompt before each desktop or browser click.

## Presentation and interaction

Use the house React Aria Select, its selected checkmark and keyboard focus treatment. The compact transparent trigger retains the existing softly curved control shape (6px radius), muted label (12px) and Lucide icon (16px): Hand, ShieldCheck or ShieldAlert. Expanded options pair each label with its wrapping explanation; the trigger omits the explanation. Option width is bounded by the viewport.

Full access deliberately uses a warm orange foreground in both its trigger and option, including the explanation: light theme (`#a94714`), dark theme (`#ff985e`). These are scoped approval-control colors, not new global accents. Preserve the normal selection surface and focus outline. Selection and Escape dismissal use the shared accessible Select; Escape returns focus to the trigger. Read-only, pending and recovering conversations disable the control.

## Evidence and boundary

The supplied [dark](../review/approval/dark.png), [English light](../review/approval/light-en.png) and [compact](../review/approval/compact.png) captures show the production composer and option hierarchy. [browser.json](../review/approval/browser.json) records Full access selection, Escape focus return, new-conversation reset to `auto`, the selector's absence on legacy protocol, and no horizontal overflow at the compact 900px viewport.

The scoped finish review returned `ship` after the light-theme focused orange contrast correction was resolved. This is acceptance of this UI addition; deployment and native-app acceptance are outside that verdict.

Source of truth: [ApprovalMode.tsx](../../apps/desktop/src/features/chat/ApprovalMode.tsx), [approval.css](../../apps/desktop/src/features/chat/approval.css), [Conversation.tsx](../../apps/desktop/src/features/chat/Conversation.tsx), the shared [Select.tsx](../../apps/desktop/src/components/controls/Select.tsx), paired `approval.*` messages in [English](../../apps/desktop/locales/en.ts) and [Chinese](../../apps/desktop/locales/zh-CN.ts), and the [English](../../docs/en/approvals.md) / [Chinese](../../docs/zh-CN/approvals.md) approval guides.
