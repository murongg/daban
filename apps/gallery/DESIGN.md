---
name: "Daban Gallery"
description: "A spacious neutral Bot catalog with Daban's own identity."
colors:
  canvas: "#ffffff"
  soft: "#f7f7f6"
  hover: "#eeeeec"
  ink: "#0a0a0a"
  muted: "#666666"
  line: "#e9e9e7"
  line-strong: "#d5d5d2"
  strong: "#0a0a0a"
  strong-hover: "#303030"
  on-strong: "#ffffff"
  focus: "#0a0a0a"
  danger: "#b23e3e"
  danger-soft: "#fff3f3"
  canvas-dark: "#0a0a0a"
  soft-dark: "#191919"
  hover-dark: "#252525"
  ink-dark: "#f5f5f5"
  muted-dark: "#a3a3a3"
  line-dark: "#292929"
  line-strong-dark: "#424242"
  strong-dark: "#f5f5f5"
  strong-hover-dark: "#d7d7d7"
  on-strong-dark: "#0a0a0a"
  focus-dark: "#f5f5f5"
  danger-dark: "#f19b9b"
  danger-soft-dark: "#331f1f"
typography:
  headline:
    fontFamily: '"Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(36px, 4vw, 48px)"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: '"Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: "-0.02em"
  body:
    fontFamily: '"Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '"Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: '"Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "12px"
  tile: "20px"
  dialog: "24px"
  pill: "999px"
  icon: "50%"
spacing:
  compact: "8px"
  small: "12px"
  regular: "16px"
  group: "20px"
  roomy: "24px"
  section: "28px"
  wide: "32px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.strong}"
    textColor: "{colors.on-strong}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.strong-hover}"
    textColor: "{colors.on-strong}"
  button-secondary:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  button-quiet:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  button-danger:
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  navigation:
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "9px 16px"
  navigation-current:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
  badge:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  catalog-tile:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tile}"
    padding: "28px 24px 24px"
  login-dialog:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "36px"
---

# Design System: Daban Gallery

## Overview

**Creative North Star: "The open Bot catalog"**

The gallery follows the user's supplied [x.ai/bot](https://x.ai/bot) reference and its [marketplace](https://x.ai/bot/marketplace) adaptation: spacious medium-weight type, horizontal navigation, capsule controls, and pale-gray avatar tiles. This newer direction supersedes the earlier desktop-sidebar and divided-list contract. Daban retains its own otter mark, six robot assets, and local system font stack.

This app-scoped record describes the built `src/app`, React components in `src/web`, and `style.css`. Browsing, search, inline details, downloads, publication, and token administration share the same neutral surfaces. Existing copy and real loaded records carry the content; reference-site assets, font files, endorsements, categories, and marketing claims are not part of this system.

**Key Characteristics:**

- White and near-black surfaces with quiet gray supporting text.
- Large medium-weight headings, generous space, and a full-width search capsule.
- Soft avatar-led tiles with compact horizontal phone layouts.
- Pill actions, navigation, badges, and detail tabs.
- Persistent Daban robot identity and equivalent light/dark theme states.

## Colors

### Primary

`strong`, `strong-hover`, and `on-strong` provide neutral primary-action contrast. Dark mode reverses it to a pale action on a near-black canvas. Keyboard focus uses the same high-contrast neutral family.

### Neutral

`canvas` is the page, header, form, and dialog surface. `soft` holds catalog tiles, the search capsule, secondary actions, current navigation, and the download panel; `hover` supplies quiet feedback. `ink` carries headings and active controls; `muted` carries descriptions and metadata. `line` separates detail and form regions; `line-strong` defines fields and technical disclosures.

`danger` and `danger-soft` remain semantic error and destructive-action colors. The `-dark` frontmatter entries record mode equivalents selected through the root `data-theme` attribute; source CSS reuses the same semantic custom-property names. Appearance follows the system until the visitor selects light or dark with the header control, then remembers that choice locally. The static export restores the preference before styles and hydration using a same-origin script, retaining the strict CSP. Robot artwork supplies identity color without expanding the interface palette.

**The Neutral Action Rule.** Primary actions use the strong neutral pair; robot colors distinguish identities rather than capability, trust, or action priority.

## Typography

The recorded local stack begins with Helvetica Neue and retains system and Chinese fallbacks. Page headings scale from (36px) to (48px), use medium weight (500), tight tracking, and balanced wrapping. Phone headings remain (36px). Introductory copy uses (17px), reducing to (15px) on mobile, with open leading (1.75) and a maximum measure (70ch).

Tile titles use the recorded title role and reduce to (17px) on phones. Tile descriptions use (14px), leading (1.65), and a three-line clamp; phones use (13px) and two lines. Role text preserves authored line breaks at (15px), leading (1.9), within a detail body bounded at (75ch). Labels and navigation use (14px); supporting metadata uses (12–13px), with phone tile metadata at (11px). Versions use tabular numerals; issued tokens and technical identifiers use monospace.

**The Measured Hierarchy Rule.** Give the gallery title room and keep medium-weight names, readable descriptions, and quiet metadata distinct beneath it.

## Layout

A horizontal header uses brand, flexible navigation, and one account action in three columns. Its minimum height is (88px), with padding (18px 32px) and a gap (40px). There is no persistent sidebar or duplicate workspace header. Publication and token navigation appear according to session permissions.

Catalog and detail views share a centered outer maximum width (1408px) and padding (64px 48px 96px). The full-width search capsule has padding (6px), an input height (46px), and an inset submit action. A real loaded count precedes a four-column tile grid with gaps (20px). Tiles have a minimum height (310px), centered avatars, and padding (28px 24px 24px).

At (1240px) the catalog becomes three columns and catalog/detail side padding becomes (32px). At (960px) it becomes two columns, header spacing tightens, and the detail aside narrows. At (760px) the header becomes brand/account above wrapped navigation; views use padding (36px 24px 64px), detail and form columns stack, and search input text stays comfortably readable. At (560px) the catalog becomes one column of horizontal tiles, with a minimum height (170px), smaller avatars, and gaps (16px).

Details remain inline: back action, identity, pill overview/version tabs, then body beside a softly filled download aside (280px). Management views have a maximum outer width (928px), paired fields, and separate publication/token forms. On narrow screens those fields become one column.

**The Single Account Action Rule.** Keep sign-in or sign-out in the shared header; permission-gated management views use the same navigation on desktop and mobile.

## Elevation & Depth

The page remains flat. Pale surfaces distinguish tiles and the download panel; fine rules separate detail sections and forms. Tile hover changes the surface and shifts its arrow (3px), without lifting the tile. Interface states use (160ms ease); tile backgrounds use (180ms ease). Reduced-motion preference removes transitions.

The native login dialog intentionally uses the modal shadow (`0 24px 100px #00000026`) over the dimmed backdrop (`#0a0a0a66`). This is the reviewed modal treatment, distinct from the flat catalog surfaces.

**The Flat Tile Rule.** Use soft filled catalog tiles without elevation; reserve the modal shadow for the deliberately invoked login dialog.

## Shapes

Capsules define actions, search, navigation, tabs, badges, and file-selector buttons. Fields use the recorded control radius; catalog tiles, upload regions, and the download panel share the tile radius; the login dialog uses the broader dialog radius. Icon buttons are circular. Robot artwork retains its original silhouette and transparent space through `object-fit: contain`.

## Components

- **Buttons:** Minimum height (42px), comfortable padding, normal label weight, strong neutral primary actions, soft secondary actions, and transparent quiet actions. Destructive outlines retain a fine border and semantic red text. Disabled opacity is (0.45).
- **Search and fields:** Search is a full-width soft capsule with one inset action and focus around the whole boundary. Other fields retain a canvas background, fine border, and labels separated by (10px). Phone fields use (16px) text. Errors remain beside the relevant form; uploads retain the native file selector.
- **Header navigation:** Text-only pill items use the soft surface for current selection and hover. Account identity truncates within a bounded area; supporting account text hides on narrow screens. There is one account action and an adjacent 44px circular sun/moon control whose accessible name describes the next appearance.
- **Catalog tiles:** The whole tile opens details. Existing robot artwork leads the name, useful summary, publisher, and exact version. Desktop avatars are (88px × 96px); phone tiles use (56px × 64px). Opening details focuses the heading; returning restores the selected tile.
- **Badges and tabs:** Small capsule badges use the canvas against the soft download panel; withdrawn status uses error colors. Selected detail tabs use the strong pair, with soft unselected tabs. Version history stays separate, and technical identifiers remain under disclosures.
- **Login dialog:** Labelled native dialog with otter mark, close control, credential field, and full-width action. Its width is `min(440px, calc(100vw - 32px))`, with padding (36px), reducing to (30px) on mobile. Preserve Escape dismissal, modal focus, and focus restoration.

**The Stable Identity Rule.** Keep a template's robot color consistent across gallery views and loading states. The downloaded package preserves its authored profile color independently of the gallery's ID-derived artwork.

## Do's and Don'ts

### Do:

- **Do** carry the neutral palette, generous spacing, and capsule controls through every gallery view.
- **Do** preserve Daban's existing otter and robot artwork with stable ID-derived gallery identity.
- **Do** use soft tiles and panels for grouping while keeping the catalog flat.
- **Do** show real template names, useful summaries, publishers, versions, and loaded counts.
- **Do** preserve visible focus, native dialog dismissal, focus restoration, reduced motion, and readable phone layouts.

### Don't:

- **Don't** restore the superseded sidebar, divided-list catalog, or duplicate workspace header.
- **Don't** import reference-site assets, font files, endorsements, categories, or marketing claims.
- **Don't** turn robot colors into status, trust, or permission indicators.
- **Don't** switch gallery artwork to the package profile color after its content loads.
- **Don't** place publication or administrative forms inside the browsing grid or login dialog.
