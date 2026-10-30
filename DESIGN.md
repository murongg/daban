---
name: "daban"
description: "Quiet Grok Bot style conversation workspace for a Chinese desktop client."
colors:
  canvas: "#ffffff"
  sidebar: "#f8f8f7"
  soft: "#f3f3f1"
  hover: "#ededeb"
  selected: "#eaeae7"
  ink: "#252523"
  muted: "#66665f"
  line: "#eaeae6"
  line-strong: "#dcdcd6"
  strong: "#252523"
  strong-hover: "#42423d"
  on-strong: "#ffffff"
  bubble: "#252523"
  on-bubble: "#ffffff"
  success: "#4b7d68"
  warning: "#9d7326"
  danger: "#b23e3e"
  selection: "#dce7dc"
  focus: "#61816c"
  scroll: "#d5d5ce"
  code-keyword: "#704c9f"
  code-string: "#386a51"
  code-number: "#8b5a24"
  dark-canvas: "#1c1c1a"
  dark-sidebar: "#181817"
  dark-soft: "#272725"
  dark-hover: "#30302d"
  dark-selected: "#33332f"
  dark-ink: "#eaeae5"
  dark-muted: "#a2a29a"
  dark-line: "#30302c"
  dark-line-strong: "#45453f"
  dark-strong: "#e8e8e0"
  dark-strong-hover: "#ffffff"
  dark-on-strong: "#252523"
  dark-bubble: "#353531"
  dark-on-bubble: "#eeeeea"
  dark-success: "#8ab49c"
  dark-warning: "#d2af6a"
  dark-danger: "#ed9a9a"
  dark-selection: "#3d5143"
  dark-focus: "#8ab49c"
  dark-scroll: "#474740"
  dark-code-keyword: "#c7a4eb"
  dark-code-string: "#a2c6af"
  dark-code-number: "#e7be83"
  bot-mint: "#73a48d"
  bot-violet: "#9671dc"
  bot-orange: "#d4a04b"
  bot-blue: "#6989d2"
  bot-teal: "#669da7"
  bot-pink: "#bc81a2"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "24px"
    fontWeight: 550
    letterSpacing: "-0.5px"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  message:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.9
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    fontWeight: 500
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "11px"
    fontWeight: 400
  wordmark:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "23px"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.8px"
rounded:
  badge: "5px"
  control: "9px"
  row: "12px"
  bubble: "17px"
  bubble-tail: "5px"
  composer: "19px"
  desktop: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.strong}"
    textColor: "{colors.on-strong}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.strong-hover}"
  button-secondary:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    typography: "{typography.label}"
  button-text:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    typography: "{typography.label}"
  button-icon:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    height: "36px"
    width: "36px"
  field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    width: "100%"
  bot-row-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "12px 11px"
  badge:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.muted}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
  file-artifact:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "13px"
    width: "335px"
  composer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.composer}"
    padding: "13px 13px 10px"
  message-bot:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    padding: "12px 16px"
    typography: "{typography.message}"
  message-user:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.on-bubble}"
    padding: "12px 16px"
    typography: "{typography.message}"
  workspace-tab:
    textColor: "{colors.muted}"
    height: "48px"
    padding: "0 10px"
  live-desktop:
    backgroundColor: "{colors.soft}"
    rounded: "{rounded.desktop}"
    width: "100%"
  task-recovery:
    textColor: "{colors.muted}"
  markdown-code:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
---

# Design System: daban

## Overview

**Creative North Star: "Grok Bot conversation workspace"**

daban preserves the Grok Bot reference: a quiet, edge-to-edge conversation workspace with a pale sidebar, restrained monochrome controls, and compact colored Bot identities. Chinese system typography and messaging-app density keep attention on the conversation and the adjacent computer.

The light and dark themes share the same geometry. Surface tones, thin dividers, and text hierarchy organize the UI. Connected Electron Bots show their actual Linux desktops beside the conversation; the browser-only preview keeps its synthetic desktop. Simple SVG identities and the lowercase daban wordmark remain the identity anchors.

**Key Characteristics:**

- Conversation and computer sit beside each other on wide desktop windows.
- Warm neutral surfaces with small identity and semantic color accents.
- Compact system typography, flat rows, and restrained rounded controls.
- Visible connection and demonstration labels distinguish live Bots from UI examples.

The frontmatter records the implemented values from `apps/desktop/src/tokens.css`, `apps/desktop/src/styles.css`, and `apps/desktop/src/Avatar.tsx`. Its rounded and spacing names describe recurring values; they do not imply additional CSS custom properties. The component illustrations and extensions live in `.impeccable/design.json`.

## Colors

The palette is warm monochrome. Use the existing CSS semantic roles; the frontmatter's `dark-*` entries capture the values substituted by the dark theme.

### Primary

- **Quiet Ink** (`strong`, `strong-hover`, `on-strong`): primary actions and the circular send control. The roles reverse in dark mode to preserve contrast.
- **Conversation Ink** (`bubble`, `on-bubble`): user messages. Keep this separate from the primary-action role because the dark theme intentionally uses a softer bubble.

### Secondary

- **Bot Identities** (`bot-mint`, `bot-violet`, `bot-orange`, `bot-blue`, `bot-teal`, `bot-pink`): existing organic SVG avatars and color-choice controls. These identify Bots; they are not a general action palette.
- **Code Syntax** (`code-keyword`, `code-string`, `code-number` and their `dark-*` values): muted violet, green and amber distinguish syntax only inside assistant fenced-code blocks. Comments reuse muted ink; ordinary code retains conversation ink. These roles do not extend to inline code, controls or panels.

### Neutral

- **Canvas and Pale Rail** (`canvas`, `sidebar`): the main conversation and slightly tinted navigation/computer surroundings.
- **Soft, Hover, Selected** (`soft`, `hover`, `selected`): assistant bubbles, quiet controls, hover response, and selected Bot rows.
- **Ink and Muted Ink** (`ink`, `muted`): main text and supporting labels. Metadata stays legible without competing with the message body.
- **Fine and Strong Dividers** (`line`, `line-strong`): structure and field/composer boundaries.
- **Selection and Scroll** (`selection`, `scroll`): native text selection and the small scrollbar thumb.

**Semantic accents:** `success` marks the connected desktop state, `warning` marks human takeover, `danger` marks errors, and `focus` marks keyboard focus. Preserve text labels alongside state dots. Live Linux screen pixels retain the guest desktop appearance in either app theme. The green wallpaper and miniature window colors belong only to the synthetic browser preview; that preview remains light in dark mode.

**The Small Accent Rule.** Color identifies a Bot, a meaningful state or fenced-code syntax; the workspace itself stays neutral.

## Typography

Use the single system sans stack in the frontmatter, including PingFang SC and Microsoft YaHei for Chinese. No display face or web-font dependency is used. The synthetic browser terminal preview uses the platform monospace stack; typography within the live desktop comes from Linux applications and does not redefine the app type scale.

### Hierarchy

- **Headline:** inbox/settings page headings, with medium weight and restrained negative tracking. Empty conversation headings use the nearby smaller size already in the stylesheet.
- **Title:** the selected Bot name in the header; panel headings use nearby compact sizes rather than display typography.
- **Body:** the default UI reading size and line height.
- **Message:** the same readable size with the more generous conversation line height.
- **Label and Meta:** action labels, row descriptions, helper text, and timestamps. The incumbent supporting scale runs down to tiny demo/keyboard labels; do not copy the miniature desktop's type into primary app content.
- **Wordmark:** lowercase daban, compact tracking, medium-bold weight.

**The Conversation Reading Rule.** Preserve the message reading size and generous line height when adding content; density comes from the surrounding chrome.

## Layout

The app fills the window with a fixed sidebar, a flexible conversation, and an optional right workspace. The desktop sidebar is (272px), the conversation header is (70px), and workspace tabs are (48px). The workspace normally uses (42%) of the area after the sidebar, with a minimum width of (350px) and maximum of (580px). At wide windows from (1600px), it becomes (40%). Transcript and composer scroll/layout independently so the composer remains at the bottom.

At (1280px) and below, the sidebar becomes (246px), while the workspace becomes (43%) with a minimum of (330px). At (1080px) and below, the workspace overlays the right side under the header at (430px), capped by the available width; initial loads below (1080px) start with it closed. At (700px) and below, the sidebar becomes an optional drawer, the header becomes (62px), and the workspace covers the conversation width. This narrow layout is a web preview adaptation, not a mobile application.

The native Electron window starts at (1380 × 860px) with a minimum of (920 × 640px). On macOS, reserve the native traffic lights: the sidebar brand receives (97px) left padding and hides its mark/preview suffix. The native sidebar-brand and chat-header regions drag the window; buttons remain clickable. Do not duplicate native window buttons in the renderer.

Use the small recurring spacing values in the frontmatter for local groups. Larger page content uses a centered maximum of (850px), and dialogs use (430px) or (740px) width with viewport padding. Do not apply landing-page section spacing to this product.

## Elevation & Depth

The workspace is flat at rest. Thin dividers, neutral surface changes, and selected rows provide most separation. Elevation is reserved for overlays and the miniature desktop window: dialogs use `0 20px 70px #00000024`, toasts use `0 7px 25px #00000016`, and compact workspace/sidebar overlays have a faint lateral shadow. The dialog backdrop is `#141b1940`; it dims rather than blurs the content.

**The Flat Workspace Rule.** Keep ordinary rows, messages, controls, and panels free of decorative drop shadows; use the existing overlay treatment when a surface actually floats.

## Shapes

Controls and fields have gently rounded corners; selected Bot rows and file-artifact containers are slightly broader. Message bubbles have an asymmetric small corner facing their author: lower left for assistant messages and lower right for user messages. The composer is the largest rounded input surface. The send control, status dots, and toggle thumb are circular. Dividers and fields use fine (1px) borders.

The Bot avatar is an irregular, rounded SVG silhouette with two white eye strokes. Retain that simple colored shape rather than introducing profile photos, emoji avatars, or a different icon style. Other UI icons are fine monochrome outlines, mostly (14–18px).

## Components

### Buttons

Primary actions use `strong`/`on-strong`; secondary actions use `soft`; text buttons begin muted. Text actions have a minimum height of (36px), while common icon controls are (36px) square. Some toolbars intentionally use smaller controls. Preserve this existing compact density without claiming that every target is (44px). Hover changes the neutral background or ink. Disabled buttons use reduced opacity and a disabled cursor.

The existing transition is a short color/background change (150ms). Keyboard focus is an explicit (2px) `focus` outline with (4px) offset. Respect the existing reduced-motion override; do not add ornamental motion.

### Inputs / Fields

Fields use the canvas surface and a strong divider. Focus strengthens the border to muted ink. Help text sits below the label; errors use the danger role. The composer has a containing focus border, a borderless multiline input, quiet tools, and a circular send action. Keep the Enter/Shift+Enter hint and the context-specific execution label visible: report the selected model and actual execution connection, and reserve the model-demo label for the browser-only preview. Attachments use removable chips, with at most four files per task. Markdown, TXT, CSV and JSON retain their (200 KB) per-file limit; PDF, DOCX, XLSX, PPTX and PNG/JPEG/GIF/WebP use the existing runtime-backed upload and preview path, retaining its type/size checks and the send-time model capability checks. PNG/JPEG retain protocol26 compatibility; GIF/WebP require protocol31 before local file bytes are read.

Private and group composers share file selection, clipboard-file paste and file drop. Read clipboard files first, falling back to file items when needed. Leave pure text paste to the native textarea. When files and plain text arrive together, replace only the selected text within the existing draft limit; retain the surrounding draft and restore the caret only while the same target and focused input remain current. Adding an attachment never sends a task. Keep the group recipient chooser and explicit send action separate.

File hover reuses the containing focus border and announces “松开即可添加附件” as a transient status inside the composer. Keep nested-child drag transitions stable; clear feedback on leave, drop, drag end or target/read-only change. The helper row includes “可粘贴图片或拖入附件” and wraps within the conversation width. Unsupported or unreadable files use existing feedback and preserve unsent work; an empty file drop points back to “添加附件”.

Capture the initiating Bot/group for asynchronous attachment work. Reserve an upload before reading files so overlapping events cannot bypass preparation or the four-file limit. Archived, lifecycle-pending, conversation-change-pending and uncertain-send targets cannot add files; group readiness and sending guards also apply. Prevent file drops from navigating the renderer even when the target is read-only. These built rules and their bounded browser evidence are recorded in `.impeccable/surfaces/client.md`; they do not establish native screenshot clipboard or Finder drag acceptance.

### Navigation

The sidebar combines compact inbox/conversation rows with taller Bot rows (76px minimum). A selected Bot uses `selected`, while ordinary navigation uses a quiet hover fill. Names and previews truncate; timestamps use tabular numerals. The footer reports the actual Linux connection state in Electron and local demo storage in the browser-only preview. Personal Bot rows show current task, takeover or computer-connection state; disconnected personal Bots stay labelled “可对话 · 未连接电脑”. Demonstration rows retain their explicit labels. On narrow web previews, navigation opens as a drawer with a scrim.

Workspace tabs use a thin (2px) active underline, monochrome icons, and text labels. The six personal-Bot tabs scroll inside their own strip when space is limited; the close control stays outside that strip and remains reachable. Retain `aria-selected`, arrow/Home/End keyboard navigation, their tabpanel relationship, and scrolling the focused selection into view without widening the panel.

### Local Sidebar Organization

`Sidebar.tsx` extends the existing rail with local pins, named sidebar sections and read/unread indicators. A section organizes personal Bots and group chats together; it does not create a group conversation or move their files. Pinned entries appear once above the named sections while retaining their section membership for unpinning. Each row keeps its Bot identity, connection/task text, current-conversation state and draft independently from list placement. Section headings reuse muted metadata with a disclosure and a named organizer; empty sections give a short move-in instruction. Long headings truncate inside the rail, while menu destinations wrap.

The row's quiet more control appears on hover, keyboard focus or an open menu, and stays visible for devices without hover. More, context-click and Context Menu/Shift+F10 open the same actions. The menu reuses canvas/ink, a fine strong divider and the existing toast shadow; its (248px) width and (420px) maximum height are capped to the viewport and scroll internally. Menu actions reuse the incumbent control corner (9px), (36px) minimum height and compact (13px) text. Keep visible focus and ArrowUp/ArrowDown/Home/End navigation, Escape dismissal, Tab exit and focus return. Every placement choice, including “移出自定义分组”, exposes `menuitemradio` with `aria-checked`; pin/read/create actions remain ordinary `menuitem` controls. The visible check is not the only destination state.

Create, rename and remove reuse the house Dialog, field, helper/error and primary/secondary actions. Invalid or duplicate names leave the entered value editable; the nearby helper states that organization stays on this computer. Removing a section returns its members to the ungrouped list while preserving pins, conversations and drafts, then returns focus to a surviving list control. Search temporarily reveals matching collapsed members and restores saved collapse on clearing; connected-runtime search excludes shipped demonstration previews/messages and keeps the selected conversation and draft intact.

Unread is a local result/question attention flag shown by a small ink dot with a named status and hidden “未读” text. It is distinct from Inbox's pending-decision count and does not claim server unread totals. Baseline the first complete metadata snapshot, preserve exact seen-event identity and private/group ownership, and clear attention automatically for an already open chat only when it is visible, focused and unobstructed by a dialog. Repeated metadata must not resurrect manually read conversations; bounded retention keeps still-advertised group keys ahead of older unadvertised entries. Organization does not change task execution, Inbox decisions or computer ownership.

`outputs/sidebar/design-review.md` required checked destination semantics; `design-verdict.md` scores that fix resolved and returns `ship` for Fix 1 only. The four personally viewed synthetic production-React captures and saved browser records are bounded in `.impeccable/surfaces/client.md`. The source review above retains its historical scope. The feature is now available in the preserved normal36 rollout. Subsequent retained-fixture native rename/up-down/boundary/removal/manual unread/read/open-clear/reopen checks passed with all31 client fields restored exactly (outputs/sidebar-native36/verification.json). No source UI or visual-world change followed from that functional acceptance. Live incoming/long-offline, mobile/cloud, public-release and full-parity scopes remain distinct. The existing palette, typography/radius/spacing ramps and all prior evidence scopes remain intact.

### Chips / Badges

Badges and counts are small, neutral, softly rounded metadata containers. Attachment chips include a named remove control and truncate long file names; they are not colorful filter pills.

### Cards / Containers

File artifacts are compact bordered rows with a quiet file symbol, name, metadata, and open affordance. They use no resting shadow. For live tasks, artifacts come from actual runtime files; model prose alone must not produce a file card. The shared file panel in `apps/desktop/src/RuntimeFiles.tsx` shows real names, sizes, modified times and wrapping paths, with explicit refresh, preview and download actions. Preview reads current file content before opening the existing dialog. Approval, file-list, routine, and settings content is primarily divided rows rather than nested cards.

### Raster File Preview

Raster files reuse the wide read-only file dialog: keep the filename, kind/size metadata, contained image field, visible close and original-download actions, focus containment, Escape dismissal and focus return. GIF/WebP decode locally through ImageBitmap/canvas into a static PNG bounded to a (1024px) edge, preserving transparency against the existing preview surface. Release the temporary bitmap after decoding. A decode/display failure uses the existing alert treatment and leaves original download available; never fall back to an autoplaying original.

Keep the nearby Chinese disclosure explicit: the preview and model service read only the first frame, while original download retains animation. Local preview does not imply exclusive local model processing or complete animation understanding. Download continues to use the scoped immutable original bytes, independently of the generated preview. Private/group attachment ownership, drafts, recipient selection and explicit send remain intact; a text-only model refusal retains the unsent inputs. The five reviewed frontend states and separate browser, native-SDK and paid-model evidence are bounded in `.impeccable/surfaces/client.md`. Displayed synthetic codec fixtures introduce no brand color, artwork or token.

### Assistant Code Blocks

Fenced code stays inside the existing canvas-colored frame, with a fine divider, gently rounded corners (8px), language label and named “复制代码” action. The platform monospace stack uses the existing (0.9em) code size. Keep the (12px) code padding, (1.7) line height and focusable horizontal scrolling; long lines must not widen the conversation or wrap source indentation.

Explicit supported language names and aliases receive syntax color: keywords, types and tag names use `code-keyword` with (600) weight; strings, regular expressions and symbols use `code-string`; numbers, literals and attributes use `code-number`. Comments stay muted and italic; substitutions retain normal ink. Inline code stays plain. Unknown or unspecified languages, tokenizer errors and blocks over (20,000 characters) retain the complete plain source without language guessing.

Highlighted output crosses the renderer boundary as text and spans only. Copy preserves source indentation and intentional blank lines, excluding the Markdown parser's one added terminating newline. Preserve the existing copy-success/failure feedback and keyboard focus treatment; highlighting does not add executable code, auto-loaded media or a new card style.

### Assistant Formulas and Diagrams

Notation extends the existing assistant reply, preserving its neutral conversation frame and reading order. Dollar-delimited inline/display formulas and `math` fences use local KaTeX; its mathematical lettering is confined to notation while surrounding prose keeps the incumbent system stack. Display formulas align with the start of the message and keep their natural size inside a focusable horizontal scroll region, with existing focus ink. Invalid or bounded-out formulas retain readable source.

Settled `mermaid` fences reuse the canvas-colored code frame with the “图表” label and exact “复制源码” action. The locally rendered diagram is a sanitized inert SVG image; it reuses `canvas`, `soft`, `ink`, `muted`, `line-strong` and the system font in each theme. Keep natural text size (16px), internal scrolling within the available width and a maximum preview height (480px), with (16px) padding. Do not shrink a wide diagram to fit the conversation. The independently focusable preview retains its inset focus outline. Image alternatives derive from title/description or visible label text, with source disclosure available.

Successful diagrams put source under the initially collapsed “查看源码” disclosure. Streaming/incomplete Mermaid replies, pending renders and failures retain the complete code in the shared frame; pending/failure status uses muted text and status semantics. Source copying preserves the existing caller-owned clipboard path, whitespace and success/failure feedback. No source callback is bound, and source cannot grant automatic external resources. Keep the existing validated manual-link and known-file actions in Markdown. Bounded rendering and a caller timeout do not establish hard CPU interruption.

The response-only review and evidence boundary are recorded in `.impeccable/surfaces/client.md` under “Formula and diagram replies”; this component does not establish a new visual world or whole-product acceptance.

### Shared Skill Library

Candidate20 adds the “技能” pane within the incumbent workspace. Reuse its existing system type, Lucide outline icons, flat divided rows, neutral buttons and field treatment in both themes. Skill names use compact medium text (13px, 550), descriptions use muted reading text (12px, line height 1.8), and the source editor heading uses the existing compact title treatment (14px, 550). The source textarea has a readable minimum height (240px), line height (1.7), and vertical resizing; it does not introduce a new code-display style. Wrap names, errors and actions within the panel.

Copy distinguishes the shared instruction library from each Bot’s independent enablement. A new or imported single-file `SKILL.md` starts disabled; importing, editing or enabling never starts a model task. “加入草稿” inserts an enabled, user-invocable `/name` ahead of the current chat draft and still requires sending. Changes apply to the next accepted task and do not grant new tool permissions. An unavailable skill service retains ordinary conversation and its send action.

Keep editor drafts per Bot across panel changes and relaunch. A clean selected document refreshes with shared revisions; dirty drafts and newer typing survive late reads and save acknowledgements. Scroll the editor into view on selection, not on each keystroke. Conflicts retain the draft, display the current saved source, require an explicit version decision, and leave saving as a separate action. Recycling uses the existing focus-contained dialog to name the skill and warn that every Bot binding will be disabled; restoration requires fresh enablement.

The eight final `.impeccable/review/skills-*.jpg` captures and `outputs/skills/ui-dom.json` cover production components with explicitly synthetic bridge data. Desktop main/panel widths are (1200px)/(480px); compact widths are (380px)/(330px) within a desktop viewport around (1280 × 720px). Final DOM evidence records the (240px) editor, internally scrolling keyboard tabs, reachable close, per-Bot isolation, no page overflow and ordinary send during skill failure; its earlier (100px) editor measurement is historical. Browser import/export preserved (124) synthetic UTF-8 bytes, including Chinese, indentation and blank lines. The five-section finish review in `outputs/skills/design-review.md` returned ship with no material fixes for this bounded surface. These are not original Electron, native picker, mobile or activation proofs; no raster asset, palette or visual world was added.

### Conversation and Computer

Native input ownership (candidate18) includes the Bot, screen instance and epoch. A previous instance's frame must disappear before its replacement can accept input; drag release keeps its original binding. Refusing stale work uses existing loading/error treatments and changes no geometry, palette or keyboard affordance. Candidate19 retains these fences when a physical display is reused for a different logical Bot; the screen instance changes without replacing the Bot identity. Actual-user activation remains unverified.

Keep user and assistant bubbles visually distinct using their semantic roles and alignment. Activity details and file artifacts remain quieter than the conversation. The activated protocol-15 Electron instance still has the established researcher A and writer B desktops. The unactivated candidate19 supports explicit computer connection for any registered personal Bot, with independent native screens and control leases, shared workspace files and a persistent Chromium context with separate Bot pages. Shared login is verified only on the synthetic demonstration site; arbitrary external sites remain restricted. Ordinary chat, explanations and prose use DSH directly without tools. File and data work use scoped workspace tools; desktop actions are optional. Chat no longer receives synthetic input. The Agent core can run without a connected computer, while the current desktop deployment still hosts the service in its local Linux VM. A computer connection is optional for every personal Bot; physical screen capacity does not define the number of Bot identities.

The adjacent computer keeps the same pale surroundings, textual ownership state and explicit takeover/handback action. Keep ownership and its action sticky at the top of the scrolling computer pane, including while long webpage requests are visible. The selected Bot alone pauses for human takeover; the other Bot can continue. A takeover dot in the Bot list keeps ownership visible after switching Bots. Switching, closing the panel or closing an expanded view never hands control back. The synthetic desktop and its disclaimer remain only in the browser-only preview.

### Managed Computer Connection

Candidate19 adds connection states within the incumbent computer pane, using the existing panel heading (15px, 550), muted explanation (12px, line height 1.8), quiet capacity line (11px), and primary/secondary actions. Empty, connecting, stopping, failed and interrupted states replace the screen rather than presenting an old frame as live. Capacity names the current execution environment’s occupied and available computer slots; its default of two is a resource budget, not a Bot limit. Keep the conversation-first geometry and existing theme roles.

Connected views keep stop separate from takeover/handback. Pending-operation, receipt-error and active-task reasons remain readable beside the controls, with status/alert semantics and a named receipt-check action; an inactive icon or toast alone is insufficient. This feedback wraps across the toolbar in compact panes. The stop dialog names the Bot, warns that applications close, and requires the unchecked “已保存这台电脑中未保存的内容” confirmation. A changed revision or screen instance invalidates that confirmation, and an active task blocks stop.

Connecting or stopping temporarily disables this Bot’s send action and preserves its draft; the text explicitly says other Bots remain available. Settled disconnected states retain ordinary Agent conversation and workspace tools. Saved recovery metadata contains only the pending operation identity and binding, never the saved-content confirmation; reconciliation checks receipts without automatically resending the operation. Unconfirmed same-boot resource reclamation retains its slot and visibly requires manual local-VM restart. Stopping the last screen retains the shared Chromium context for session cookies, so this state must not imply that all graphics-related memory has been released.

The eight `.impeccable/review/connection-*.jpg` captures and `outputs/connections/ui{,-review}-dom.json` cover production components under a synthetic bridge, with a static real-Linux screenshot. Compact main/panel widths are (440px)/(390px) inside a desktop viewport. The scoped finish verdict accepts the two loading/connected-feedback fixes; these captures do not verify original Electron interaction, real control, mobile or deployment. Candidate19 is not activated in the original protocol-15 service.

### Computer Startup Unavailable

The protocol-17 candidate localizes failed computer startup to the existing panel section. `apps/desktop/src/Computer.tsx` shows the heading “电脑暂不可用” with the incumbent panel-heading size and weight (15px, 550), followed by muted explanation text (11px, line height 1.8) identifying conversation, workspace files and knowledge as still available. The normal conversation and send control remain available. This state renders no screen image, takeover action, browser selector or graphical-app shortcuts; it introduces no new palette, card or illustration.

The isolated runtime diagnostic page states “普通 Agent 已就绪” alongside the unavailable-computer status. It hides screen, guide, toolbar and event sections through the semantic `hidden` attribute and does not poll frames or imply takeover. At this historical checkpoint, the fallback followed attempted graphical startup and successful desktop startup remained eager; it did not establish lazy per-Bot attachment or a recovery flow. Candidate19’s managed path is recorded above. The user's protocol-15 service has not been switched to this candidate.

### Live Desktop and Keyboard

The live screen in `apps/desktop/src/LiveDesktop.tsx` uses a contained (1.6:1) image inside a softly rounded frame, with a small dark “只读观看” or “你正在接管” label at the top right. Human control adds a (2px) warning outline with (2px) offset. The screen uses actual Linux frames; a neutral loading or connection-error layer replaces unavailable interaction rather than pretending the last frame is live.

Only a ready, human-owned screen accepts pointer, drag, wheel, key and paste input. Keep the visible (11px) keyboard hint directly below it. Distinguish thinking, workspace-tool activity and actual desktop actions in the progress row. In both regular and expanded computer views, plain Esc exits the controlled screen to its surrounding text field; Alt+Esc sends Escape to the remote application without dismissing the view; Tab and Shift+Tab stay within Linux. The separate text field supports Chinese input and pasting; it and the terminal/files/editor/shared-browser shortcuts are disabled while viewing read-only or disconnected. `apps/desktop/src/Computer.tsx` owns the explicit takeover/handback actions; input remains bound to the Bot and control lease that received it.

### Shared Browser

The protocol-16 candidate adds a browser surface beside the Linux desktop selector within the existing computer pane; it is not yet activated in the user's protocol-15 instance. Reuse the same neutral surfaces, quiet outline icons and selected fill. Browser tabs scroll horizontally and truncate long titles; the address row uses the existing field border and gently rounded control shape. The live webpage keeps its own appearance inside a contained (1.5:1) frame. Expanding opens the selected computer surface and retains that tab's unsent address. The expanded webpage frame is capped at (65vh), and the dialog body remains scrollable.

Webpage dialogs and file requests appear as divided inline sections above the screen, with a readable title, wrapping message, exact source-tab title and full URL. When that tab is inactive, show “显示请求所在标签” beside the request. A new selected tab must not make an older request appear to belong to it. Keep confirmation and cancellation explicit; an incomplete, truncated dialog message cannot be confirmed. Local file selection states the one/four-file allowance and combined (5 MB) limit before submission. Pending requests suspend direct screen input, while takeover/handback remain reachable above them.

Address edits belong to the Bot, browser instance and tab, and stay in renderer memory only. Human replies and selected file contents do not enter chat drafts or workspace exports. Uncertain operations use a compact inline notice with “核对结果” and an explicit continuation action; inspect the receipt rather than automatically replaying navigation, replies or uploads. Persist only the request ID, browser instance and control epoch for recovery. Restored tabs remain visibly suspended until “重新打开此页” is chosen; retained login data is not proof that any particular website is still signed in.

### Shared Tasks

The source36 global “任务” entry extends the quiet workspace with one shared collection, using the existing Chinese system type, light/dark semantic surfaces, outline icons, fields and monochrome actions. The list uses flat divided task rows; the board uses three named status columns with lightly bordered cards and the incumbent row corner. Title and progress text wrap, while supporting status, author and time stay quieter. Counts explicitly describe loaded items and loaded status-column contents, rather than claiming a complete workspace total. Search, all/open/done/trash filters, explicit cursor loading and refresh stay in one wrapping toolbar; the trash view remains a list. Layout controls report that effective view: Trash has List pressed and its disabled Board control unpressed, while the saved Board preference remains available when leaving Trash. Appending a later page preserves the original collection revision baseline: it does not refresh earlier rows or dismiss their “任务有新更改” notice. Only a full refresh advances that baseline.

Wide content keeps the collection beside an independently scrolling inline detail editor. At a Tasks container width of (850px) or less, detail replaces the collection and keeps “返回任务列表” available. At (600px) or less, the board becomes one column; that source rule is not mobile acceptance. The reviewed (1280 × 720px) and (1024 × 720px) desktop views retain the incumbent responsive sidebar (246px). These scoped rules do not revise the historical global chrome description above.

The editor uses labelled native fields for title, status, explanation and progress. Its primary “保存任务” is a native form submit pinned in the detail heading, alongside the return action, so reading long content does not hide saving. Empty/unavailable headings reuse the headline step; ordinary reading stays on the body step, with compact supporting labels. No new palette, type, radius or spacing ramp follows from Tasks.

Keep shared-card state separate from execution: saving or marking done starts no Agent or desktop and is not proof of completed work. Local drafts survive leaving Tasks; normal reopening returns to the legacy chat view, with the global Tasks entry leading back to the retained editor. An exact pending request and its submitted draft are persisted before the write. Reopening checks its receipt, while “重试同一次操作” explicitly resends that captured request. The submitted editor is read-only; independent editor keys prevent a late read or receipt from replacing newer work. Recovery preserves reading and receipt inspection while blocking writes.

Conflicts retain the local draft beside the latest title/status and a bounded, keyboard-focusable explanation/progress disclosure. Save remains disabled until the explicit “保留我的更改” or “使用后台版本” decision; keeping changes carries only locally changed fields onto the newer base, preserving untouched newer fields, followed by a separate Save. Trash requires a named inline confirmation bound to the editor identity and saved card revision; a save or trash/restore revision change invalidates earlier consent. Restoring retains the local draft for later saving. A blank new editor says “新任务草稿，填写后保存到运行环境。” and only a saved base may say “已保存到当前运行环境。”. Loading, empty, unavailable, old-environment and damaged-cache guidance remain explicit. A failed initial list read uses “任务列表尚未读取” with refresh guidance; failure does not establish an empty collection. The nine synthetic production-React captures and scoped review records are bounded in `.impeccable/surfaces/client.md`. Subsequent actual Electron CRUD/conflict merge/trash/restore/board/search and unsaved-draft reopening are recorded in `outputs/provision/image36/native-preservation.json`; two native state defects were corrected with a failing regression and real-client rechecks. This adds functional evidence without a new visual world or whole-product review; the normal workspace is now protocol36 after preserved activation, with29old native fields exact and separate takeovers/handback verified in `outputs/activation36/`. Remaining native forms and the complete basics matrix retain their open scope.

### Private Notes

The source37 “便笺” surface extends the existing right workspace for a personal Bot. Its header action and workspace tab are absent for groups; an archived Bot keeps readable Notes. It uses the house Chinese system face, semantic light/dark roles, outline icons, fields and monochrome actions. The list is flat with fine dividers, wrapping titles, quieter status/body previews and metadata. Search and status/trash filters remain above the list, with explicit cursor loading. Notes introduces no palette, font, type ramp, token, specimen or wider layout rule.

List and detail share the pane rather than creating another column. The inline editor labels title, body and open/parked/done status; its body is vertically resizable. Returning to the list retains the Bot’s draft, and a blank draft says “尚未填写”. The existing workspace scroller contains long editors. Conflict and pending notices reuse the soft neutral surface; complete prior/latest content sits in a named, keyboard-focusable comparison capped at (300px). Keep the local editor above the comparison and explicit “保留我的更改” / “采用最新版本” choices before a separate Save. Keeping changes carries only locally edited fields onto the newer base; Save remains disabled until that choice.

Keep one durable editor and exact pending operation per Bot, independent of chat drafts and other Bots. Before a write, persist its Bot-bound request and submitted draft. An uncertain editor stays read-only, New and row replacement stay disabled, receipt inspection remains distinct from the explicit same-request retry, and an unknown receipt retains the intent. Late reads/acknowledgements cannot replace another Bot or newer editor. Trash uses an inline confirmation bound to editor identity and saved revision; restore keeps local changes for a separate Save. Recovery/archive guidance, damaged optional cache, loading, failed read and genuine empty states remain distinct. Saving or marking complete starts no task.

The six synthetic production-React desktop captures, current paths/hashes and bounded `ship` review are recorded in `.impeccable/surfaces/client.md` and `outputs/notes-ui/`. They cover this Notes frontend at (1280 × 900px) and (1024 × 768px), including complementary top/bottom conflict views. They do not establish native37 delivery, original-data preservation or mobile acceptance. Normal app/service and retained candidate remain36; cloud/mobile and the complete basics matrix remain open.

### Task Progress and Recovery

Public webpage retrieval shows “正在读取网页”, separate from reasoning, workspace tools and desktop actions. Keep the same compact status row and stop action; tool progress is actual DSH activity, never a simulated sequence.

Native search shows “正在搜索”. Visible assistant deltas use the same bubble geometry and stable response identity as the final answer; reasoning and tool arguments are excluded. The small muted “回复进行中” or “回复未完成” line describes partial content without inventing a new card style. Do not write streaming prefixes into client storage until terminal interruption. Keep settled question/approval cards before the continued answer; active questions may follow their introducing text. Follow a growing answer only while the reader stays near the bottom, and preserve position when they scroll up. Polling must not overwrite a newer accepted-task snapshot or replay unchanged task history through the reducer. Native Electron scroll/typing performance still requires device verification after unlock.

The read-only “执行过程” extends the existing quiet activity disclosure in `apps/desktop/src/Execution.tsx`, shared by private conversations, group deliveries and personal history. The outer native disclosure loads scoped record metadata only when opened; each nested disclosure loads its text only when opened. Keep the list flat with fine neutral dividers, wrapping (44px minimum) entry rows and inherited Chinese system reading text (12px, line height 1.7). Phase and sequence labels retain the incumbent muted metadata role. This is supporting activity, not a second conversation frame or code-display theme.

Long record text preserves whitespace and wraps within a named, keyboard-focusable region capped at (240px). Keep list pagination and content pagination explicit, including the notice that only part is loaded; polling follows only the already reached recording tail and must not skip unread pages or reset expanded content. Scope remains bound to the exact Bot/run plus private conversation revision or group conversation identity. Switching scope, reading, refreshing or paging must preserve the owner’s draft and reading position.

The reader states that reading never reruns tools, reuses old approval or resumes a task, and that non-text output is represented by an explanation rather than saved again here. Keep old-environment/reconnect guidance, preparing, missing/unavailable, empty, failed-read/retry and incomplete-record feedback distinct. Show task phase independently from record completeness: a completed or stopped task does not prove that every execution record was retained. The protocol33 source candidate and its bounded browser finish evidence are recorded in `.impeccable/surfaces/client.md`; original protocol32 activation remains separate.

Native DSH plans use a quiet, expandable list with actual pending/in-progress/completed states. Human waits show “等待你的回复”. Live questions and one-shot web approvals reuse the existing inbox row language in both the transcript and inbox; the connected inbox excludes demonstration requests. Question choices have no preselected answer, always allow free text, and preserve per-request drafts. Approval cards show the full URL and separate “仅允许这一次” from “拒绝”; a question answer does not grant permission. Retry freezes an uncertain submitted payload so it cannot silently become a different reply. New requests scroll into view, while ordinary polling and draft edits preserve the reading position. Cancelled or interrupted requests remain readable and cannot be answered.

The compact status row in `apps/desktop/src/Conversation.tsx` sits immediately above the composer, using muted (10px) text, wrapping gaps and a small soft action. Starting, running and takeover-paused tasks show their current state, executed step count and “停止任务”. An uncertain submission shows “正在确认任务是否启动” with “重试发送”; the pending composer stays disabled until that request is resolved.

Failed, stopped or interrupted tasks with an original prompt show “任务已中断，已保存文件仍保留” and “继续处理”. Service restart marks active tasks interrupted without automatically replaying them. Continue reuses the original request and saved input files in a new run directory, preserving previous outputs. `apps/desktop/src/App.tsx` and `apps/desktop/src/state.ts` keep definite rejection editable by clearing pending state while preserving drafts and attachments; ambiguous network results retain the original request ID for deduplication. Clear a submitted draft only after its matching runtime acknowledgement, without clearing later edits.

Closing the client leaves Linux work running. Relaunch and VM cold start preserve task history, files and the demonstrated shared login. Do not equate the screen being closed or disconnected with a stopped task.

### Connection and Settings

Connection state stays in the existing sidebar footer, desktop status line and divided settings rows. `apps/desktop/src/Settings.tsx` shows whether the DeepSeek API is configured and offers reconnect/retry for local Linux. The API key stays in the guest's private configuration; the renderer receives configuration status, never the key. The Electron preload exposes platform metadata and the allowlisted runtime bridge in `apps/desktop/electron/preload.ts` and `packages/protocol/src/index.ts`; `apps/desktop/src/Runtime.tsx` consumes that bridge rather than accessing Node or the network directly.

Keep offline errors near the affected desktop/settings control while retaining conversation history and files. Browser-only settings and desktop previews remain explicitly disconnected demonstrations. Mobile, remote/cloud execution and production installers are deferred.

### Desktop Reminder Settings and Navigation

`Notifications.tsx` extends Settings between appearance and model/computer settings through the existing flat rows, Chinese system type, neutral actions and inline feedback. Reminders start off and require explicit opt-in. The checkbox's whole label reuses the house secondary action and skill-toggle treatment; its reviewed target is (87 × 36px), rather than the native checkbox alone. That observation adds no new control token or CSS rule. Reading, saving, unavailable and unsupported states retain the existing status/error hierarchy and disable the affected controls.

Keep the test action separate from a task or approval. “测试提醒已提交给系统” reports submission only; adjacent guidance explains that system notification settings and Do Not Disturb decide visibility. Generic reminder text names the event type without task or question bodies. Failure names system refusal and recovery; unsupported or partial availability retains the Inbox path. Unreadable settings explain that existing content is retained. Full client quit stops discovery of new reminders while Linux tasks continue, with results still available after reopening.

Private Bot choices extend this section beneath the global opt-in, test and guidance. Use the native fieldset/legend “各 Bot 的私聊提醒”, its local/private scope description, named divided rows and the same whole-label checkbox treatment. A choice takes effect on this computer for that Bot's private results, questions and approvals; group reminders, Inbox and task execution remain unchanged. The global opt-in stays independent: its off state suppresses reminders while retaining editable Bot choices.

Keep canonical names and choices together in the main-process status snapshot. Offline or unavailable choices remain visible and disabled, with retained-selection guidance; an empty list explains that creating a Bot enables selection. Conflict or changed-workspace feedback stays inline and asks for rereading or reselection without silently changing another Bot. The only new presentation rule is the borderless, padding-free fieldset reset with the incumbent (20px) separation; it creates no new spacing, control or type token.

Notification clicks navigate only. Private task results reuse the named Bot's wide `ChatHistory.tsx` Dialog with the exact run and conversation revision, including a result in the current conversation. Its conditional “任务结果” description says it reads saved results; the ordinary “历史对话” description keeps the older-conversation meaning. Both remain read-only, do not restore model context or rerun tasks, and warn that file actions read currently retained content. Exact question/approval IDs focus Inbox/Requests; group results select their named group. A missing target explains the failure without choosing another conversation.

Defer navigation while any dialog is open, including unsaved profile, key, file and remote-screen dialogs. The quiet notice explains that the reminder opens after closing the current dialog. Keep its draft, selection and focus intact, and preserve the house Dialog's keyboard containment and Escape dismissal.

`outputs/notifications/design-review.md` returns `ship` only for the seven authoritative synthetic production React IAB captures listed in `.impeccable/surfaces/client.md`, at (1280 × 720px) and (1024 × 720px). `keyboard.json` records focus wrapping, Escape closure and retained draft text. The fixture sent no native notification or OS permission request. Lifecycle, store/IO, IPC and runtime checks are separate functional evidence. Native permission/delivery, an actual cold notification click, native acceptance/activation, signing/public distribution, release-notice audit and full parity remain open; platform delivered-item restoration code is not native cold-click proof. No new visual world, comp, seed, raster asset or token follows from this addition.

The later private-choice review in `outputs/reminders/design-review.md` returns `ship` with no material frontend fixes for six named synthetic production React section captures: off/light, on/compact dark, offline/light, conflict/compact dark, long-name/compact light and empty/dark. They cover (1280 × 720px) and (1024 × 720px), with the complete fieldset and no recorded horizontal overflow. The supplied single detector reports (109) incumbent findings and none in the new fieldset CSS; it clears no historical debt. Functional logs remain separate from this visual result. That frontend packet established neither native preference persistence nor OS delivery/click/cold activation; its candidate UI was separate from the original user instance. Mobile, cloud and full Rakazo/Tobs foundation parity remain open.

Separate functional evidence in `outputs/reminders/native-verification.json` now records real no-key Electron save/reopen persistence, unchanged legacy bytes on read, migration only on explicit save and restored Bot choices while the global opt-in stayed off. `original-activation.json` records normal protocol-32 client activation on original data with all (29) native fields and saved product state preserved, the same two Agent-owned screens and an unchanged absent reminder file. No model tasks, OS reminder sends, VM restart or Linux code change occurred. The initial original chat view was restored. These records add no visual canon and do not establish OS delivery/click/cold activation or broaden the six-capture frontend verdict.

### External Tools in Settings

Candidate21 extends the divided Settings surface with “外部工具”, without adding a workspace tab or changing the visual world. Reuse the neutral palette, system type, Lucide outlines and house fields/buttons. Connection rows wrap metadata and actions; inline editor, reviewed catalogue, per-Bot selection and recent calls remain flat sections. Repeated section/tool/receipt headings use (14px, 500); helper text uses (12px) with (1.7) line height. Editor fields have a (16px) gap. Checkbox labels retain a (44px) minimum height; actions wrap in compact desktop content.

Private address and Bearer replacement inputs begin empty for saved connections; blank values retain the current version. Keep their no-readback and page-memory-only explanation next to the fields. Refreshing metadata must retain the current draft. Conflict recovery shows current public metadata and requires an explicit version choice before saving; uncertain saves expose receipt inspection and the exact same save retry. Tool selection and enablement belong to the named Bot and remain separate from checking the connection and from per-call approval. Archive confirmation names the connection, explains cancelled pending calls and possibly completed external effects, and states that restore requires fresh Bot consent.

Schema, call arguments and receipt text use bounded, labelled, keyboard-focusable scrolling regions with a repeated maximum height of (240px), wrapping long values within the available width. Preserve focus outlines and reachable approval actions below long arguments. Recent calls identify the selected Bot/connection and show only the latest 20; querying a receipt never executes the tool. “结果不确定” keeps its warning to verify the target service before another submission. Service failure explains that ordinary conversation and the existing workspace remain available.

The eight final MCP captures and `outputs/mcp/ui-dom.json` cover production web components through an explicitly synthetic bridge, with (960px) main and (420px) compact content inside a (1280 × 720px) desktop viewport. They establish neither native Electron nor mobile behavior. `outputs/mcp/design-review.md` returns ship for this bounded frontend presentation. The console record retains two fixture-HMR createRoot warnings; they are not a reusable mounting pattern or evidence of a clean overall console. A single detector pass reports 94 advisories and an incumbent fenced-code font warning; neither supplies new tokens or legitimizes a defect. No shipping raster asset was added. Native activation and preservation remain unverified against the original protocol15 instance.

### Personal Bot Copy

`CopyBot.tsx` extends the same workspace through a personal Bot's existing sidebar menu and the house Dialog. Reuse its neutral light/dark surfaces, Chinese system type, outline copy icon, fields and primary/secondary actions; no new palette, type role, spacing scale or CSS is introduced. The normal dialog stays (430px) wide and scrolls internally within its existing viewport cap. Its source → new name → saved responsibilities/model → optional saved work preferences → create order keeps the new Bot name and named action primary.

The preview reads saved source configuration rather than unsaved profile or preference drafts. Only the target name and “包含工作偏好” checkbox are editable; responsibilities and included preferences stay read-only, and the model is a quiet label. The opening explanation names the independent Bot, copied responsibilities/color/model and the boundary: chat, schedules and tool authority do not copy; knowledge and skills use their separate import/export flow. A source conflict retains the entered name and preference choice, shows the source-update guidance and requires explicit “载入最新来源” before reviewing the updated preview.

A pending copy replaces the editor with its target name and distinct “核对复制结果” / “重试同一次复制” actions. Closing retains the exact request; reopening and background reconciliation only read its receipt. Retry is an explicit effect using that same request. Keep the sidebar “Bot 复制 · 核对进度” entry reachable and recovery/older-environment guidance beside the actions. App ownership lets a late receipt add the result without changing the user's current navigation or draft after the Dialog closes. Preserve the shared Dialog's focus containment, Escape dismissal and focus return.

`outputs/copy-ui/design-review.md` returns `ship` with no material fixes for four saved synthetic production-React captures at (1280 × 800px) and (1024 × 720px), across the named light/dark editor, menu, pending and source-conflict states. Their paths and limits are recorded in `.impeccable/surfaces/client.md`. Copy requires the protocol34 source candidate; the normal app/service remain protocol33. This is bounded frontend finish evidence, not native Electron acceptance, a clean34 image, activation/preservation, mobile/cloud, full-parity or unpictured-width acceptance.

### Group Copy

`CopyGroup.tsx` extends the existing sidebar menu and (430px) house Dialog with “复制群聊”. Keep the Chinese system type, neutral light/dark surfaces, outline copy icon, existing field, divided member rows and primary/secondary actions. The native member list resets only its margin, padding and markers; it introduces no palette, type, radius or spacing scale. The Dialog owns viewport-bounded vertical scrolling.

Reading order is the same-Bot/empty-group explanation → named source → editable new group name → read-only saved member list → explicit latest-source loading → create. The new group uses the existing Bots with shared profiles/settings; chat history and attachments do not transfer, and creation runs no task. Retain every saved member visibly, including archived, unsynchronized or changing members, and block first creation until members and source are available. Do not silently drop unavailable members or turn the snapshot into a member picker. “载入最新来源” replaces the reviewed source snapshot while retaining the entered target name.

Pending recovery replaces the editable form with the retained target/source and separate “核对复制结果” / “重试同一次复制” actions. Persist the exact version-bound request before submission, without registering a placeholder group. Closing retains that request; reopening and background reconciliation read receipts, while retry explicitly resubmits the same request. Keep “群聊复制 · 核对进度” reachable in the sidebar and explain older-environment or recovery restrictions beside the actions.

`copies.ts` shares this lifecycle with personal Bot copy. Accept only a matching confirmation; late callbacks cannot select a result after closure, clear a newer pending request or replace a newer draft. A valid completion retires only its own reader/busy state so an older outstanding read cannot block the next copy or release its reader. A retry refused by an older command reader cannot disprove an earlier uncertain submission, so preserve the prior request.

The five saved synthetic production-React states, detector comparison and functional evidence are bounded in `.impeccable/surfaces/client.md`. `outputs/group-copy-ui/design-review.md` found a reader-ownership fix; `design-verdict.md` scores Fix 1 resolved and returns `ship` only for that fix. This is a protocol35 frontend source extension: the normal app/service remain33 and the retained candidate/payload remain34. It establishes no native acceptance, current35 payload, installation or activation.

### Personal Bot Archive and Restore

Candidate22 extends the same conversation-first workspace through the existing Bot profile, named house confirmation dialog, retained history and Settings archive rows. Reuse the neutral themes, Chinese system type, Lucide outlines, avatar and buttons; this is a lifecycle state, not a new identity or surface composition. The dialog identity uses the incumbent compact title treatment (14px, 500). The history banner uses muted helper text (12px, line height 1.7), a fine bottom divider and wrapping actions. Settings rows and dialog actions wrap within available desktop width.

Archive copy names the Bot and explains retained chat, files, knowledge, preferences and unsent drafts, with schedules disabled. Require the current task to stop and the computer to disconnect through its saved-content confirmation before archive; queued group collaboration must be explicitly resolved or cancelled in its named group. Do not silently cancel group work, native work or user files. Archived history and drafts stay readable and read-only, with mutation panels disabled and restore reachable from history or Settings. Groups retain their references even when all personal Bots are archived; the empty personal rail explains the state.

Pending operations use the explicit header subtitle “Bot 操作待核对”, retain the draft and block new work until resolved. Receipt inspection only reads; retry uses the same operation, and closing the dialog does not withdraw it. Restore states that computers and old tasks stay stopped and schedules require manual re-enablement. Preserve the house dialog focus containment, Escape dismissal and focus return.

The nine final `lifecycle-final-*.jpg` captures and `outputs/lifecycle/ui-dom.json` cover production React components through an explicitly synthetic bridge: three wide states at (1280 × 720px) and six compact desktop states at (960 × 720px). The Settings list capture shows the requested inner-scroll section. DOM evidence records no page overflow, retained read-only draft/disabled panels, the pending subtitle, blocked confirmation with a connected computer, retained groups and keyboard focus wrapping/Escape/focus return; final console readback is empty. Root inert behavior is not observable from that scoped DOM record. `outputs/lifecycle/design-review.md` returns ship for this bounded frontend presentation only. One detector pass reports 94 advisories and one incumbent fenced-code Sfmono warning; it establishes no new token or type rule. No raster asset was added. Original protocol15 remains active and candidate22 is unactivated; native Electron and original-state preservation remain unverified.

### Personal Conversation Context and History

Personal conversation actions extend the incumbent header through `NewChat.tsx` and `ChatHistory.tsx`, with separate, named house dialogs. Preserve the existing Avatar, compact Bot name, Chinese system type, neutral buttons and quiet consequence-first description. The history reader uses the wide dialog and existing conversation bubbles. Its “对话编号” numeric selector reuses the house label and field treatment; it creates no separate field, palette, type role or CSS rule. Group actions retain their own ownership and flow.

“开启新对话” names the selected Bot and requires “确认开启”. Copy distinguishes a fresh model context from retained history, preferences, knowledge, files, computer/browser login and unsent text/attachments; nothing is automatically sent. A running private task refuses the transition while group tasks remain separate. Uncertain results retain a read-only composer and visible draft, with distinct “核对操作结果” and “重试同一次操作” controls. Receipt lookup reads; retry retains the same request, and closing does not retract submitted work. A validated acknowledgement removes that pending state; the current transcript follows the acknowledged conversation revision while the draft stays visible.

History is a numbered, read-only reader, with explicit “读取记录”, “最新记录” and “更早记录” actions. Preserve the warning that reading does not restore model context or rerun tasks, and that file actions read currently retained content rather than proving an old file still exists. Local records stay behind the clearly labelled “本机旧缓存（可能与后端记录重复）” disclosure. Polling must not change the reader's selected page. Reuse the house Dialog's focus containment, Escape dismissal and focus return. Execution details use the same native disclosures and named output region inside that dialog; include closed `summary` controls and focusable output in its keyboard order so Enter can open a record before Tab reaches the later actions. Closing the reader retains the unsent conversation draft.

`outputs/chats/design-review.md` returns `ship` for seven authoritative synthetic production React App/Dialog IAB PNGs at (1280 × 720px) and (1024 × 720px), listed in `.impeccable/surfaces/client.md`. The final history captures supersede obsolete history images. `keyboard.json` proves focus wrapping and Escape/focus return; its `reconciledDraft: null` is not composer-editing proof. The corrected `receipt.json` explicitly records `beforeReadOnly: true`, `afterReadOnly: false` and the retained synthetic draft. Initial enabled/disabled-attribute probes do not establish editability. This frontend finish evidence does not establish native Electron acceptance/activation, actual-model context isolation, durable real-data preservation, resumable parallel personal threads, permanent erase or full competitor parity. No new visual world or token follows from the empty single detector result.

### Work Preference History

`apps/desktop/src/MemoryHistory.tsx` extends the existing workspace memory heading with the quiet “历史版本” text action. Keep the named Avatar/Bot, Chinese system type, neutral buttons and the existing wide Dialog. The saved-current memory editor remains the owner of current preferences. History uses a flat two-column grid: a (210px) divided version list and a flexible full-content reader, with a (20px) gap. Selected rows reuse `selected`, hover reuses `hover`, and separators reuse `line`; no nested cards, imagery, new palette or motion is introduced.

Version rows stay in descending order with their exact version, current marker, save source and time. The selected value is complete plain text in the house read-only textarea, with internal scrolling and reachable footer actions. Its local minimum height is (210px), maximum height is (32vh), and vertical resizing remains available. The description and version rows use the observed (13px) supporting type; disclosure, status and timestamps use (12px). These are scoped implementation facts, not a new global typography or spacing scale.

Explain that history is human-only inspection and is never automatically replayed to the model. Retain the truthful maximum of (50) recent versions, reduced by the serialized-history byte budget, and the notice when older versions have left retention. Older saved content appears as “现有内容基线”; do not invent pre-migration revisions. An empty version stays readable as an empty preference state. Removing current preferences does not erase retained history.

“载入编辑器” only stages the selected older text and closes the reader; the existing separate Save performs the revision-checked CAS update. Preserve unsaved memory/chat/other-Bot drafts and refuse staging during save, conflict, lifecycle change, disconnection, an older environment or a stale reviewed profile revision. Keep refresh/older navigation explicit, preserve selected history during polling, and reuse Dialog focus containment, Escape dismissal and focus return. Failed reads retain current content and recovery; older environments show the disabled history entry and update explanation.

Keep the reviewed current revision independent of older-page responses. A validated initial/latest read establishes `reviewedRevision`; an older-page read cannot advance it to an intervening edit. If either the live profile or the fetched page differs from that reviewed revision, loading stays disabled with the existing refresh explanation until an explicit successful latest refresh. The subsequent separate Save still fences later edits. This functional guard changes no layout, style, wording or asset.

`outputs/preferences/design-review.md` returns `ship` for six required production React/synthetic-bridge desktop states at (1280 × 720px) and (1024 × 720px), recorded in `.impeccable/surfaces/client.md`. `ui-confirmation.json` records bounded layout/inertness/action states; `browser-actions.json` records keyboard focus/Escape/return, staging followed by explicit Save and retained chat draft. `design-paging-verdict.md` separately returns scoped `ship` for the reviewed-baseline correction: the regression failed first, then nine focused UI/IPC tests and the supplied (432) client/(7) tool checks passed. The six visual PNGs remain unchanged; this is no new whole-surface approval. The single detector remains (109) findings: (107) incumbent debt and two advisory (13px) off-documented-ramp notices, without a second scan or global ramp change.

Separate isolated native32 evidence in `outputs/preferences/native-paging-{edit,stage}.json` and `native-paging.json` records review at revision8, an authenticated synthetic other-client edit to9, older-page load refusal, explicit latest review, stage-only backend9 and separate Save creating10 while retaining all versions1–10. The other six profiles/settings remain exact and model turns are zero. Earlier native reopen/service-restart persistence at8 remains separate valid evidence. This targeted native memory path does not establish broader native/API/model or whole-surface acceptance, original-data activation/preservation, image/distribution readiness or complete Rakazo/Tobs parity; the original user instance remains protocol26.

### Group Archive and Restore

Recoverable group archive uses the separate `GroupArchive.tsx` flow inside the incumbent house Dialog. Keep the existing grouped Avatar, compact named identity, Chinese system type, neutral actions and error ink. The conversation header, readable transcript and bottom composer retain their established positions; no new CSS, token, palette or navigation model is introduced. Archived and pending groups keep their visible draft with sending, recipient changes and attachment mutation disabled. The header distinguishes “已归档 · 历史只读” from “群聊操作待核对”, and the existing Settings “已归档” rows retain separate history and recovery actions.

Confirmation names the group and explains retained members, history, attachments, files and unsent drafts. Pending results distinguish “核对操作结果” from “重试同一次操作”; closing does not retract a submitted operation. Busy refusal names unfinished group collaboration and offers “返回群聊”. Group recovery does not inherit personal Bot computer or schedule semantics: independent member tasks need not stop, member private chats/computers are unaffected, and restore leaves member states/permissions unchanged without dispatching old messages. Preserve the house focus containment, Escape dismissal and focus return.

`outputs/group-archive/design-review.md` returns `ship` for six actual synthetic production React IAB captures: four at (1280 × 720px), two at (1024 × 720px), across the recorded light/dark states, plus two final confirmation captures after the acknowledged-metadata correction. The supplement confirms the same visual world; layout, styling and copy did not change. `keyboard.json` records forward/reverse focus wrapping and Escape/focus return. This is bounded frontend finish evidence; it does not establish native Electron, actual-model/VM execution, durable real-data preservation or whole-product acceptance. The group-specific evidence and states are recorded in `.impeccable/surfaces/client.md`; the sidecar specimen remains separate from personal Bot lifecycle.

### Read-only Environment Checks

The existing Settings column adds a quiet “运行环境” section using house buttons, neutral badges and flat divided rows. Keep the sidebar, header and first-viewport Settings structure. Inspection is an explicit read-only action, separate from the incumbent “重试连接”/“重新连接” action. Show specific issues first and disclose all 17 checks only on request. Loading disables the inspection action and announces progress; failures retain their explicit feedback.

Use the existing (14px) row label and wrapping muted supporting copy. Expanded detail is a labelled, keyboard-focusable scrolling region capped at (320px); its toggle remains reachable below it. “上次检查” describes a prior observation, not a live connection indicator. Unsupported and unchecked states explain the observation boundary. Model “已保存” means saved configuration; DSH SDK and graphical command “已找到” mean presence only. Keep the note directing API connectivity and actual desktop execution to their separate checks. When the runtime is disconnected, do not claim ordinary conversation is available merely because an optional tool service is unavailable.

The seven viewed `diagnostics-final-*.jpg` captures and `outputs/diagnostics/ui-dom.json` cover production Settings components through an explicitly synthetic bridge: wide (1280 × 720px) and compact desktop (960 × 720px), with Settings inner-scroll views and the final dependency row visible. Two bounded inspection rounds corrected asynchronous captures; final evidence records (14px) labels, the (320px) list, keyboard End at (479/479), reachable footer, no page overflow and an empty preview console. `outputs/diagnostics/design-review.md` returns ship with no material frontend fixes. One detector pass reports 94 advisories and one incumbent fenced-code Sfmono warning; neither creates a system rule. No new world, comp, seed or raster asset applies. Native Electron acceptance and candidate23 activation remain unverified; original protocol15 remains active.

### Coordinated Host Recovery

Working24 reuses the existing Settings row, protected Dialog, monochrome system type and flat divided rows for whole-Linux recovery. The dialog names every affected Bot and its human/Bot ownership; fresh unchecked saved-content consent precedes restart, while running or waiting tasks block it and expose their named task action. Unknown stop outcomes offer receipt inspection without another shutdown; an observed stopped environment exposes explicit start, and unissued preparation exposes cancellation. Wrapping house actions and the global neutral notice retain editable drafts and readable history/saved files while new tasks and effectful controls wait. The nine viewed synthetic `reboot-*.jpg` states cover (1280 × 720px) and (960 × 720px) desktop classes only; isolated ManagedHost/two-paid-DSH-turn evidence is functional, not visual or original-Electron proof. Original15 remains active, working24 unactivated; original preservation/backup/takeover/dialog acceptance, provisioning, mobile/cloud and full parity remain open. No new tokens, raster or visual world follow from this extension or the single detector's 97 incumbent CSS findings.

### Dialogs and Feedback

Bot profile editing uses the existing dialog and field styles. Names and roles remain editable after a conflict: show the current saved values inline, and require “保留编辑，按此版本重试” before another save. Do not ask users to close a form to recover a conflict. The memory panel similarly displays the current saved preferences and retains its independent draft, with “保留草稿，按此版本重试”. Saving, failure feedback and draft versions belong to the Bot that submitted them; switching Bots must not move those states. Preserve newer typing and ignore older save acknowledgements. This UI has been exercised in the isolated web preview and synthetic tests; new profile/memory controls still await native Electron interaction checks while macOS is locked.

Creation, file preview, and expanded computer views share the same softly rounded dialog. Preserve the labelled dialog, inert background, focus containment, Escape dismissal, and focus restoration. A focused, controlled desktop or browser screen owns Escape as described above; after focus leaves that screen, plain Escape dismisses the dialog normally. Dismissal preserves takeover. Toasts are compact, dark, bottom-centered status messages. Neither dialogs nor toast styling should introduce a separate visual identity.

## Do's and Don'ts

### Do:

- **Do** preserve the lowercase daban identity and Grok Bot reference.
- **Do** use the existing semantic color variables in both themes.
- **Do** keep Chinese text readable, with relaxed message line height and wrapping for long content.
- **Do** preserve visible keyboard focus, accessible control names, and modal focus containment.
- **Do** keep takeover ownership visible for the selected Bot and require explicit handback.
- **Do** identify each webpage request by its source tab and full URL, and offer a way to reveal an inactive requesting tab.
- **Do** label demonstration content and disconnected functionality where the user encounters them.
- **Do** preserve interrupted-task files, editable drafts after definite rejection, and request identity while a send result is uncertain.
- **Do** preserve per-Bot profile and memory drafts, show saved values for conflict review, and never let late save acknowledgements replace newer state.
- **Do** show native task plans and human requests in the conversation and real inbox; preserve independent reply drafts and exact uncertain retries, and keep ordinary answers separate from one-shot permissions.
- **Do** render only visible native response text, preserve stable final-bubble identity and incomplete labels, and keep reader scroll and unchanged history independent of token updates.
- **Do** show computer lifecycle, pending-result and running-task reasons beside the controls; retain drafts during connection changes and require fresh saved-content confirmation before stop.
- **Do** distinguish the shared skill library from per-Bot enablement, retain chat and editor drafts, and make conflict, recycle and restore consequences explicit.

- **Do** keep private replacement fields empty on readback, retain active drafts during refresh, and distinguish connection checks, per-Bot tool choices and single-call approval.

- **Do** retain readable archived history and drafts, name archive/restore consequences, and expose receipt inspection and the same-operation retry while results are pending.

- **Do** keep read-only observation separate from connection repair, label prior checks as observations, and distinguish saved configuration or found dependencies from operational capability.

- **Do** keep Notes private to the selected personal Bot, retain independent Notes and chat drafts, and require an explicit conflict-version choice before saving.
- **Do** keep an uncertain Notes editor sealed, preserve its exact Bot-bound intent, and distinguish receipt inspection from the explicit same-request retry.

### Don't:

- **Don't** introduce a marketing hero, decorative dashboard grid, or a new accent palette into this workspace.
- **Don't** apply avatar colors to primary buttons, whole panels, or conversation text.
- **Don't** squeeze a persistent three-column layout into a narrow web viewport.
- **Don't** imply that closing the workspace or changing Bots returns control.
- **Don't** present browser-only previews, unconnected Bots, routine configuration, approval examples or model labels as capabilities beyond their actual connection.
- **Don't** imply that “继续处理” resumes a crashed process; it executes the original request again with the saved inputs in a new run directory.
- **Don't** add renderer window controls over the native macOS traffic-light area.
- **Don't** imply that importing a skill runs it, that restoring it restores consent, or that instruction text grants tools or permissions.
- **Don't** present receipt inspection as execution, uncertain external effects as safe to repeat, or connection restoration as renewed Bot consent.
- **Don't** treat Bot restoration as permission to restart a computer, schedule, old task or delegation, or silently cancel queued group work to archive.
- **Don't** promise ordinary dialogue while the runtime is disconnected or present an environment check as recovery, installation or successful tool execution.
- **Don't** present Notes saving or completion as task execution, an unknown receipt as success, or a failed list read as an empty collection.
