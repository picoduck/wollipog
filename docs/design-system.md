# Wollipog Design System

This document is the design system for the Wollipog web and desktop UI: the tokens, the component
recipes, and the rules for layout, copy and interaction. Every UI change follows it. Where the
stylesheet still differs, the migration map (§19) names the change and the rollout order (§19.3)
says when it lands. Until a step lands, the code may not match this document.

Tokens live in `apps/web/src/styles.css`; the color schemes live in `apps/web/src/palettes.ts`.

The system builds on, and does not contradict, the settled designs for the composer (a capsule bar
with a settings sheet), the sessions list (threaded session families with one pill per attention
kind), the phone session header, and the one-bar desktop session chrome with its docked Pinned
Summary. The one deliberate deviation is stated in §4.4 (bar height 48px, not 44px).

Related documents describe behavior that this system styles:
[`accessibility-interaction-contract.md`](accessibility-interaction-contract.md) (menus, tabs and
keyboard focus), [`feedback-and-onboarding-contract.md`](feedback-and-onboarding-contract.md)
(confirmations and toasts), [`icon-system.md`](icon-system.md) (the icon inventory),
[`theme-and-shortcut-contract.md`](theme-and-shortcut-contract.md) (themes and color schemes) and
[`session-status-taxonomy.md`](session-status-taxonomy.md) (what each session state means).

Contents

1. Purpose and Principles
2. Tokens
3. Buttons and Action Placement
4. Page Anatomy
5. Lists, Rows and Cards
6. Master-Detail Layout
7. Dialogs and Sheets
8. Forms
9. Menus and Popovers
10. Tabs and Segmented Controls
11. Badges, Status and Meta
12. Empty, Loading, Error and Offline States
13. Toasts and Notices
14. Tables
15. Mobile and Compact Adaptation
16. Focus, Keyboard and Motion
17. Copy Rules
18. Icons
19. Migration Map
20. Problems Addressed
21. Known Tensions

---

## 1. Purpose and Principles

### 1.1 Subject, Audience and Job

- **Subject.** A control plane for AI coding agents: many sessions running on several machines,
  some of which need a human decision right now.
- **Audience.** A developer who keeps Wollipog open all day on a desktop (browser or Tauri), drives
  it from the keyboard, and checks it from a phone between meetings.
- **Primary job.** Show what needs me, let me act in one step, then get out of the way.

The vernacular is an instrument panel, not a marketing site: quiet surfaces, precise alignment,
tabular numbers, and a small number of lit signals. That is where the identity comes from.

### 1.2 Foundations

- **Color.** Keep the existing Wollipog palette and all five color schemes. Slate ground
  `#0b1118` / `#f6f8fa`, raised surface `#121a24` / `#ffffff`, text `#e6edf3` / `#17212b`, teal
  accent `#45d6cc` / `#055d56`, and the semantic hues green, amber, red and blue.
- **Type.** The system UI stack, one family. Six sizes on the existing `--text-*` names.
- **Layout.** One page header, one page container, one list-and-detail grid, one dialog anatomy.
- **Principles.** One control-height scale; radius by hierarchy; borders only where something is
  one object; one status pill; one notice; one menu.

### 1.3 Key Decisions

| Decision | Instead of | Why |
| --- | --- | --- |
| **Teal is reserved for two meanings: "you are here" and "the primary action".** Focus becomes a neutral ring, online becomes green, segmented selection becomes a neutral raised chip, the live pill becomes neutral. | Teal for the primary, selection, focus, tabs, the online badge, the segmented fill, the live pill and the zone frame. | When teal marks everything, it means nothing. |
| Flat fill from the existing `--primary-from` token (dark text on teal in dark, white on deep teal in light). | A teal gradient primary button. | A gradient wash is decoration; the fill alone identifies the primary. |
| Three container tiers (§5.1): **Section** (no border), **Surface** (one bordered group), **Callout** (tinted, attention only). At most one bordered level per page region. | A card for every section (`.skills-section`). | Equal boxes everywhere read as a pile with no hierarchy. |
| **Left-aligned page container**, same x on every destination. Width caps, but never centers. | Centered page columns (`max-width` plus `margin: auto`). | Centering produced six different content left edges (76–227px). |
| Color is used **only** for state. One status vocabulary, one tone table, Title Case, no `text-transform`. Metadata is neutral. | Colored pills everywhere, with tracked uppercase labels. | Color stops meaning state when it varies by surface. |
| Meta items are icon- or label-prefixed and separated by space (12px gap). A single `·` between two facts of one phrase stays (for example "4 Children · 2 Awaiting Input"). | Middle-dot meta chains (`A · B · C`). | Unlabeled values in a chain are unreadable. |
| Toasts at the bottom, above the docked chrome: bottom right on desktop, bottom center on phones above the tab bar or composer (§13.1). Never over the app bar. | Toasts bottom right, over whatever is there. | They landed on Send and on the phone tab bar. |
| The page header **is** the top of the page: title, one-line description, actions. The empty 54px bar is deleted on destination pages. | A 54px top bar holding only a title. | It duplicated titles and inverted the type scale. |

### 1.4 Principles

Use these to settle any case this document misses.

1. **Quiet slate, lit signals.** The UI is neutral. Color appears only where it carries state
   (amber: needs you; red: broken; blue: working; green: done or online) or marks the current place
   and the primary action (teal). If something is colored and is not one of those, remove the
   color.
2. **One name, one place, one size.** Every destination, action and state has one name. Every
   repeated element (button, badge, row, dialog) has one recipe and a small fixed set of sizes.
3. **Structure by space first, lines second, boxes last.** Group with spacing; separate with
   hairlines; draw a box only around one object.
4. **Say it once.** A fact appears in one primary home. No title twice, no status twice, no
   disclaimer paragraph where a state or a link would do.
5. **The empty state is a place to act.** No lonely centered sentence. Every empty, error and
   unselected state offers the next step.
6. **Precision you can feel.** Everything snaps to the 4px grid and the control scale. Numbers are
   tabular. Edges line up across the page and across pages.
7. **Phones are first-class, not shrunk desktops.** Sheets, 44px targets, one action row within
   thumb reach, list and detail as separate routes.

---

## 2. Tokens

All tokens are CSS custom properties in `styles.css`. Color values keep their current names so the
four generated color schemes (`github`, `one-dark`, `dracula`, `monokai`) keep working unchanged.

**One name per color.** Components read the palette names in §2.1 directly (`--bg*`, `--border*`,
`--control-outline`, `--text*`, the hues). A new token exists only when it names something the
palette does not have: a derived mix (`--surface-selected`), a per-theme choice (`--field-bg`,
`--danger-bg`), or a role whose palette name is misleading (`--primary-bg`, because the palette's
`--primary-from` is a gradient stop). Pure renames (`--line` for `--border`, `--surface-hover` for
`--bg-elev-2`) are not part of the system: a second name for the same color is how the
`--text-muted` drift started, and the stylesheet already has 15,000 lines written against the palette
names. Derived tokens are declared once in the shared `:root` block with `var()`, so they are
correct in every scheme and theme without regeneration.

### 2.1 Color: Palette (Wollipog Scheme)

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--bg` | `#0b1118` | `#f6f8fa` | App ground: page, bars, list panes. Also the sunken well: segmented track, code wells, dropzones. |
| `--bg-elev` | `#121a24` | `#ffffff` | Raised: rail, Surfaces, menus, dialogs, cards, the selected segment knob. |
| `--bg-elev-2` | `#182430` | `#eef2f6` | Hover fill; secondary button fill; keycaps. |
| `--bg-elev-3` | `#21313f` | `#e3e9ef` | Pressed fill; toggle "on" fill; tooltip. |
| `--border` | `#263544` | `#d0d7de` | Hairlines and container edges (decorative only). |
| `--border-strong` | `#374b5c` | `#afb8c1` | Floating-layer edges; secondary button edge. |
| `--control-outline` | `#6b8299` | `#727c86` | **Every input, select, checkbox and switch boundary, the selected segment knob, and the edge of a toggle that is on** (3:1, WCAG 1.4.11). |
| `--text` | `#e6edf3` | `#17212b` | Primary text. |
| `--text-dim` | `#9aa9b8` | `#4f5d6a` | Secondary text: descriptions, helper, labels in tables. |
| `--text-faint` | `#8a98a4` | `#606973` | Tertiary: counts, timestamps, placeholders. Never for sentences. |
| `--text-disabled` | `#687380` | `#838d97` | The disabled ink of a control with no fill of its own (§3.1). At least 3:1 on `--bg` and `--bg-elev` and 1.8:1 below `--text-dim` in every scheme. Never for text a person has to read. |
| `--text-dim-on-tint` | `#aebac6` | `#495663` | Existing token: dim text on a 12–16% wash (neutral status badge text). |
| `--accent` | `#45d6cc` | `#055d56` | Selection indicator, active nav, tab underline, checked controls, links. |
| `--primary-from` | `#2fbcb2` | `#06736a` | Primary button fill (flat). |
| `--primary-hover-from` | `#3fc8be` | `#055d56` | Primary hover. |
| `--primary-active-from` | `#29aaa2` | `#04443f` | Primary pressed. |
| `--on-accent` | `#06231f` | `#ffffff` | Text on primary and accent fills (7.06:1 / 5.72:1). |
| `--green` / `--amber` / `--red` / `--blue` | `#3fb950` / `#e3b341` / `#f85149` / `#58a6ff` | `#1a7f37` / `#9a6700` / `#cf222e` / `#0969da` | Status hues. Fills and dots only; text uses `*-on-tint`. |
| `--accent-2` | `#ef8f3f` | `#bc4c00` | Brand orange. **No UI role** (logo, usage chart series only). |
| `--purple`, `--agent-claude` | | | Retired from UI chrome. Agent identity uses the agent's brand icon, not a tinted tag. |

### 2.2 Color: Derived and Per-Theme Tokens

```css
:root {
  /* Derived (shared block, correct in every scheme) */
  --surface-selected: color-mix(in srgb, var(--accent) 12%, var(--bg-elev));  /* selected row, active rail item */
  --count-badge-ring: var(--bg-elev);  /* an on-icon count badge's ring; its surface overrides it (§11.4) */

  /* Focus: neutral, never teal. A generated scheme may emit its own (§21 item 8). */
  --focus: var(--text);
  --focus-width: 2px;
  --focus-offset: 2px;

  /* Primary (flat). Only these read the palette's gradient-stop names. */
  --primary-bg: var(--primary-from);
  --primary-bg-hover: var(--primary-hover-from);
  --primary-bg-active: var(--primary-active-from);
  --primary-fg: var(--on-accent);
  --danger-fg: #ffffff;

  --tint: 14%;                 /* status badge wash strength; notices use a fixed 7% */
}
:root[data-theme="dark"] {
  --field-bg: var(--bg);       /* inputs sit sunken on the ground */
  --danger-bg: #c93c37;        /* white text 5.02:1 */
  --danger-bg-hover: #b62324;  /* 6.45:1 */
  --count-warning-fg: #1b1300; /* text on an --amber fill, 9.47:1 */
}
:root[data-theme="light"] {
  --field-bg: var(--bg-elev);  /* inputs are white */
  --danger-bg: #cf222e;        /* 5.36:1 */
  --danger-bg-hover: #a40e26;  /* 7.87:1 */
  --count-warning-fg: #ffffff; /* on #9a6700, 4.87:1 */
}
```

`--danger-bg*` and `--count-warning-fg` are Wollipog-scheme values. The four generated schemes inherit
them unless the scheme generator emits its own; if it does, it must hold white on `--danger-bg` at
4.5:1 or better.

**Tones** are not tokens. A tone class sets two local custom properties from the palette, and every
tinted component reads those:

| Class | `--tone` (fills, dots, icons) | `--tone-text` (text on a wash) |
| --- | --- | --- |
| `.t-neutral` | `--text-faint` | `--text-dim-on-tint` |
| `.t-info` | `--blue` | `--blue-on-tint` |
| `.t-success` | `--green` | `--green-on-tint` |
| `.t-warning` | `--amber` | `--amber-on-tint` |
| `.t-danger` | `--red` | `--red-on-tint` |

Tinted surfaces are always `color-mix(in srgb, var(--tone) var(--tint), transparent)` with text in
`--tone-text`; the existing `--*-on-tint` tokens are already calibrated for 12–16% washes in every
scheme.

`--line`, `--line-strong`, `--control-border`, `--surface-hover`, `--surface-pressed`,
`--surface-sunken` and `--row-h-sm` are not part of the system and must not be used.

**Where teal may appear** (exhaustive): primary button fill; active rail item (icon plus 3px bar);
active tab underline; selected list row (leading 2px bar plus `--surface-selected`); checked
checkbox, radio and switch; text links; the composer's send button (it is the primary action);
progress bars for normal forward progress. Anything else that is teal today becomes neutral or takes
its status tone.

### 2.3 Type

One family: the existing system stack (`--font-ui`). No web fonts. Monospace (`--font-mono`) is only
for code, paths, commands, hashes and keycaps: never for labels or data.

Sizes are given in px at the default 16px root. The stylesheet declares the `--text-*` tokens in rem,
so the browser's font-size preference still scales the UI.

| Token (size) | px | Line height | Weights | Role |
| --- | --- | --- | --- | --- |
| `--text-xs` | 11 | 16 | 500 | Badges, counts, keycaps, rail labels. |
| `--text-sm` | 12 | 16 | 400, 500 | Helper text, meta lines, table headers, field labels. |
| `--text-base` | 13 | 20 | 400, 500 | **UI default.** Controls, rows, dialog body, settings. |
| `--text-md` | 14 | 22 | 400 | Reading text: transcript prose, markdown, empty-state sentences. |
| `--text-lg` | 16 | 24 | 600 | Titles: dialog title, detail title, empty-state title. |
| `--text-xl` | 20 | 28 | 600 | Page title (one per page). |
| `--text-2xl` | 24 | 32 | 600 | Headline figures only (Usage total). |

Named type roles (use these, not raw sizes):

```css
--type-page-title: 600 var(--text-xl)/28px var(--font-ui);
--type-title:      600 var(--text-lg)/24px var(--font-ui);
--type-section:    600 var(--text-md)/20px var(--font-ui);   /* page section, settings group, fieldset legend */
--type-body:       400 var(--text-base)/20px var(--font-ui);
--type-body-strong:500 var(--text-base)/20px var(--font-ui); /* row titles, buttons, labels */
--type-reading:    400 var(--text-md)/22px var(--font-ui);
--type-small:      400 var(--text-sm)/16px var(--font-ui);
--type-label:      500 var(--text-sm)/16px var(--font-ui);   /* field labels, table headers, list-group labels */
--type-micro:      500 var(--text-xs)/16px var(--font-ui);
--type-figure:     600 var(--text-2xl)/32px var(--font-ui);   /* headline figures only */
```

Rules

- `body { font: var(--type-body) }`. Body becomes 13px (today 14px contradicts `--text-base`).
- `button, input, select, textarea { font: inherit; }` and `font-weight: 400` on inputs. This fixes
  Arial inputs, the 13.333px `<button>` rows, and bold values in the automation form.
- Weights are 400, 500 and 600 only. 700 is retired.
- **Never `text-transform`.** No uppercase, no capitalize. Casing lives in the copy (§17).
- **No letter-spacing** on UI text.
- `font-variant-numeric: tabular-nums` on counts, times, costs, table cells and badges (`.num`).
  The `font` shorthand resets it, so declare it **after** any `font: var(--type-*)` in the same rule.
- Retired sizes: 9, 10, 10.5, 11.5, 12.5, 13.333, 13.5, 15, 16.38, 17px. `--text-2xs` and
  `--text-status` are removed; `--text-lg` changes from 17 to 16px.
- Hierarchy check: on any screen the page title is the largest text, and a label or meta line is
  never larger than the content it annotates.
- Reading measure: prose blocks cap at `68ch`.

### 2.4 Spacing (4px Grid)

| Token | px | Typical use |
| --- | --- | --- |
| `--space-0-5` | 2 | Segmented track inset; badge dot gap. Only exception to the 4 grid. |
| `--space-1` | 4 | Icon-to-text in badges; menu padding. |
| `--space-2` | 8 | Gap inside controls and action rows; label to field. |
| `--space-3` | 12 | Row padding x; gap between meta items; field to helper. |
| `--space-4` | 16 | Field to field; Surface padding; dialog footer padding y. |
| `--space-5` | 20 | Dialog body padding. |
| `--space-6` | 24 | Page gutter (desktop); section internal gap. |
| `--space-8` | 32 | Between page sections. |
| `--space-10` | 40 | Empty-state top padding. |
| `--space-12` | 48 | Large empty-state top padding. |
| `--space-16` | 64 | Rare: page bottom padding. |

Rules: no literal px for padding, margin or gap in component CSS (values computed from tokens with
`calc()` are fine; 1–2px optical offsets for icon baselines and 1px borders are the only literals); `p`, `h1`–`h6`, `ul`, `dl`, `figure`
inside any component have `margin: 0` (flow-spacing reset: `:where(.form, .section, .surface,
.modal-body, .notice, .empty) > * { margin: 0 }`); vertical rhythm comes from `gap`.

Density: keep the existing `data-density="comfortable"` mechanism but restate it in terms of row
tokens only (`--row-h*`, §2.8): comfortable adds 8px to each row height. `--space-*` never changes
with density. The ~25 per-family `--*-row-pad-*` tokens collapse into `--row-pad-x` (12px) plus the
row heights.

### 2.5 Radius by Hierarchy

| Token | px | Tier | Applies to |
| --- | --- | --- | --- |
| `--radius-xs` | 4 | Inline | Keycaps, inline code, meta chips, checkbox, hunk markers. |
| `--radius-sm` | 6 | Control | Buttons, inputs, selects, segmented track, menu rows, hovered list rows. |
| `--radius-md` | 8 | Container | Surfaces, cards, menus, popovers, notices, toasts, code blocks. |
| `--radius-lg` | 12 | Layer | Dialogs, sheets (top corners), floating panels, the composer card. |
| `--radius-pill` | 999 | Status | Status badges, count badges, switch track, dots, avatars. **Never actions.** |

Nesting rule: a child's radius is one tier below its container's (a button inside a notice is 6
inside 8; a menu row is 6 inside an 8 menu). A docked panel (right panel, list pane) has **no**
radius: it is flush with the frame.

Migration: `--radius-sm` changes 8→6 and `--radius-md` 10→8. `--radius` (12) is renamed
`--radius-lg`. Pill-shaped action buttons (`.btn-rediscover`, `.connection-details-trigger`)
become rectangular `.btn`.

### 2.6 Elevation

Flat by default: in-page structure uses lines, not shadows.

| Token | Dark | Use |
| --- | --- | --- |
| `--elev-0` | none | Everything in the page flow. |
| `--elev-1` | `0 1px 2px rgb(0 0 0 / .18)` | The selected segment chip; a sticky header once content scrolls under it. |
| `--elev-2` | `0 4px 12px -2px rgb(0 0 0 / .28)` | Menus, popovers, toasts, the Pinned Summary when floating. |
| `--elev-3` | `0 12px 32px -6px rgb(0 0 0 / .42)` | Dialogs and sheets. |

Light values are the existing light ramp. `--shadow` is retired. Floating layers pair their
elevation with `1px solid var(--border-strong)` in both themes. The modal backdrop keeps
`--modal-backdrop` and drops `backdrop-filter: blur` (stacked dialogs produced a double blur).

### 2.7 Layout Tokens

| Token | Value | Notes |
| --- | --- | --- |
| `--rail-w` | 64px | The desktop rail (§4.1). |
| `--rail-w-labelled` | 208px | The labelled desktop rail, when the user turns it on (§4.1). |
| `--instance-tile` | 32px | The desktop app's instance tile at the top of the rail (§4.1). |
| `--title-bar-h` | 40px | The macOS desktop app's strip at the top of the rail, which the traffic lights sit in (§4.1). |
| `--bar-h` | 48px | Every bar: desktop session bar, detail bar, phone app bar, compact page header. §4.4. |
| `--page-gutter` | 24px (16px phone) | Left and right padding of the page container. |
| `--page-max` | 960px | List pages: Automations, Connections, Multi-Agent Runs, Pods. Left-aligned. |
| `--page-max-wide` | 1200px | Tables, charts and card grids: Usage and Cost, Archived Sessions. Left-aligned. |
| `--page-max-form` | 760px | Settings content, single-form pages. |
| `--measure` | 68ch | Prose. |
| `--list-pane-w` | 320px (280–440 resizable) | Master list in side-by-side master-detail. |
| `--sessions-list-h` | 45% of the split area, whole rows | Stacked list height (§6.3): at least 3 rows; the preview keeps 240px. Sessions only. |
| `--sessions-list-w` | 400px (280–440 resizable) | Preview Right's list column (§6.3). Sessions only. |
| `--panel-w` | 400px (320–640) | Right side panel, docked. |
| `--chat-max` | 860px | Unchanged. |
| `--bottom-bar-h` | 56px + safe area | Phone tab bar, labeled. |

### 2.8 Control and Row Heights

| Token | Desktop (fine pointer) | Coarse pointer | Use |
| --- | --- | --- | --- |
| `--control-h-sm` | 28px | 36px visual, 44px hit area | Dense toolbars, table row actions, inline actions, badges-as-buttons. |
| `--control-h` | 32px | 44px | **Default.** Buttons, inputs, selects, segmented, icon buttons, search. |
| `--control-h-lg` | 40px | 48px | Empty-state primary, onboarding, phone sheet footers. |
| `--row-h` | 40px | 48px | Single-line list rows, table rows, settings nav rows. |
| `--row-h-2` | 56px | 64px | Two-line list rows (title plus meta). |
| `--row-h-dense` | 32px | 44px | Dense rows in trees and file lists (§5.2); minimum hit area for Checkbox rows (§8.4). |
| `--icon-sm` / `--icon` / `--icon-lg` | 14 / 16 / 20px | same | Icon sizes; 24px only for empty-state tiles and the phone tab bar. |

Menu rows use `--control-h` (a menu row is a control; there is no `--row-h-sm`, which would have had
the same value in both modes). Tabs and rail items use `--control-h-lg` (40, 48 on touch).

Implementation:

```css
.btn, .icon-btn, .input, .select-trigger, .seg { height: var(--control-h); }
@media (pointer: coarse) {
  :root { --control-h: 44px; --control-h-lg: 48px; --control-h-sm: 36px;
          --row-h: 48px; --row-h-2: 64px; --row-h-dense: 44px; }
  :is(.btn.sm, .icon-btn.sm, button.chip, .composer-btn) { position: relative; }
  :is(.btn.sm, .icon-btn.sm, button.chip, .composer-btn)::after { content: ""; position: absolute; inset: -4px; }  /* 44px hit */
  .seg.sm { height: var(--control-h); }        /* adjacent options cannot borrow hit area: 44px real */
  .seg-option { position: relative; }
  .seg-option::after { content: ""; position: absolute; inset: -3px 0; }   /* 38px option + 2px inset + 1px edge = 44 */
  .switch { width: 40px; height: 24px; }       /* thumb 18px (::after) */
  .switch::before { content: ""; position: absolute; inset: -10px -2px; }  /* 44×44 hit; the row label is also a target */
  .link { position: relative; }
  .link::after { content: ""; position: absolute; inset: calc(50% - 22px) -4px; }   /* 44px tall band */
  input, textarea, select, .select-trigger { font-size: 16px; }   /* prevents iOS zoom, applied uniformly */
}
```

In the stylesheet the iOS zoom rule keeps its `:root`-prefixed selectors and stays the last rule in
the file: as bare element selectors it loses to class-scoped input rules, and Safari then zooms on
focus.

The borrowed hit area (`inset: -4px`) only works when neighbors are at least 8px away; inside a
`.seg`, a tab strip or a tight icon cluster, the visual size itself must be 44px.

A control that borrows more than 4px keeps the borrowed area inside its own row, so a neighbor never
needs extra clearance from it. The attachment tray's 20px Remove (#2561) takes the top-right 44px of
its 56px thumbnail rather than reaching past the tile, and a 36px reference chip keeps 4px above and
below itself for its Remove's centered 44px.

**One hit-area block.** Segmented options, switches and inline text links get their 44px
coarse-pointer hit area from this block, once, in the shared stylesheet. A segmented option borrows
the track's 2px inset and 1px edge; the switch uses `::before` because its thumb is `::after`; a link
gets a 44px band centered on its line. Components never add their own copies of these rules. A link
whose line sits closer than 12px to another target (dense prose) keeps its visual size and relies on
the surrounding row being the target.

Every interactive element uses one of these heights. `min-height` never comes from padding. Icon
buttons are square (`width: var(--control-h)`). Per-selector `min-height: 44px` patches on controls
are replaced by this one block. Composer bar controls (`ComposerButton`, #2174) are `--composer-ctl`
tall: `--control-h` (32px) on a fine pointer and the coarse `sm` recipe on touch (36px visual, 44px
hit, 8px apart), on every width including the phone capsule.

### 2.9 Motion

Durations are the existing tokens (`--dur-instant` 80, `--dur-fast` 130, `--dur-base` 180,
`--dur-slow` 260; `--ease-out`). Only user-caused changes animate:

| Change | Motion |
| --- | --- |
| Hover, press, focus, selection | Color only, `--dur-fast`. |
| Menu or popover open | Opacity 0→1 and 4px translate from the anchor, `--dur-fast`. Close is instant. |
| Dialog open | Opacity plus scale .98→1, `--dur-base`. |
| Sheet open (phone) | Translate from the bottom, `--dur-slow`. |
| Disclosure expand | Height, `--dur-base`, chevron rotates 90°. |
| Toast in | Opacity plus 8px translate, `--dur-base`. |
| Running and Listening dots | The only ambient animations: a 1.4s opacity pulse on the Running status dot and on the composer's Listening dot while dictation runs (#2193). |

No entrance animations on page load, no hover lift on cards, no `--ease-spring` in UI chrome.
`prefers-reduced-motion: reduce` removes every transform and the pulse (state stays visible through
the label). Its global guard collapses every declared transition and animation to 1ms, so their end
events still fire, and starts no transition on an element that declares none (#2574).

`--delay-tooltip` (500) is the one wait in the scale: how long a pointer rests before a tooltip shows
(§9.3). Only the reveal waits; leaving hides at once. It is not motion, so reduced motion keeps it.
The rail's JS tooltip waits the same 500ms, and a test holds the two equal.

### 2.10 Breakpoints

| Name | Range | What changes |
| --- | --- | --- |
| Phone | ≤ 760px | Bottom tab bar, app bar, sheets, list/detail as routes, tables become rows. |
| Compact | 761–1099px | Rail stays; page header keeps one primary plus overflow; list pane 280px; the session bar collapses its status to a dot plus `+N` (§15.2). |
| Desktop | 1100–1439px | Full layout. |
| Wide | ≥ 1440px | List pane may widen to 360px; nothing else. |

Side columns (right panel, list pane, dialogs) respond to **their own width** with
`container-type: inline-size` and `@container` rules, never to the viewport. The 600, 640, 680 and
700px breakpoints are removed.

One definition of each tier, shared by components and the stylesheet (#1969):

- **JS.** `useIsMobile()` (≤ 760px) and `useIsCompact()` (`(min-width: 761px) and (max-width:
  1099px)`) in `useIsMobile.ts`, built from `MOBILE_BREAKPOINT_PX`, `COMPACT_BREAKPOINT_PX` (1100)
  and `WIDE_BREAKPOINT_PX` (1440).
- **CSS.** Media queries cannot read custom properties, so `--bp-phone` (760px), `--bp-compact`
  (1100px) and `--bp-wide` (1440px) are documentation tokens that `tokens.test.ts` holds equal to
  the JS constants; compact-tier rules are written `@media (max-width: 1099px)`. `--bp-tablet` and
  `--bp-desktop` are retired. The Sessions card's 900px density threshold (#901) is not a tier and
  has no token; it stays until the Sessions row redesign replaces it.
- **The main column is the `app` container.** From 761px up, `.main` is `container: app /
  inline-size`. A rule that depends on the room the column has after the rail and any docked panel
  queries it with `@container app (max-width: 1099px)`, not the viewport; the Projects list pane is
  the first such rule. A rule whose edge is its own content's fit rather than the tier uses the same
  container with that edge: the Archived Sessions fold (§14) ends at a 1220px column. A phone has
  no `app` container. There the column is the viewport's width, and the phone's full-screen right
  panel and editor note are placed in viewport coordinates.
- **Nothing fixed inside the column may assume the viewport.** At the build floor (Chrome 111–128,
  and Safari before the CSSWG dropped layout containment from `container-type`), a size container
  is also the containing block of every `position: fixed` descendant. Each fixed surface in the
  column therefore does one of two things. It is portalled to `<body>` (menus and popovers, §9;
  dialogs, §7; the command palette). Or it stays in place and subtracts the offset that
  `fixedContainingBlockOffset()` (`fixed-containing-block.ts`) measures for its real containing
  block. Surfaces that stay in place are the Select and combobox lists (which take their field's
  font), the Snooze suggestions, the composer bar's context and cost popovers (which take the bar's type) and the
  F6 zone line (a pseudo-element). The measurement inserts a probe and forces a layout, so it runs
  only when the surface opens or its anchor moves, never on a scroll or resize that moved nothing.
  A surface that stays in place remains inside the column's stacking context at the floor, which
  is harmless because nothing outside the column overlaps an anchored surface. A new fixed surface
  does one or the other. `app-container.spec.ts` forces layout containment on `.main` to hold every
  one of them to its trigger.

### 2.11 Contrast (Wollipog Scheme)

Computed with the WCAG 2 formula from the token values, with `color-mix()` resolved in sRGB and washes
composited over the ground they sit on: 102 pairs per theme, all passing. Text needs 4.5:1; non-text
state indicators need 3:1.

| Pair | Dark | Light |
| --- | --- | --- |
| `--text` on `--bg` / `--bg-elev` / `--bg-elev-3` | 16.05 / 14.82 / 11.28 | 15.30 / 16.29 / 13.32 |
| `--text-dim` on `--bg` / `--bg-elev-3` / `--surface-selected` | 7.89 / 5.55 / 5.69 | 6.35 / 5.53 / 5.60 |
| `--text-faint` on `--bg` / `--bg-elev-3` (worst) / `--surface-selected` | 6.42 / **4.51** / 4.63 | 5.24 / **4.56** / 4.62 |
| `--text-disabled` glyph on `--bg` / `--bg-elev` (3:1), and below `--text-dim` (1.8:1) | 3.93 / 3.63, 2.01 | 3.17 / 3.38, 2.00 |
| `--accent` link on `--bg` / `--bg-elev` | 10.60 / 9.79 | 7.29 / 7.76 |
| Primary label on rest / hover / pressed | 7.06 / 8.06 / 5.81 | 5.72 / 7.76 / 11.03 |
| White on `--danger-bg` / hover | 5.02 / 6.45 | 5.36 / 7.87 |
| `--danger-text` on `--bg-elev` / `--bg-elev-2` | 10.26 / 9.22 | 7.87 / 6.99 |
| Count badge text on `--amber` | 9.47 | 4.87 |
| Status text on its 14% wash over `--surface-selected` (worst ground): info / success / warning / danger / neutral | 5.37 / 5.34 / 6.20 / **4.73** / 5.62 | 5.18 / 5.10 / 4.99 / 5.40 / 5.26 |
| Notice body `--text-dim` on its 7% wash (worst tone) | 6.44 | 6.07 |
| `--control-outline` vs `--bg` / `--bg-elev` / `--bg-elev-2` (3:1) | 4.77 / 4.40 / 3.96 | 3.99 / 4.25 / 3.78 |
| Selected segment knob edge vs track (3:1) | 4.77 | 3.99 |
| Selected row bar / active rail icon (`--accent`) vs `--surface-selected` (3:1) | 7.65 | 6.43 |
| Status dot vs its wash (worst: danger dark, warning light) (3:1) | 4.49 | 4.06 |
| Focus ring (`--text`) vs `--bg` | 16.05 | 15.30 |

Two recipes follow from these numbers. A selected segment shown only as a `--bg-elev-3` fill on a
`--bg` track measures **1.42:1 dark and 1.15:1 light**, near-invisible in light, so the selected option
carries a `--control-outline` edge (§10.2). Neutral status text uses the existing `--text-dim-on-tint`
(5.26 worst), not `--text-dim` (4.62 worst). The secondary button edge (`--border-strong`,
1.94:1 dark, 2.01:1 light) stays decorative on purpose: the label identifies the button. The margins at
the floor (`--text-faint` on `--bg-elev-3`, danger badge text on a selected row) mean `--text-faint`
must never sit on a pressed fill with a wash on top, and status badges must not sit on anything darker
than `--surface-selected`.

---


## 3. Buttons and Action Placement

### 3.1 Variants

| Variant | Class | Look | When to use |
| --- | --- | --- | --- |
| Primary | `.btn.primary` | Flat `--primary-bg`, `--primary-fg` text, no border. | The one action the region exists for: New Skill, Create Session, Save, Send. **At most one per region** (page header, dialog footer, card, sheet). |
| Secondary | `.btn` | `--bg-elev-2` fill, 1px `--border-strong` edge, `--text`. | Other real actions next to a primary, or the main action of a region that has no primary. |
| Ghost | `.btn.ghost` | Transparent, `--text-dim`, hover `--bg-elev-2` + `--text`. | Low-emphasis actions in dense places: Cancel in toolbars, Clear, Show More, toolbar toggles. |
| Danger | `.btn.danger` | Solid `--danger-bg`, white text. | **Only** the confirm button of a destructive confirmation dialog. Nowhere else. |
| Danger quiet | `.btn.ghost.danger` | Transparent, `--danger-text`. | A destructive action that must stay visible outside a menu (the tertiary slot of a dialog footer, §7.3). |
| Icon | `.icon-btn` | Square, transparent, `--text-dim` icon. | Tool actions with a universally understood glyph (close, more, search, copy, panel toggles). Always has `aria-label` and a tooltip that match. |
| Link | `.link` | `--accent` text, underline on hover. | Navigation inside prose and meta. Never styled as a button; buttons never underline (`a.btn { text-decoration: none }`). |

Sizes: `.btn.sm` (28), default (32), `.btn.lg` (40). Horizontal padding 8 / 12 / 16px; icon 14 /
16 / 16px; gap 4 / 8 / 8px; text `--type-body-strong` (sm uses 12px). Icon
buttons: 28 / 32 / 40px square.

States

| State | Treatment |
| --- | --- |
| Hover | Fill steps one surface up (ghost: → `--bg-elev-2`; secondary: `--bg-elev-2` → `--bg-elev-3`). Wrapped in `@media (hover: hover)` so taps do not stick. |
| Pressed | `--bg-elev-3` (primary: `--primary-bg-active`; danger: `--danger-bg-hover`). The secondary button's pressed fill equals its hover fill; press feedback there is the pointer, not a third gray. |
| Selected / on (toggle buttons) | `--bg-elev-3` fill **plus a 1px `--control-outline` edge** (icon buttons: an inset edge), `aria-pressed="true"`, and an icon or label change. The edge is what separates "on" from "hovered": with one fill for both, a toggle that is on looks hovered. |
| Focus | 2px `--focus` ring, 2px offset (§16.1). |
| Disabled | Text `--text-faint`, fill unchanged, no hover, `cursor: not-allowed`. No opacity. A control with no fill of its own (ghost, icon button, a composer bar ghost control) rests in `--text-dim`, which `--text-faint` is only about 1.2:1 from, so its label and glyph take `--text-disabled` instead: at least 1.8:1 below rest and 3:1 on `--bg` and `--bg-elev` in every scheme. The scheme generator derives the tier, and raises a scheme's `--text-dim` rather than adding a per-component exception if it ever stops fitting. Filled controls (secondary, primary, danger) keep `--text-faint` on their fill; a ghost toggle that is on keeps its on fill and takes `--text-disabled`. In forced colors, text and edge are `GrayText`, for `disabled` and `aria-disabled="true"` alike. A disabled control that the user would reasonably expect to work shows its reason as visible text next to it (§8.6), never only in `title`. |
| Busy | Label stays; a 14px spinner replaces the leading icon (or is prepended); the button keeps its width (`min-width` locked on press). In forced colors it keeps the enabled button ink, not `GrayText`. |

Busy is one component, `BusyButton` (`apps/web/src/components/ui/BusyButton.tsx`). It locks the
button to the width it had just before it became busy; a prepended spinner takes its room from the
inline padding, so the button neither grows nor moves its neighbours. It sets `aria-busy="true"` and
`aria-disabled="true"` (not `disabled`, which would drop the focus the person pressed it with) and
refuses further presses, keeps its variant's fill, and announces a sentence-case `progress` line
("Installing the update…") through a polite live region. Toast actions (`ToastOptions.action.progress`)
and confirmations that wait on their action (`ConfirmationOptions.onConfirm`) use it. A button never
swaps its label for a progress word ("Installing…"): `apps/web/src/busy-label-ratchet.test.ts`
records the remaining `? "<Word>ing…"` label swaps by file and fails when one is added, and each area
removes its own as it rebuilds the screen.

Rules

- Button text never wraps: `white-space: nowrap; flex: none`. If a row cannot fit its buttons, the
  **row** overflows into a ⋯ menu (§3.3); the button never shrinks. One exception: the phone sheet
  footer's equal pair (§7.5), whose halves are narrower than a long confirm label.
- Buttons never stretch. In column-flex and grid containers every button sits in an `.actions` row
  (`display: flex; gap: var(--space-2); align-items: center`) or has `justify-self: start`. This
  removes full-width "bar" buttons.
  One exception: in a request notice inside a narrow card (under 360px wide, such as a
  board card), Approve and Deny may stretch as an **equal pair** that fills the row, matching the
  phone sheet footer rule (§7.5). Only that pair, never a single button. The session notice slot's
  resolving action below 760px is the other exception (§13.2).
- Labels are verb plus object in Title Case: "New Skill", "Import from Git…", "Delete Skill". The
  ellipsis means "opens a dialog or menu that asks for more input before anything happens" (§17).
- A leading `+` icon marks create actions; no other decorative icons in text buttons unless the
  icon disambiguates (Refresh, Copy, Open in Editor).

### 3.2 Button Groups

- Order in any horizontal action group: **[destructive tertiary] … spacer … [ghost] [secondary] [⋯]
  [primary]**. Primary is last (rightmost on desktop). The overflow ⋯ sits immediately before the
  primary because it holds more secondaries.
- Gap 8px between buttons. Groups never mix heights: every control in one row uses the same
  control-height token.
- Segmented and split buttons count as one control.
- **Split button** (`.split`): a primary action and the menu of its alternatives (Open in VS Code
  and Choose Where to Open). Two `.btn`s in a `.split` join on one shared edge: the first loses its
  trailing radius, the second its leading radius, a 1px overlap, and 8px side padding for the
  chevron. The recipe sits at a single class's weight (`:where()`), so a component can size its
  segments. The session header's Open control is the first consumer (`EditorSelect`).
- Pills are never actions. A clickable status (for example a descendant-request count) is a
  `.btn.sm.ghost` containing a status badge, so it looks and hits like a button.

### 3.3 Where Actions Live

| Region | Holds | Visible limit before ⋯ |
| --- | --- | --- |
| Page header (§4.2) | Create and import for the destination; destination-level settings. | Desktop: 1 primary + 2 secondary. Compact: 1 primary + 1 secondary. Phone: primary as a 44px `+` icon button (label in `aria-label`), everything else in ⋯. |
| Detail bar (§4.3) | Actions on the open entity. | Desktop: 1 primary + 1 secondary + ⋯. Destructive actions live **only** in ⋯, last, after a separator, in `--danger-text`. |
| List row | Open (row click) plus one inline action and ⋯. | Inline actions show on hover or focus on fine pointers, always on coarse. |
| Dialog footer (§7.3) | Cancel and the dialog's one primary, optional destructive tertiary on the left. | 3 on desktop; 2 on phone. |
| Section (in page) | At most one action, in the section title row, right-aligned (`.section-head .actions`). | 1 + ⋯. |
| Notice | Its resolving action(s), bottom-left of the copy on desktop, full width on phone. | 2. |
| Toast | One action plus close. | 1. |

---

## 4. Page Anatomy

### 4.1 Shell

```
┌────┬──────────────────────────────────────────────────────────────────────┐
│    │ [offline / pairing banner: full width, 36px, only when present]      │
│ R  ├──────────────────────────────────────────────────────────────────────┤
│ a  │  Page header (in the page container, not a separate bar)             │
│ i  │  ──────────────────────────────────────────────────────────────────  │
│ l  │  Page content: sections, or a master-detail grid that fills height    │
│ 64 │                                                                      │
└────┴──────────────────────────────────────────────────────────────────────┘
```

- **Rail (desktop).** 64px, `--bg-elev`, hairline right edge. Square items at `--control-h-lg` (40px;
  48px on touch tablets), 20px outline icons,
  4px gap, 12px gap plus a hairline between groups: *Work* (Sessions, Automations, Projects),
  *Oversight* (Multi-Agent Runs, Pods, Connections, Agent Skills), *Records* (Archived Sessions,
  Usage and Cost). That is also the default rail order and digit order; a saved order is kept. Settings is pinned
  at the bottom. Active: `--accent` icon, 3px `--accent` bar on the left edge, `--surface-selected`
  fill. Hover: `--bg-elev-2`. Digit hints appear only in the tooltip ("Automations  2"), not as
  8px superscripts. One attention mark per item (§11.4). Archived uses an outline archive-box glyph.
  The instance switcher (Tauri) replaces the brand tile at the top as a 32px monogram tile with a
  status corner dot.
- **Labelled rail (desktop, opt-in).** Off by default. Turned on, the rail is 208px and each item
  shows its icon, still centred at x = 32px, then its name in `--type-body-strong` on one line with
  an ellipsis. Counts sit inline after the name, and the digit keycap appears at the trailing edge on
  hover (fine pointers) or keyboard focus. No tooltip is shown, and group hairlines span the rail.
  Three controls write the same per-instance preference and follow each other live: an icon button
  at the rail's foot ("Expand Navigation" / "Collapse Navigation"), the switch "Show Labels in Rail"
  in Settings › Appearance › Navigation, and the palette action "Show Navigation Labels" / "Hide
  Navigation Labels" (#1978). It never applies at 760px or below, and the Settings row is not shown
  there.
- **Instance tile (desktop app).** A 32px neutral tile (`--bg-elev-3`, `--radius-sm`) in a rail
  item's square, which has no fill or border at rest. Its monogram (12px/600) is the first letter of
  each of the profile label's first two words; there are no per-instance colors, because color
  means state. The corner dot is `instanceAvailabilityMeta`'s tone (§11.2), hollow when offline.
  While the shell shows the offline or sign-in banner, the tile agrees with it
  (`activeInstanceConnection`): hollow and neutral, "Reconnecting…", never Online. The active
  instance's card in Connections › Instances reads the same truth, which the shell provides once
  (`ActiveInstanceConnectionProvider`), for This Machine as for a remote, and offers Retry while the
  connection is lost; every card's dot is its badge's tone and hollow state (#2102). Accessible
  name "Switch Instance: <label>"; the tooltip gives the name and the status in sentence case. It
  opens the instance menu as a 300px flyout to the right of the rail, top-aligned with the tile
  (§9.1): `menuitemradio` rows with a 24px monogram, the name, and the origin ("On this machine"
  for the local profile) as a second line; a check on the current instance; a known status other
  than Online as text in its tone; a "Remote" label before remote profiles; then "Add Remote
  Instance…" and "Manage Instances". In the labelled rail the tile's row also shows the full name
  (ellipsized) and the status text, the monogram stays centred at x = 32px, and there is no
  tooltip. The browser build keeps the decorative brand. No phone bar
  carries a switcher: the desktop app's 940px minimum width never reaches the phone layout (#1970).
- **Window (desktop app).** On macOS the window has no separate title bar (`titleBarStyle: "Overlay"`,
  `hiddenTitle`). The traffic lights sit in the rail's top-left (`trafficLightPosition` x 8, y 18,
  so all three clear the rail's 1px hairline) inside a `--title-bar-h` strip of rail padding, above
  the instance tile. The strip, and any part of the page header, detail bar or Session bar that is
  not a control, drags the window (`data-tauri-drag-region`); buttons, links, inputs, tabs and other
  focusable controls in them stay clickable. Windows and Linux keep their native title bar, which
  follows the resolved theme (Tauri's `setTheme`; a System preference passes none, so the window
  follows the operating system, and on Linux, where tao reads none as light, the desktop portal's
  theme is then read back and named). The browser build is unchanged. #1979.
- **Window title.** Every route sets `document.title` to "<Page> – Wollipog", with the page title
  from `viewTitle` ("Agent Skills – Wollipog"; a Session, Multi-Agent Run or Pod by its own title),
  and the desktop app copies it to the native window for the taskbar and window switcher.
- **One name per destination**, used for the rail tooltip, `aria-label`, page title, phone app bar,
  More sheet, palette, shortcut reference and Settings › Appearance › Navigation: Sessions,
  Automations, Projects, Multi-Agent Runs, Pods, Connections, Agent Skills, Archived Sessions, Usage
  and Cost, Settings. Each `GLOBAL_VIEW_ITEMS` entry carries that one `name`, its page `description`
  (§4.2) and its `group`; back controls read "Back to <name>". "Inbox" is retired from all copy.
- **Search.** A rail item "Search" (Ctrl/Cmd+K) at the top of the Work group and a search icon in the
  phone app bar open the command palette; closing it returns focus to whichever opened it. The
  palette is one listbox of labelled sections (§9.1): Recent (the last five sessions opened on this
  device, per instance), Sessions, In Transcripts, Go To (every visible destination with its digit,
  then Settings and each Settings section, named by itself over "Settings") and Actions ("Switch to
  Board View" / "Switch to List View", "Show Navigation Labels" / "Hide Navigation Labels"). An empty
  query shows Recent, Go To and Actions. A session matched by title and by transcript is one row,
  with the snippet as its third line. Sessions show a status dot, transcript hits a file-text icon,
  destinations their own icon. Transcript search starts at three characters (a hint row says so),
  keeps earlier hits until new ones arrive and shows "Searching transcripts…" meanwhile; no results
  is §12.2's sentence with Clear Search and Search Archived Sessions. Desktop: 640px, 96px from the
  top, `--radius-lg`, `--elev-3`, a 48px search bar, the active row in `--surface-selected` with a
  2px accent bar, and a 36px key-hint footer on fine pointers. At 760px and below it fills the
  screen with Cancel and 48px rows.

### 4.2 Page Header (Destination Pages)

Replaces both the 54px `.topbar` and every in-page `h2` (`.view-heading`, `.skills-heading`,
`.automation-heading`, `.projects-intro`, the Usage `#usage-heading`).

```
 ← page gutter 24 →
┌──────────────────────────────────────────────────────────────────────────────┐
│  Agent Skills                                   [Manage Groups] [Import ▾] [+ New Skill] │
│  Write a skill once, then choose which machines and agents get it.           │
│  [Tabs, when the destination has sibling views]                              │
├──────────────────────────────────────────────────────────────────────────────┤  hairline
```

| Part | Spec |
| --- | --- |
| Container | Inside the page container, so its left edge is the content's left edge. Padding `20px 0 16px`, 4px between title and description. Background `--bg`. Bottom hairline `--border` only when tabs are absent or when content scrolls under it. |
| Title | `h1#page-title`, `--type-page-title` (20/28, 600). The only `h1`. Focusable for route-change focus but with no visible ring (§16.1). |
| Description | Optional, **one line**, `--type-body` in `--text-dim`, max 80 characters, truncated with ellipsis if the window is narrow. It says what the page is for in user terms. Hidden on phones. |
| Actions | `.page-actions`, top-aligned with the title's 28px line box (`align-self: start`, control height 32). Follow §3.2 order and §3.3 limits. Priority+ overflow via `@container`: secondary buttons move into ⋯ from the left as width shrinks; the primary never moves. |
| Tabs | Optional underline tabs (§10.1) as the header's last row, flush with the bottom hairline. |
| Sticky | Not sticky. In master-detail pages the columns scroll, so the header stays in view anyway. |
| Height | 64px title only, 88px with the description, 124px with description and tabs (20 + 28 + 4 + 20 + 12 + 40). This replaces a 54px bar plus 130–180px of in-page heading. |

Phones: the page header becomes the **app bar** (§15.1): 48px, title `--type-title` (16/600), a
search icon, the primary as a 44px `+` icon button, and ⋯.

A secondary may be a **menu button** (`PageHeader`'s `items`): its label and a 14px caret open the
shared menu, one item per choice with a one-line description (Agent Skills' Import). A secondary
may also use the ghost variant (`variant: "ghost"`) for destination-level configuration such as
Manage Groups…. A menu button takes one slot like any secondary. When it folds into ⋯, its items
appear there individually and in order, never as a nested menu (#1947).

### 4.3 Detail Bar (Entity Pages and the Session)

Every entity view (Session, Run, Pod, Project, a Skill or Automation on phone) uses the same bar,
extending the settled one-bar session chrome app-wide.

```
┌──────────────────────────────────────────────────────────────────────────────┐ 48px
│ ‹  Docs Overhaul Bake-Off With Four…  ● Running           [Secondary] [⋯] [Primary] │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Back: 32px icon button with `ChevronLeft`, `aria-label="Back to <Destination>"`.
- Title: `--type-title` 16/600, single line, truncates; takes all free space (`flex: 1; min-width: 0`).
- One status badge (§11), placed right after the title.
- Actions per §3.3. Destructive actions only in ⋯.
- Background `--bg`, bottom hairline. No gradient.
- The generic "Run" / "Pod" top bar title and the separate `.detail-head` with a `←` glyph are
  deleted. Project detail gets the same back control.
- Session specifics follow the settled session designs: the one-bar desktop session chrome with a
  docked Pinned Summary, and the phone session header.
- The session bar (`header.detail-bar.session-bar`, #2146) shares the classes, not `DetailBar`: it
  holds Back ("Back to Sessions"), one project menu button (`.btn.ghost`: the projects icon, the
  name, a 14px caret; `flex: none` up to 220px, "No Project" in `--text-faint`), a `/` separator,
  the title, the Session Status control, then Share, More Actions, a divider, the Open split button,
  a divider and the panel toggles. The project menu is headed by the name and holds Open Project and Move to
  Another Project… (only Move to a Project… without one); the name does not navigate on its own.
  The title is the only element that absorbs width, and shows `sessionDisplayTitle()`: the stored
  title's first non-empty line, whitespace collapsed, a trailing period dropped. Control planes
  without Projects show the same button with the folder icon for the workspace menu.
- The session bar's two menus (#2161) use the shared `Menu` with no section labels. Share holds
  Share Transcript…, Copy Session Link, a separator, Export as Markdown and Export as JSON, each
  with a 16px icon and a second line, then one note about redaction. More Actions groups, each
  after a separator: the folded project items (compact tier and phones), then Rename…, the
  reminder item (never on an archived session), Dismiss Reminder, Fork Conversation… and
  Switch Account…, then Reprocess Transcript and Sign Out of Agent…, then the archive item and
  Restart Session, and last the red Retry Stop, Stop Session… and Delete Session…. Fork lives
  only here, never as a bar button; it is left out where the session can never fork. Every
  disabled item says why on its second line, and results are toasts (§13.1), never a note in the
  bar.
- The Session Status control (`SessionStatusButton`, #2182) is the bar's one status: a `.btn.ghost`
  holding one status badge and, when other conditions need the person, a plain "+N". Its accessible
  name says both ("Session Status: Approval Required and 1 More"). `sessionStatusSummary()` in
  `status-meta.ts` chooses the badge, the first that applies: each attention kind in
  `sessionAttentionBreakdown()` order, then human-owned campaign requests, then descendant requests,
  then a background result that waits on the person (Result Blocked, Result Missing; #2275);
  Background Work Lost; Disconnected; Waiting on External Job while the session otherwise awaits its
  next prompt; the lifecycle, including Stop Pending and Stop Failed, and Archived for an archived
  session that has stopped with no Stop pending or failed (`sessionArchivedAtRest()`). "+N" counts
  only the other conditions that need the person, never passive states (Result Pending, Transcript
  Delayed and Notification Pending are passive), so it is the same at every width. The Sessions rows,
  the preview bar and the Board cards use the same function. The Sessions preview bar (#2210) shows
  its first badge and "+N" exactly; a row (`sessionRowStatus()`, #2209) shows the same badge with
  three exceptions of its own: no badge for Awaiting Prompt, Returned for a fired reminder, and a
  stalled session's badge in the danger tone, reading Stalled in place of a busy lifecycle (#2215).
- It opens the Session Status popover (§9.2, 340px; a bottom sheet on phones): the title, then one
  row per condition with its badge, one sentence and the action that resolves it where one exists
  (Review Request, Answer, Sign In…, Open for Background Work, Open Agents, Open Requests). Result
  Blocked offers Stop Job… (the Background Work panel's danger confirmation) when Stop Job is
  available and exactly one job of the blocked turn is still running, and Result Missing offers
  Acknowledge Missing Result; otherwise either opens Background Work. The step closes the popover and
  leaves focus on the Session Status control; reopened while its request runs, the row's button is
  busy, and a failure is an error toast (#2275). The lifecycle is listed only when nothing needs the
  person. Queue reasons are rows, not badges.

### 4.4 Bar Height: 48px

All bars share `--bar-h: 48px`: the desktop session bar, detail bars, and the phone app bar. The
settled session chrome uses 44px. The reason for +4px: a bar must hold 32px desktop controls with 8px
of air on the 4px grid, and on phones it must contain 44px touch targets. A 44px bar gives phone
targets zero margin and forces them down to 36px, which is too small in the phone session header. One height
everywhere also ends the 54 / 57 / 50 / 40px jumps between routes. The session's saving versus today
(about 100px) is essentially unchanged.

### 4.5 Page Container

```css
.page { padding: 0 var(--page-gutter) var(--space-16); max-width: calc(var(--page-max) + 2 * var(--page-gutter)); }
.page.wide { max-width: calc(var(--page-max-wide) + 2 * var(--page-gutter)); }  /* tables, charts, card grids */
.page.form { max-width: calc(var(--page-max-form) + 2 * var(--page-gutter)); }
.page.full { max-width: none; }                 /* master-detail, board */
```

- Left-aligned (`margin: 0`), never centered. Every destination title sits at `rail + 24px`.
- Exactly one scroll container per column. Inner route roots never reuse `.main-body` (Settings
  nested-scroll bug).
- Sections within a page: `--type-section` title row (title left, one action right), 12px to content,
  32px between sections. Sections are not boxed (§5.1).
- Why 960 for list pages: a row's trailing status and actions should stay within one eye movement
  of its title. The People and Devices tab, the calmest list page, runs at about 880px; at 1200px a machine row's Manage button sits 1,100px from the name.
  Wide content (tables with 5+ columns, the usage chart, card grids) opts into `.page.wide`.
- A component never uses negative margins to escape its parent's padding (`.subagents-panel {
  margin: -12px -14px }`). Hosts offer a flush modifier instead. Optical bleed inside one component
  (list rows bleeding into the gutter so their text aligns with the title) is allowed and commented.

### 4.6 Terminal Placement

Terminal tabs have one per-device preference, **Terminal Placement**, a row in Settings › Appearance ›
Display (This Device) with the segments **Bottom Dock** (the default) and **Right Panel**. An unset
or unreadable value means Bottom Dock.

- **Bottom Dock.** The shell dock sits under the composer on desktop (220px by default) with one 40px
  head: tabs with an accent underline, then Search, New, More Terminal Actions (⋯) and Hide as icon
  buttons. On phones it takes the composer's place while open.
- **Right Panel.** The same tabs and head become the right panel's **Terminal** tool and follow the
  panel frame (the 48px header with the tool switcher, a 40px tab strip, container queries on the
  panel's own width; on phones the full-screen sheet with one Back). The bottom dock is not shown.
- Each place's ⋯ menu offers the other: **Move to Right Panel** in the dock, **Move to Bottom Dock** in
  the panel tool. Both menus and the Settings row write the same preference and update each other
  live. Moving never restarts a running shell; its tab and scrollback move with it.
- The Terminal toggle and Ctrl+` open the terminal wherever it is placed.

### 4.7 Toolbar

A row of tools above the content they act on: search, filters, view switches and a result count.

- `.toolbar`: one row, `display: flex; align-items: center; gap: var(--space-2); min-width: 0`.
  Every control in it uses one control height (§3.2).
- The toolbar is only the row. Where it sits (the Archive filter card, the space above a machine
  list) is the region's decision, written as that region's rule on `.toolbar`. Regions do not
  define their own toolbar class. The Sessions tab row's tools, the Board's Machine and Agent
  filters included, sit in its tab bar's `.tabs-tools` (§10.1); the Board has no toolbar of its own.
- `.filter-btn` (`FilterButton`) is the phone "Filters" button that opens the filter sheet (§15.1):
  a `.btn` that says "Filters", with `aria-haspopup="dialog"`. While any filter is applied it is
  `.is-set`, which gives it the `--control-outline` edge of a chosen control (§3.1), and it shows
  the number applied. No screen uses it yet.
- Replaces `.agent-defaults-toolbar`, `.archive-toolbar`, `.board-toolbar`, `.connections-toolbar`
  with `.view-toolbar`, `.inbox-toolbar` and `.usage-toolbar-controls`.

### 4.8 Breadcrumbs

A path trail, such as the Files panel's folder path.

- `.crumbs` holds the trail: `--type-small`, wrapping onto a second line rather than clipping.
- Each ancestor is a `button.crumb` in `--accent` (it navigates, like a link, and underlines on
  hover). The current segment is `.crumb.is-current` in `--text`. A disabled crumb is `--text-dim`.
- Separators are `.crumb-sep` (`/`, `--text-faint`, `aria-hidden`).
- Replaces `.files-crumbs` and `.files-crumb`.

---

## 5. Lists, Rows and Cards

### 5.1 Container Tiers

| Tier | Class | Look | Use |
| --- | --- | --- | --- |
| Section | `.section` | No border, no fill. Title row + content. 32px between sections, optional hairline between. | Every page and detail section (Content, Deployment, Assignments). |
| Surface | `.surface` | `--bg-elev`, 1px `--border`, `--radius-md`, no padding by default; rows inside separated by hairlines. | A group of rows that belong together (a settings group, a list of machines, a code block). |
| Callout | `.notice` (§13) | Tone tint, no border or a 1px tone edge at 30%. | Attention only: warnings, errors, held updates. |

At most **one bordered level** inside a page region. No card inside a card inside a card; a Surface
may contain rows, never another Surface. Inside dialogs, Surfaces are allowed only for lists and code.

The Sessions Board (#2201) is the model case: its columns have no border and no fill, so the cards
are the only boxes. A column's header is its Title Case name after a 6px status dot (§11.1: Running
info, Needs Input warning, Queued, Review and Done neutral) with a plain count (§11.4), never
uppercased or tracked. An empty column folds to a 40px strip with its header on end and stays a
drop target; while a card is dragged, every strip opens to full width. A phone shows one column at a
time under column tabs instead (§15.1, #2216).

### 5.2 Rows

| Row type | Height | Anatomy |
| --- | --- | --- |
| Single-line | `--row-h` 40 | `[16 icon] Title ........ [meta] [badge] [action]` |
| Two-line | `--row-h-2` 56 | Line 1: title (`--type-body-strong`, 1 line, ellipsis) + trailing status badge or time. Line 2: meta or description (`--type-small`, `--text-dim`, **1 line, ellipsis**). |
| Dense (trees, file lists) | `--row-h-dense` 32 | `.row.dense`: `[16 icon] Name ........ [meta]`, one line, `--type-body`. **Fine pointers only**: on coarse pointers the token is 44px, so a touch tree is never denser than a menu. Only for trees and file lists, where 40px rows would show too few items (the Files tree shows 16 at 40px). Never for lists of entities, except a confirmation's read-only list of what it affects (§7.4). |
| Card row (sessions list) | `--row-h-2` on desktop and tablet; the three-line card on phone | **Desktop and tablet (#2209):** two lines, exactly `--row-h-2` whatever the row carries, with no gap between rows. Line 1, the status line: agent icon and "Agent · Project" (gives up width first), the branch only when there is one and the list is 600px or wider (`BranchIcon`, its base as "from <ref>", a pull request as `PullRequestIcon` and its state word), then trailing: the one status badge with a neutral "+N" (§11.1), the activity strip, the flags (pin, unread dot) and the time (tabular, `--text-faint`; a snoozed row shows its return time after an alarm clock instead). Line 2, the title line: the title (`--type-body-strong`, one line, ellipsis, `sessionDisplayTitle()`) and the family chip, nothing else. **Phone:** the three-line card (#882, #934): the sender with the flags, the title, then the status line with the badge, the strip, the branch and the time. **Activity strip:** 48×12px, bars in `--blue`, `role="img"` named "Tool activity in the last 30 minutes", only while the session is Running or Starting or had tool activity in the last 10 minutes; always on the status line after the badge, never on the title line, and idle rows reserve no space for it. **Selected:** `--surface-selected` and the 2px `--accent` leading bar. **Unread:** an 8px `--blue` dot in the flags and a 600-weight title, never a fill, border or bar; a row that is both shows both. **Focus:** while the list has keyboard focus, its active row shows one inset `--focus` ring. Phones show no selected row. In the stacked layout, when the list is 880px or wider, the same two lines add a snippet after the title and move status, activity, flags and time into fixed trailing columns, with the actions in a column of their own (§6.3, #2218). **Snoozed time:** the return time reads in the zone the Snooze dialog names (`reminderDisplayZone()`, the browser's), whatever zone the reminder was saved from, in the row, its tooltip and the dialog alike. **Actions (#2214):** Snooze, Archive (`sessionArchiveControlLabel()`: "Archive", "Archive and Stop…", "Retry Stop…") and ⋯, trailing at the end of the title line over the row's own fill, so the status and time stay in view; on fine pointers on hover or focus-within, on coarse pointers only ⋯, always, at 44px in a column the row keeps free. Each tooltip names its key. ⋯, right-click, long-press and Shift+F10 open the session's context menu, which on desktop selects the row first, so the menu, the preview and the keys act on one session. The menu, in order, each item after its 16px icon with its keycap trailing: Reply (R), Rename Session…, Pin Session / Unpin Session (S), Mark Unread / Mark Read (U), Fork Conversation… (F; absent where the session can never fork, disabled with its reason otherwise), the reminder item (H), Dismiss Reminder (a returned reminder only), a separator, then the archive item (E). There is no shortcut rail or activity footer: counts live on the tabs and the rail, keys on tooltips, menu keycaps and the Keyboard Shortcuts reference. |

Rules

- Fixed heights: a list never mixes row heights except for group headers. Virtualised lists use one
  estimate. Form choice groups and checkbox rows are the exception and follow the content-height
  rule in §8.4.
- Text clamps: titles 1 line; descriptions 1 line in rows, 2 lines in cards (`line-clamp: 2`), full
  text only in the detail view.
- Metadata placement: identity (agent icon, machine, project) on line 2, left; time and counts
  trailing, tabular, `--text-faint`; status badge trailing on line 1. At most one status badge per row.
- Meta items are separated by 12px space, each prefixed by a 14px icon or a short label, not by
  middle dots.
- Hover: `--bg-elev-2` (fine pointers only). Selected: `--surface-selected` fill plus a 2px
  `--accent` bar on the leading edge; text stays `--text`. Focus: the ring (§16). The three are
  always distinguishable.
- **Phone lists never show a selected row.** When opening a row pushes a separate route (§6.2),
  the list has no selection to show; the last opened row is not highlighted on return. Selection
  styling is a desktop and compact master-detail state only.
- Row actions: trailing, `.icon-btn.sm` or `.btn.sm.ghost`; on fine pointers visible on row hover or
  focus-within; on coarse pointers always visible or behind the row's ⋯.
- A description equal to the name (case-insensitive) is not shown.
- Group headers inside a list: `--type-label` in `--text-dim`, 32px tall, Title Case exactly as
  written, optional count in `--text-faint`. Not sticky unless the list is long (>30).
- **Thread families (#896, #2215)** in the Sessions list. A parent row's chevron is the §5.5 one: a
  14px `ChevronRight` in `--text-dim` inside a 28px `.icon-btn.sm` (36px to look and 44px to hit on
  touch), in the row's leading padding and centred on line one, turning 90° while the thread is open
  over `--dur-base`. It keeps `aria-expanded`, the names "Expand Thread" and "Collapse Thread" and
  its tooltip with the key (T), and is not a tab stop: the list owns the keyboard (T, Shift+T, P). The
  title shrinks to its content and the **family chip** follows it directly (dots, then the rollup,
  "4 Children · 1 Awaiting Input"). Below a 600px list (a narrow column, Preview Right, phones) the
  chip keeps only its dots; it is an image named by the whole rollup, which its tooltip repeats.
  Children indent under a 2px `--border-strong` spine with a tick into each row. A stalled parent or
  child says so once, with its one status badge (§11.1); there is no stalled rail or border, because
  the leading edge is the selection bar.

### 5.3 Cards (Grid)

Use cards only when items are browsed visually side by side and each item is one object with a few
facts (automation templates, instance tiles). Machines, instances, runs and pods are **lists** by
default (converge on the People & Devices anatomy).

- `display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); align-items: start`.
- Card: `.surface` + padding 16, `--radius-md`. Title 1 line, description clamp 2, meta row, actions
  pinned to the bottom-right in an `.actions` row. Fixed height per grid (all cards in one grid are
  equal because content is bounded).
- A card is an `<article>` with a stretched link or button for the primary click, never a
  `<button>` wrapping content.
- **Board cards (#2222)** are cards in a column rather than a grid, with one anatomy. Line 1 has the agent
  icon and "Agent · Project" (it gives up width first), then the machine as quiet meta after its 14px icon
  (only when there is more than one machine), the pin, the time and ⋯. ⋯ shows on hover and focus on
  fine pointers and is always there on touch. It opens the session's context menu (§5.2). Next comes the
  title, clamped to 2 lines, then a status line that is always present: the one status badge by
  `sessionRowStatus()`, then the activity strip under the row's rule. A parent shows its family chip
  in place of the strip: an image named by the whole rollup, with that tooltip. It shows its words only
  while they fit beside the badge in the card, measured on the card's own width rather than the list
  pane's, and otherwise keeps just its dots. The status line is one 20px line and the badge never
  clips: a strip that does not fit beside the badge drops out of sight. Last is either the request or a
  one-line `plainTextPreview()` of the latest message. The request is a warning inset notice (§13.2):
  the request in `--type-body` with a code line when it has one, then **Approve** and **Deny** as
  the equal pair (§3.1). Approve is the first one-time allow option and Deny the first one-time reject
  or deny option. A persistent `*_always` option is never relabeled; it stays in the session. A question shows **Answer in Session**. A sign-in shows
  one primary **Sign In** menu button: its methods are two-line items, and Cancel Sign-In is last, in
  the danger style. Hover steps the fill up one surface; nothing moves.

### 5.4 Facts (Read-Only Labels and Values)

One recipe for every read-only label and value list. It is the §19.4 merge of the proposed
`.facts`, `dl.facts`, `.kv` and `.kv-list`.

- `<dl class="facts">`: a two-column grid, `auto` labels and `minmax(60%, 1fr)` values, so a
  value always keeps at least 60% of the width and a long label wraps instead of starving it;
  `gap: var(--space-2) var(--space-4)`, baseline-aligned. Pairs may be flat `<dt>`/`<dd>` or one
  `<div>` per pair (the `<div>` is `display: contents`).
- Label (`dt`): `--type-label` in `--text-dim`, Title Case (a definition term, §17.1). Value
  (`dd`): `--type-body` in `--text`, wrapping anywhere rather than overflowing.
- `.facts.strip` is the summary strip above a table or chart (Usage totals, later Archive): the
  pairs side by side between two hairlines, separated by vertical hairlines, the value in
  `--type-title` with tabular figures. Under 760px the strip becomes rows, label left and value
  right. It is a modifier, not a second class.
- A region may set the list's spacing or size (the background work panel uses `--type-small`) but
  not its structure.
- Replaces `.agent-details-grid`, `.background-work-job-meta`, `.usage-totals`,
  `.subscription-buckets`, `.skills-orphan-facts` and `.settings-about`. Ten more `<dl>` recipes
  remain (§19.4); each area moves its own onto `.facts` when it is redesigned.

### 5.5 Disclosure (Expand and Collapse)

One look for every expand and collapse: a leading 14px `ChevronRight` (§18) that turns 90° when
open, with a `--dur-base` transition.

- The container is `.disclosure`. With a `<details class="disclosure">` the `<summary>` is the
  trigger; otherwise the trigger is a `button.disclosure-trigger` with `aria-expanded`.
- Trigger: `--control-h-sm` tall, `--type-body-strong` in `--text-dim`, padding `0 8px 0 4px`,
  `--radius-sm`; hover fills `--bg-elev-2` with `--text`. The icon is `.disclosure-chevron`.
- The revealed content is `.disclosure-body`: a column with a 12px gap and 8px above.
- A region may size the trigger to its surroundings (the transcript's Worked row keeps
  `--type-small` in `--text-faint` and fills its row) but keeps the chevron and its rotation.
- Replaces `.access-manual-disclosure`, `.project-location-create-disclosure` (with its `+`/`−`
  text glyph), `.runner-disclosure-chevron` and `.tl-disclosure` (with its `▸` glyph).
  `.share-disclosure` was a risk warning, not an expand and collapse; it moved to a warning Notice
  (§13.2).

### 5.6 List Foot

`.list-foot` (`ListFoot`): an entry after the last row of a list that leads somewhere else (the
Skills list's Orphaned Copies entry, a "Show 20 More" row). It sits 12px below the list with 8px
above its top hairline, is at least `--row-h` tall, and reads in `--text-dim`. The Agent Skills
list's Orphaned Copies entry is its first use (#1961): a one-line row with the amber `CountBadge`,
shown only while a machine reports copies.

---

## 6. Master-Detail Layout

Used side by side by Agent Skills, Projects, Connections › Machines (when selected), Settings
(section nav plus content). The Requests panel is too narrow for two panes, so it is a navigator at
every width (§6.4). Sessions (list plus preview) uses the stacked
variant by default and offers side by side as a user preference (§6.3).

```
┌ Page header (full width) ────────────────────────────────────────────────┐
├──────────────────────┬───────────────────────────────────────────────────┤
│ [Search ⌕] [Filter]  │ Detail bar or detail header                        │
│ Group label          │                                                   │
│ ▌Row (selected)      │ Sections…                                         │
│  Row                 │                                                   │
│  Row                 │                                                   │
│ 320px, own scroll    │ fills, own scroll                                 │
└──────────────────────┴───────────────────────────────────────────────────┘
```

- Grid: `grid-template-columns: var(--list-pane-w) minmax(0, 1fr)`, height fills the viewport below
  the page header; each column scrolls independently; `scrollTop` resets on selection change.
- The list pane is flush (no card), with a hairline divider between the columns. A 4px resize handle
  sits on the divider (hover shows a 2px `--border-strong` grip; drag or arrow keys resize 280–440px).
- List pane header: search field (`--control-h`, full width) and at most one filter control.
- **Selection lives in the URL** (`/skills/~<id>`) so Back and deep links work.
- Detail pane gets `container-type: inline-size`. Grids inside it use `minmax(0, 1fr)` tracks, and
  wide tables sit in a horizontal scroll wrapper, so the detail can never overflow the viewport.
- **Class names.** Production uses `.master-detail` (`.master-detail-list`,
  `.master-detail-list-head`, `.master-detail-list-body`, `.master-detail-detail`,
  `.master-detail-resize`). `.md` stays reserved for rendered markdown, which production already uses.
- **Built (#1947), Agent Skills first.** The grid sits in a `.page.full.fill` page, starting at the
  page gutter so rows line up under the title. `--list-pane-w` is 320px, and 280px in the compact
  tier (`@container app (max-width: 1099px)`). `.master-detail-list-body` is the list's scroll
  container, under an optional `.master-detail-list-head` that stays put. The detail lays its
  children in a reading column of at most 920px. `data-detail-open` on `.master-detail` marks a
  route that opens something in the detail, and at 760px and below that route shows only the detail
  (§6.2). `.master-detail-state` takes both panes' place for an empty collection or a load error
  (§6.1, §12). `DetailSkeleton` (`common.tsx`) is the detail's loading state. The page resets the
  detail's `scrollTop` on each route, and on a phone it restores the list's position on Back. The
  side-by-side resize handle is built for Sessions' Preview Right (#2219, §6.3), and its stacked
  divider (#2217); Agent Skills' list pane does not resize yet.

### 6.1 The Default Detail State (No Selection)

Never a centered sentence. Pick the first rule that applies:

1. **Collection Overview** (default for Skills, Projects, Connections): a top-aligned summary of
   the collection that is useful without a selection.
   - Title row: `--type-title` "Library Overview" (or the destination noun) + one line of counts.
   - **Needs Attention**: a Surface of rows, one per item that needs the user (error, drift, offline,
     held update), each with a status badge and an action ("Review"). If nothing needs attention, one
     line with a green dot: "Every skill is deployed as assigned."
   - **Recently Changed**: up to 5 rows (the last items edited or deployed), each opening the item.
   - **Get Started** (only while the collection is small, <3 items): the create and import actions as
     secondary buttons with one line each.
2. **Auto-select** (desktop and compact only) when there is no meaningful overview and selecting has no
   side effects: select the first row.
3. **Sessions** keeps its existing behavior: open the most urgent session in the preview, per the
   priority rule of the settled sessions list design.

If the **collection is empty**, the list pane and detail pane are replaced by one empty state spanning
the content area (§12.1), not an empty list beside a void.

### 6.2 Phone

List and detail are two routes. Tapping a row pushes the detail route; the app bar shows ‹ Back and the
entity title (§15.1). The list keeps its scroll position on return, and shows no selected row.

### 6.3 Stacked List and Preview (Sessions)

For a triage list whose rows are read across the full width and whose detail is a quick look rather
than a place to work. Sessions uses it by default and keeps its list over the preview. Other
master-detail pages stay side by side.

```
┌ Page header and tab row (full width) ────────────────────────────────────┐
├──────────────────────────────────────────────────────────────────────────┤
│ ▌Row (selected)  snippet …           status  activity  flags  time  ⋯    │
│  Row                                                                     │
│  Row          whole rows only, 45% of the area, at least 3, own scroll   │
├─────────────────────────────────── ▬ ────────────────────────────────────┤
│ Detail bar: title, status ............ actions, Open Session             │
│ Preview body, left-aligned at the page gutter, max 860px, own scroll     │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Grid.** `grid-template-columns: minmax(0, 1fr)`; `grid-template-rows: var(--sessions-list-h)
  minmax(0, 1fr)`, filling the height under the page header. The list height is a stored ratio of the
  split area (default 0.45, clamp 0.25–0.75) rounded down to whole rows plus the list's 8px top pad,
  never under 3 rows, and never so tall that the preview drops under 240px. At 1440×900 that is 6 rows
  of `--row-h-2`; the divider never cuts a row. Rows must be exactly their row token for this to hold.
- **Panes.** Both panes are flush (no card) and span the page between the gutters, so the page
  title, the tab row, the rows and the preview all start at one left edge. The list body and the
  preview body each scroll on their own; the page never scrolls. Notices above the list (order
  changed, sign-in) take list height; they do not push the divider. A new selection resets the
  preview's scroll to its request or latest turn; resizing never scrolls either pane.
- **Divider.** The list's 1px `--border` bottom edge is the divider. A 9px hit band (17px on coarse
  pointers) is centered on it with `cursor: row-resize`, plus a 32×4px `--border-strong` grip in the
  middle that is always visible (40×6 on touch): a plain rule between two full-width panes does not
  read as movable. Hover and drag draw the line at 2px `--border-strong`; keyboard focus draws it at
  2px `--focus`. No band, no second rule. `role="separator"`, `aria-orientation="horizontal"`,
  `aria-label="Resize List and Preview"`, `aria-valuenow` in percent.
- **Resize.** Drag follows the pointer and snaps to the nearest whole row on release. ↑/↓ move one row;
  Home = 3 rows; End = the tallest list that keeps a 240px preview; Enter or double-click resets to the
  default. The ratio persists per device.
- **Rows use the width (#2218).** The list pane is a size container (`container: list /
  inline-size`). At a list width of 880px and wider, which the stacked layout reaches in windows of
  1100px and wider, rows keep exactly `--row-h-2` and add what a narrow column cannot. Line 2 adds a
  one-line `--text-dim` snippet after the title: what the session wants, the top request the person
  owns (the badge's ranking) else the latest agent message, as plain text (`plainTextPreview()` in
  packages/protocol, which Board cards reuse). With a snippet, the title keeps at most 60% of the
  line and the snippet takes the rest and truncates. Line 1's trailing cluster becomes fixed
  columns, 12px apart and the same on every row, so the badges start and the times end at one x
  down the list: **status** (184px: the one badge and "+N"; a longer label clips), **activity**
  (48px: the strip, only under #2209's rule, so an idle row leaves it empty and the strip never
  moves to the title line), **flags** (32px: pin and unread), **time** (96px, right-aligned,
  tabular; the issue's 64px could not hold a snoozed row's return time after its alarm clock, up to
  about 92px). An empty cell keeps its width. After the time, an **actions** column (104px) holds
  the row's hover actions (§5.2), centred on the row, so hovering never covers the status or the
  time; on coarse pointers it holds only ⋯. Below 880px rows keep #2209's two-line anatomy.
- **Keyboard.** F6 and Shift+F6 cycle rail → list → preview (§16.1). ↑/↓ move the selection and the
  preview follows; keys that act on the previewed item (page the preview, approve, open) work while
  focus stays in the list. Tab and Shift+Tab in the list switch groups (kept by epic #2227, #2180),
  so the divider is reached with F6 into the preview, then Shift+Tab back through it; in the preview
  Tab and Shift+Tab are plain focus moves. Escape in the preview returns focus to the selected row.
- **Side by side as a preference.** Sessions offers the §6 side-by-side grid as **Preview Right**
  (list 400px, 280–440, vertical divider with the hover-only grip of §6). The choice is a per-device
  preference with **Preview Below** as the default; it is set by an icon segmented control right
  after List/Board (accessible names "Preview Below" and "Preview Right") and by the Sessions Layout
  row in Settings › Appearance › Display. Both write one key and update each other live.
- **Widths.** Preview Right applies at 1100px and wider only; at compact widths (761–1099px) Sessions
  is always stacked and the control is hidden, which also keeps the compact header to its budget
  (§15.2). Phones have no preview (§6.2), whatever the preference.
- **Empty.** An empty list replaces both panes with one state (§6.1); no divider is drawn.
  **Built (#2220).** `.inbox-state.master-detail-state` takes the list pane's place on the page grid,
  and the preview and divider are not rendered. The state follows the §12 order: Reconnecting… while
  disconnected with nothing loaded, then skeleton rows while sessions arrive (§12.3), then No Matches
  (§12.2), then one state for the group's situation (`sessions-states.ts`, `SessionsStates.tsx`):

  | Situation | Icon | Title | Actions |
  | --- | --- | --- | --- |
  | No sessions anywhere | inbox | No Sessions Yet | **New Session** (primary), New Project… |
  | A Project with none | inbox | No Sessions Yet | **New Session Here** (primary, in that Project) |
  | A Project without a Location | map-pin-off | No Location Yet | Add Location (the Project's page) |
  | Every Location's machine offline | cloud-off | Location Offline, naming each machine once | Manage Locations |
  | Locations missing or removed | map-pin-off | No Location Available | Manage Locations |
  | No Project | folder | No Sessions Without a Project | **New Session** (primary, no Project) |
  | Snoozed, none | alarm-clock | No Snoozed Sessions | Show Active Sessions |
  | Every session snoozed | alarm-clock | No Active Sessions | Show Snoozed Sessions |

  Actions are `.btn.lg`. While the state offers New Session the header's is hidden (§12.1); the
  others are secondary beside it. Below 760px the actions stack at full width, 44px tall (§12.4).
- **Built (#2217), Preview Below.** `.inbox-view` takes `.master-detail.sessions-md` on desktop and
  tablet, and stays a flex column on a phone, on the board and in an open session. InboxView measures
  the split area and `--row-h-2` and sets `--sessions-list-rows` (the stored ratio's whole rows, in
  `sessions-split.ts`); the grid derives `--sessions-list-h` from it, so a density change keeps whole
  rows. A drag sets `--sessions-list-h` on the grid until the release snaps it, and only a release or
  a key stores a ratio: the middle of the chosen row, so a reload rounds back to the same count. The
  panes and `.master-detail-resize` are placed by grid row, so Preview Right (#2219) can place them by
  column. The divider draws the hairline itself, on the preview's first pixel, so the list's last row
  keeps its full height; its keyboard focus draws the 2px `--focus` line over a transparent outline,
  which forced colors paints. The stored range stays 25–75% and bounds the row range too, so every
  count survives a reload: where the split area is taller than about 930px (56px rows) Home stops at
  the 25% floor rather than three rows, and End at the 75% cap. An unfinished drag (the divider
  unmounts for the board or a phone width) clears its height. The docked request card at the top of
  the preview sits in an opaque slot with a 1px `--border` hairline and `--elev-1`, so the transcript
  visibly scrolls beneath it.
- **Built (#2219), Preview Right.** `sessions-preview-layout.ts` stores `below` (the default, and
  what any missing or unknown value reads as) or `right` in `wollipog.sessions.previewLayout`, per
  device and instance, never synced; a module store keeps the header control and the Settings row
  live with each other. The Preview Layout control (`PanelBottomIcon`, `PanelRightIcon`; tooltips
  "Preview below the list" and "Preview beside the list") follows List/Board in the header's controls
  slot, at 1100px and wider only. On the Board it keeps its width but is hidden, inert and out of the
  accessibility tree, so switching List/Board never moves the switch (#2159). `.inbox-view` carries
  `data-layout` with the layout in effect: `right` only when the preference is Preview Right and the
  window is 1100px or wider, so a compact window stacks and the stored choice returns when it widens.
  The Board, an open session and a phone carry none. Preview Right places the same panes by column: `--sessions-list-w` (stored in
  `wollipog.sessions.listWidth`) then the preview, both full height. Its divider is the column's right
  hairline, drawn on the preview's first pixel in a 4px `col-resize` band (17px on coarse pointers);
  the line turns 2px `--border-strong` on hover and drag and 2px `--focus` on keyboard focus, and only
  touch, which cannot hover, keeps a 6×40px pill grip. `aria-orientation="vertical"` and
  `aria-valuenow` in pixels; ←/→ move 16px, Home and End go to 280px and 440px, Enter or a
  double-click restores 400px, and only a release or a key stores a width. The preview pane is
  isolated so its docked request stays under the band. The preview's bar, meta line, docked request
  and transcript start at `--preview-inset`: the page gutter when stacked, `--space-6` from the
  divider in Preview Right. The 400px column is under 880px, so rows keep #2209's two-line anatomy,
  and a notice above the list tops the list column only.

---

### 6.4 Navigator (the Requests Panel)

The Requests panel (`SessionRequestPanel`, #2206) is a list and a detail that replaces it, at every
width, as a phone's two routes are (§6.2). The list has the groups "Waiting for You" (a warning count
badge, §11.4) and "Orchestrator Is Handling" (a plain count), each a group header over two-line rows
(§5.2): the kind's icon (`--amber` for what waits for the person, `--text-faint` for the
Orchestrator's), the request's title and a short time, then "<Kind> in <child session>". Arrow keys,
Home and End move through the rows. Choosing one replaces the list with its detail: a head with
"‹ All Requests", "Request 2 of 8" and ‹ › to step through the request's group in list order, and the
child session's title as a link to it; then the Request Card in its panel presentation (§13.2). "‹ All
Requests" returns to the list, at its scroll position, with focus on the request's row. An answered
request gives way to the next one in its group, and with none left the list comes back. Loading is
skeleton rows, unavailable a danger notice with Retry, and empty the compact state "Nothing Waiting"
with a link to Decision History. In the compact tier the panel opens over the transcript from the
right with a scrim (§15.2); on a phone it is the full-screen panel.

## 7. Dialogs and Sheets

### 7.1 Sizes

| Size | Width | Use |
| --- | --- | --- |
| `.modal.sm` | 400px | Confirmations. |
| `.modal` (md) | 560px | Forms (New Session, New Skill, Rename). |
| `.modal.lg` | 800px | Review and diff, two-pane managers, pickers with previews. |
| `.modal.full` | `min(1200px, 100vw - 48px)`, height `100vh - 48px` | Rare: long review flows. |
| Phone | Bottom sheet, full width | All of the above at ≤760px. |

`max-height: calc(100dvh - 48px)`. The body scrolls; header and footer stay fixed. The body never
has a fixed `min-height` (the 340px Find Agent Sessions void): content sizes the dialog, and a height
change animates with `--dur-base`. Dialogs are portalled to `document.body`, so an ancestor's
`transform` or `overflow` cannot clip them (as it clipped Rename Project inside the tab strip).

Nested dialogs (New Session → Create Project, a confirmation from a form): on desktop the child
stacks on the parent, which stays visible under one shared dim (no second backdrop, no blur); closing
the child returns focus to the control that opened it inside the parent. `Modal` marks every dialog
opened over another as `.modal-backdrop.stacked`, whose backdrop is transparent; only the oldest open
dialog draws the dim. The area names `.stacked` and `.nested` both mean this class. On phones the child pushes
onto the sheet with a back arrow (§7.5). A child never discards its parent, which loses the user's
input.

**Phones: a confirmation replaces the sheet's content.** A confirmation opened from a sheet
takes over that sheet's content under the same dim: its header shows a Back arrow (accessible name
"Back to <parent title>") where the tone icon or close would be, and the confirmation slides in from
the right. Back or Cancel returns to the parent content with every value kept. A second sheet never
stacks on the first. Desktop keeps stacked dialogs as above.

### 7.2 Anatomy

```
┌──────────────────────────────────────────────┐
│ [!] Title                              [×]    │ header: 56px, padding 12 12 12 20, hairline below
│     One-line description (optional)           │
├──────────────────────────────────────────────┤
│ Body: padding 20, gap 16, fields or content   │
│                                              │
├──────────────────────────────────────────────┤
│ [Delete…]                 [Cancel] [Primary]  │ footer: padding 16 20, hairline above
└──────────────────────────────────────────────┘
```

- Radius `--radius-lg`, `--bg-elev`, 1px `--border-strong`, `--elev-3`.
- Title: `--type-title`, Title Case, a label (not a question): "Rename Session", "Delete Skill".
- Close: 32px square `.icon-btn` with the Lucide `X`, `aria-label="Close"`. Confirmations have no
  close button (Cancel does that job).
- Description (optional): `--type-body`, `--text-dim`, one sentence.
- Body sections: `--type-section` headings with 24px above; no bordered subsections.
- The card itself is focused on open **without** a visible ring (§16.1); the first field (or Cancel in
  a destructive confirmation, the primary in a non-destructive one, or the name field in a
  type-to-confirm dialog, §7.4) receives focus.

### 7.3 Footer and Action Order

- Right-aligned: **Cancel** (`.btn`, secondary, never ghost) then the **primary**. The primary label
  repeats the dialog's verb ("Create Session", never "OK", "Submit" or "Continue").
- **Steppers.** On an intermediate step of a stepper dialog (Pair Device step 1 of 3) the
  primary may be **Continue**, with Back as the secondary from step 2 on. The final step's primary
  names the outcome ("Pair Device"), never Continue.
- A destructive tertiary action (Delete Team, Remove Location) goes far left as `.btn.ghost.danger`
  and opens its own confirmation.
- A harmless extra action (Show Sessions) is a `.btn.ghost` after the spacer and before Cancel
  (§3.2). It is not the tertiary slot, which is reserved for a destructive action.
- Submit errors render as a danger Notice directly **above** the footer, inside the body's end. Field
  errors render under the field (§8.5).
- A disabled primary shows why in the footer's left slot as `--type-small` `--text-dim` text ("Choose
  a preset or enter a time.").
- Close-only dialogs (read-only info) have one secondary "Done" button, not a primary.

### 7.4 Destructive Confirmation

```
┌ [⚠ red 20] Archive and Stop Session ───────────┐
│ "Fix the half-cent rounding bug" stops now and  │
│ moves to Archived Sessions. You can restore it. │
├─────────────────────────────────────────────────┤
│                      [Cancel] [Archive and Stop] │  ← .btn.danger, solid
└─────────────────────────────────────────────────┘
```

- `.modal.sm`, danger tone icon (TriangleAlert, `--red`) before the title.
- Title: the action in Title Case, no question mark: "Delete Skill", "Archive and Stop Session",
  "Discard Copy".
- Body: **one or two sentences**: what happens, to which named object, and whether it can be undone.
  No mechanism, no ids.
- Confirm button: `.btn.danger`, same verb as the title and the trigger. Cancel has initial focus.
- **What it affects.** When the action affects named objects (the sessions an update interrupts),
  list them as `detailRows` rather than drawing a list in `details`: one `.surface` of `.row.dense`
  rows under the body, each a label that truncates on one line with its full text as a tooltip, an
  optional trailing meta, and an optional inline status badge (`.status.inline`, §11.1). At most five
  rows show; the rest read "and N more" in `--text-dim`, counting any the caller knows of but cannot
  list (`detailRowsOverflow`). The rows are part of the dialog's accessible description. `details`
  stays for content that is not a list, such as a mono preview.
- **Naming the safe choice.** `cancelLabel` replaces "Cancel" when the safe choice has a better name
  ("Keep Open", "Install Later"). It is still the secondary `.btn`, still the initial focus of a
  destructive confirmation, and Escape, the scrim and Back still choose it.
- **A harmless extra choice.** `secondaryAction` adds a `.btn.ghost` before Cancel (§7.3) for a
  non-destructive alternative ("Show Sessions"). Choosing it closes the confirmation and runs the
  action; the confirmation resolves as not confirmed. It is not shown on a phone (§7.5), so a flow
  must still work without it.
- Irreversible actions affecting many items add a type-to-confirm field (`typeToConfirm`) only when
  more than one item is affected. Delete Group always asks for the name: a group's rules reach every
  current and future member, so its reach is never one item (#1985).
- **Type-to-confirm dialogs focus the name field**, not Cancel: the user must type before
  anything else can happen, and the danger button stays disabled until the name matches, so focus
  there cannot confirm by accident.
- Non-destructive confirmations (Recover Session) use a primary button and no tone icon, and open
  with focus on the primary.
- `window.confirm` is banned; every confirmation goes through `useFeedback().confirm`.

### 7.5 Phone: Bottom Sheet

- Full width, anchored bottom, `--radius-lg` on top corners only, 4px × 36px grabber (decorative, the
  scrim and Cancel close it), `max-height: 92dvh`.
- Header 48px: title 16/600, close icon 44px hit.
- Footer sticky at the bottom with the safe-area inset; **at most two buttons, side by side, equal
  width, 48px** (`--control-h-lg` coarse): Cancel left, primary right. A destructive tertiary moves
  into the body end as a full-width ghost danger row. A confirmation's harmless secondary action is
  not shown (§7.4).
- The sheet sits on the software keyboard, never behind it: while one of its fields has focus, the
  footer stays fully visible and the sheet's height shrinks by the keyboard (`--keyboard-inset` on
  browsers that shrink only the visual viewport).
- A label longer than its half of the footer ("Interrupt Sessions and Update" at 390px) wraps,
  centered, inside its button, and never truncates: the person reads the whole action before
  confirming it. Two lines fit the 48px; a third grows both buttons together, so the pair keeps one
  width and one height.
- Long forms (New Session) open as a **full-height sheet** (`height: 100dvh`, no grabber, back
  arrow instead of close).
- Nested dialogs push onto the sheet with a back arrow instead of replacing the parent. A
  confirmation opened from a sheet replaces the sheet's content, with Back, and keeps the parent's
  values (§7.1); it never stacks a second sheet.
- Menus and popovers shown as sheets (§9.2) carry the same 36px grabber.

---

## 8. Forms

### 8.1 Field Anatomy (One Primitive: `.field`)

```
Label                               (Optional)
[ control ..................................... ]
Helper text, one sentence.            ← or the error, which replaces it
```

- Label: `--type-label` (12/16, 500) in `--text`, 8px above the control. Title Case. Optional
  fields say "(Optional)" in `--text-faint`; required is the default and unmarked.
- Control: `--control-h`, `--field-bg`, 1px `--control-outline`, `--radius-sm`, padding 0 12px,
  `--type-body` weight 400. Placeholder `--text-faint`, example-style ("e.g. staging-vpc"), never a
  label substitute.
- Read-only (`readOnly` plus `.is-read-only`, for a value the person can never change here): a
  dashed edge on a `--bg-elev-2` fill, value in `--text-dim`, text cursor, still in the tab order and
  selectable. Unlike disabled (§3.1: `--text-faint`, `not-allowed`, `GrayText`), it keeps
  `CanvasText` and its dashed edge in forced colors. A field read-only only while a request runs
  takes no marker and keeps the editable look.
- Disabled: a disabled text input, textarea or native select in a `.field` draws its value in
  `--text-faint` on the unchanged `--field-bg` fill and edge, with `cursor: not-allowed` and no
  opacity (Chromium's own 0.7 on a disabled select is reset); SearchableCombobox's `aria-disabled`
  input and the Select trigger's `aria-disabled` button take the same ink (the trigger's placeholder
  too), and neither disabled picker's edge steps up on hover. A field has a fill of its own and
  rests in `--text`, so it is a filled control under §3.1 and takes `--text-faint` (6.42:1 dark,
  5.58:1 light on `--field-bg`), not the fill-less `--text-disabled` (3.93:1, 3.38:1), which is never
  for text a person has to read. The value then shares the placeholder's tier, which is accepted
  because the other tier would fail 4.5:1; where the person would expect the field to work, its
  reason is visible text (§3.1). In forced colors its value and edge are `GrayText` (§3.1), as are
  the Select trigger's caret and SearchableCombobox's chevron; an editable field keeps `CanvasText`.
- Helper: `--type-small`, `--text-dim`, 4px below. One sentence.
- Spacing: a `.field`'s parts stack `--space-2` apart, which puts the label 8px above the control;
  the helper, the error that replaces it and a `.field-foot` pull up by `--space-1` to sit 4px
  below it. A field warning pulls up by the same `--space-1`, 4px under the helper (§8.5).
- Fields stack with 16px gap; related fields share a row on desktop with 12px gap
  (`.field-row`, two equal columns that collapse to one under 480px). The row sizes itself, so one
  shared rule stacks every row on a phone sheet and a dialog never writes its own collapse. It is
  not a size container query: a size container around a dialog's scrolling body would clip its
  Select lists at the build floor (§2.10).
- Fieldsets: `--type-section` legend, 24px above, no border.

### 8.2 Setting Rows (Instant-Apply Preferences)

For Settings and other preference lists, the label sits left:

```
Title                                              [ control 240 ]
Description, one line of --text-dim 12px.
```

One grid for every setting row: `grid-template-columns: minmax(0, 1fr) var(--setting-control-w, 240px);
gap: 24px; min-height: var(--row-h-2); padding: 12px 16px`, inside a Surface with hairlines between
rows. Title `--type-body-strong`, description `--type-small` `--text-dim` (12px, never smaller). The
control column is right-aligned; controls fill it (`width: 100%`) except switches (right-aligned).
Under a 560px container the control drops below the text at full width.

### 8.3 Field Widths

| Class | Width | Use |
| --- | --- | --- |
| default | 100% of the form column | Text, selects, comboboxes. **Selects default to full width** inside `.field`. |
| `.w-xs` | 96px | Numbers, ports, counts (with unit suffix inside the field). |
| `.w-sm` | 200px | Short codes, times. |
| `.w-md` | 360px | Names in wide forms. |

Form column max: 560px in dialogs (the dialog body), 760px on pages. Select lists open at least as
wide as the trigger and at least 280px, never narrower, so descriptions do not wrap to 5 lines.

### 8.4 Control Set

| Control | Spec |
| --- | --- |
| Text input / textarea | As §8.1. Textarea starts at 3 rows and grows to 12. `resize: vertical`. |
| Select | Custom `Select` everywhere (native `<select>` removed). Trigger shows a `ChevronDown` 14px. `leadingIcon` draws a 16px icon inside the trigger, before the value. `searchable` leads the open list with a filter field, focused on open (16px text on touch, so iOS does not zoom); the list keeps the side it opened on while the filter narrows it, so the filter never moves. It is the touch form of the Combobox. `invalid` marks the trigger `aria-invalid` for a field error (§8.5), with `describedBy` naming the error. |
| Combobox | Same trigger with `ChevronDown`; typing filters; brand icons sit inside the field, not outside. Built by `SearchableCombobox`: the chevron opens and closes the list without moving the caret, `leadingIcon` is the same 16px slot as Select's, and focus opens the list with the caret after the value (it never selects the value). A search with no results shows the §12.2 sentence, "No projects match “wolipog”.", from the caller's plural `noun`; an optional `createOption` row ("Create Project…") follows it. Other footer actions belong to the area that owns the picker. |
| Checkbox | 16px box, `--radius-xs`, `--control-outline`; checked = `--accent` fill with a check. Label to the right, 8px gap, the whole row is the target (≥32px, 44px coarse). Used for multi-select and consent. Consent labels are sentences and stay in sentence case ("Open the session after creating it"). Built by `Checkbox` (`.checkbox`, a `<label>` around the input): `label` is required and visible, `helper` is an optional second line announced as the description, `consent` marks a sentence label, `ariaLabel` gives a fuller name that contains the visible label where the label repeats down a list, and `labelHidden` is the icon-only form (the bare box with its `aria-label`). |
| Radio | 16px circle; checked = accent ring plus dot. Used inside ChoiceRows. The marker (`.radio-mark`, `.checkbox-mark`) is the restyled native input itself, so focus, `:checked` and `:disabled` belong to what the user sees. |
| Switch | 32×18 track (40×24 on touch), `--radius-pill`, `--control-outline` edge; on = `--accent` track. **For settings that apply instantly.** Label is the row title, and `aria-label` matches it. Never a button that says "On"/"Off". Built by `Switch` (`.ui-switch-control`, `SettingsRows.tsx`): `SwitchRow` renders it with the row's title and description inside, so the whole row is the target, named by its title and described by its description; standalone, beside other controls in a row, it is the bare track, named by its `label` or `aria-labelledby`, with the 44px coarse-pointer hit area. |
| ChoiceRow | One component for radio cards, member checklists, instance pickers: leading control, title, one-line description, trailing meta; selected = `--surface-selected` + accent control; hover distinct. Markers align in one column. **Selection follows the checked input**: the row's selected look and its `aria-checked` (or `:checked`) come from one value, so the look never disagrees with what is announced. Built by `ChoiceRows` (`.choice-rows`; `multiple` for checkboxes) over `ChoiceRow` (`.choice-row`, a `<label>` around a native radio or checkbox): the marker sits on the title's first line, the description is one ellipsized line on desktop and at most two on phones (full text in the tooltip and the accessible description), and rows are `--row-h` tall at least (40px, 48px coarse). A refused choice passes `error`: a §8.5 field error (`.field-error`) in the second line's place, the input `aria-invalid` and described by it. A row with one control of its own (Choose Another Account's Sign In) passes `action`: the row becomes a `div` holding its `<label>` (`.choice-row-main`) and the control (`.choice-row-action`) beside it, because a label may hold no second control, so pressing it never checks the row. An unavailable row keeps its size, reads faint, shows its reason in place of the description, and is `aria-disabled` rather than `disabled`, so arrows still reach it and announce the reason while selection is refused. `ChoiceList` (`.choice-list`) is the compact form: radio rows with a trailing value and no description, for pickers inside sheets. A list beside a detail (Import from Git's skills beside their files) passes `show`: the marker becomes a target of its own, the rest of the row is a button that shows the row without changing its marker, the fill follows the row shown (`aria-current`), and the meta moves onto the title's line so the description has the row's width. |
| ChoiceTiles | Equal tiles for a few short presets whose second line is the reason to pick one: Snooze's presets, each with the time it resolves to (#2181). A `radiogroup` of `radio` buttons, three across and two on a phone, each at least `--row-h` (48px on a phone); the label (`--type-body-strong`) is the tile's name and its detail (`--type-small`, `--text-dim`) its description. Selected is the choice row's `--surface-selected` with a trailing 16px accent check; arrows move and select. An unavailable tile stays reachable, reads faint and says why in its detail. `onChange` reports whether a pointer chose the tile, so a tile that reveals a field (Custom…) moves focus there only for a pointer. Built by `ChoiceTiles` (`.choice-tiles`, `.choice-tile`). |
| Search field | An `.input-affix` text field with a 14px `Search` prefix, always open and one width: focusing or typing never resizes it or moves what sits beside it. Its placeholder names what it searches and its tooltip what it matches. Sessions' (#2200, `SessionsSearchField`) ends the tab row's tools: 240px, 200px in the compact tier, and on a phone the app bar's Search mode, the bar's whole width beside Cancel (#2211); placeholder "Search sessions", tooltip "Searches titles, agents, projects and the latest message.", a `/` keycap suffix on fine pointers (§11.5, §16.2). Escape clears it; Enter moves focus to the first result. While it holds a query the tab counts follow the results (§10.1), the preview follows the first result when the selected session leaves them, and a query with none shows No Matches (§12.2). |
| File picker | A dropzone row: icon, "Drop files here or", `.btn.sm` "Choose Folder…". Never the native "Choose Files / No file chosen". |
| Number with unit | `.w-xs` input with the unit as a suffix inside the field ("30 s"). |

**Form heights and alignment.** Select and combobox triggers and single-line text fields in one
form share `--control-h` (32px fine, 44px coarse). ChoiceRow and ChoiceList form rows use `--row-h`
as a minimum (40px fine, 48px coarse); Checkbox rows use `--row-h-dense` as a minimum (32px fine,
44px coarse). Comfortable density raises row minima through the existing tokens (§2.8). Form
choice and checkbox rows may differ in rendered height for descriptions, disabled reasons, helpers
and wrapped labels. Controls align at their outer left edge; within each choice group, leading
markers share one x position and align with the title's first line. Unavailable rows retain their
minimum and padding; visible reasons may add height. The §5.2 fixed-height list rule does not apply
to these form choice groups.

### 8.5 Validation

- `noValidate` on every form: no native browser bubbles.
- Validate a field on blur after it was edited, and every field on submit. Errors clear as the user
  types a valid value.
- **Invalid field** (`.field-error`, `FieldError`): the error is a `CircleAlert` 14px and
  `--type-small` text, both in `--danger-text`, in the place of the helper (`.field-helper`), so the
  field does not shift when one replaces the other. Every control inside a `.field` that carries
  `aria-invalid="true"` draws its 1px edge in `--red` (one rule, `.field [aria-invalid="true"]`,
  which holds on hover too); its focus ring keeps the standard `--focus` outline (§16.1). The
  contract:
  - the field gets `aria-invalid="true"`;
  - the error replaces the helper: the two are never shown at once;
  - `aria-describedby` points at the error while it shows, and at the helper otherwise, so
    `FieldError` requires an `id`;
  - the error is not `role="alert"`: on submit, focus moves to the first invalid field, which
    announces it;
  - the message is one sentence that says what is wrong and how to fix it.

  Errors under a field use `FieldError`, never `.form-error`, which stays for footer errors until
  the danger Notice replaces it (§13.2). New Skill uses it (#1964); each other dialog adopts it in
  its own issue and deletes its local error class when it does.
- Error copy: what is wrong and how to fix it, one sentence: "Use lowercase letters, digits, dots or
  dashes."
- Submit errors (server, network): danger Notice directly above the submit row, rewritten for users;
  raw detail behind "Show Details".
- Primary stays enabled while the form is incomplete in short forms (clicking it reveals the errors);
  in long forms it is disabled with a visible reason in the footer (§7.3).
- **Field warning** (`.field-warn`, `FieldWarning`): a non-blocking warning about a valid value
  ("This branch already has a worktree."). It sits under the helper, pulled 4px closer: a 14px
  `TriangleAlert` in `--amber` and `--type-small` text in `--text-dim`, never amber text. The field's
  `aria-describedby` points at it. It is the sibling of the field error (`FieldError`), which blocks
  submission and replaces the helper. No screen uses it yet.
- A failed instant-apply setting (Settings › Network › Tailnet) shows its error in place of the
  row's description in `--danger-text` (`.danger-text`).

### 8.6 Save Models

| Model | Where | Pattern |
| --- | --- | --- |
| Instant | Toggles, selects in settings rows. | Applies on change; a quiet "Saved" check appears for 2s at the row's right edge (`SwitchRow`'s `saved`, announced by a polite region beside the row). |
| Dialog | Creation and focused edits. | Footer Cancel + primary. |
| Editor | Multi-field editors in a page (Agent Defaults, Orchestrator, Automation editor). | A sticky save bar at the bottom of the page region, visible only when dirty: "Unsaved changes" + Discard (ghost) + Save (primary). Save is disabled when clean. |

The editor save bar is `.save-bar` (`SaveBar`): sticky at the bottom of its region, `--bg-elev`,
1px `--border-strong`, `--radius-md`, `--elev-2`, padding 12px 16px, gap 8px, and rendered only
while there is something to save or a save failed. When a save fails it becomes `.save-bar.is-error`:
the notice's danger wash (7% `--red` over `--bg-elev`, a 32% `--red` edge), a `CircleAlert`, the
failure in one sentence (`role="alert"`), and Save becomes **Try Again**. In Settings it floats 16px
above the bottom of the settings panel. No screen uses it yet.

### 8.7 Steps

`.steps` (`Steps`): numbered instructions, for a real sequence the reader follows in order
(connecting a machine). It is an `<ol>`, and each `<li>` is one step. The list draws each number in a
24px circle at the step's leading edge (`--bg-elev-3`, 1px `--border-strong`, `--type-label` in
`--text`, tabular), and steps are 16px apart. `.steps.horizontal` lays three or four short steps side
by side with 24px between them (a first-run explainer under an empty state), and stacks them again
under 760px. It replaced `.onboard-steps`; the proposed `.how-steps` is this variant. The Automations
workflow step list is a different component and keeps a local name.


---

## 9. Menus and Popovers

### 9.1 Menu (One Primitive for `.menu-pop`, `.plus-pop` and the Desktop More Sheet)

- Container: `--bg-elev`, 1px `--border-strong`, `--radius-md`, `--elev-2`, padding 4px, min-width
  200px, max-width 320px.
- Item: `--control-h` (32px, 44px on touch), padding 0 8px, `--radius-sm`, `--type-body`. Leading 16px icon slot
  (kept empty for alignment when any item has an icon). Optional second line (`--type-small`
  `--text-dim`) makes the row auto-height (min 44px). Trailing slot: keycap (fine pointer only),
  submenu chevron, or selection check.
- Selected (radio-like menus): a trailing `Check` icon in `--accent`. Not color alone.
- Section label: `--type-label` in `--text-dim`, 28px row, Title Case, not uppercase.
- Separator: 1px `--border` with 4px vertical margin, full width.
- Destructive items are last, after a separator, in `--danger-text`, with a trailing ellipsis if they
  confirm.
- Disabled items: `--text-faint` with the reason as the second line. The icon and the selection
  check go faint with the words. A multi-colour brand mark (`.multicolor-mark`, such as the Visual
  Studio Code mark in Open In) or an agent mark is drawn in the control's one disabled ink
  (`--text-faint`, or `--text-disabled` in a control with no fill, §3.1) inside any disabled
  control, and keeps its brand colours only while enabled. In forced colors a disabled item, its icon and its check are
  `GrayText`.
- Keyboard: arrow keys, Home/End, type-ahead, Enter/Space, Escape closes and returns focus.
- **Note** (`.menu-note`, `MenuNote`): one sentence of context at the end of a menu, `--type-small`
  in `--text-dim`, max 280px. It replaced `.menu-caution` (#1803).
- **Opening upward.** A menu near the bottom of the view opens above its trigger. `Menu.tsx` places
  every menu and flips it when the space below is short (#1803). An area design that draws
  `.menu.flip-up` or `.drop-up` means this placement, and there is no class for it: the placement is
  inline, and a class with a rule of its own would change what the menu draws.
- **Flyout.** A menu opened from the rail (the instance menu, §4.1) opens 4px to the right of the
  rail rather than below its trigger, top-aligned with it and moved up only as far as the viewport
  needs, so it never covers rail items. `MenuSurface`'s `beside` names the ancestor it opens beside.
- **Height.** A desktop menu scrolls inside past 480px: one cap, held by `Menu.tsx` and the `.menu`
  rule, on the menu surface itself (#1803). An area design that draws `.menu-scroll` means this cap.
  Per-popup caps (the old `.plus-pop` and `.cbar-pop`) are gone.
- **Listbox** (`.menu.listbox`): the Select and SearchableCombobox list. It is the menu container
  around listbox options. `useAnchoredMenuStyle` anchors it to its field and sets its width (at
  least the trigger and at least 280px, §8.3) and its one height cap, `SELECT_MENU_MAX_HEIGHT_PX` in
  `ChoiceControls.tsx`; the stylesheet sets no height. It stays anchored to its field on phones too,
  never a bottom sheet (§9.2). Its width and height are clamped to the viewport. It opens below the
  field, or above it when only that side has room; in a view too short for either (a short or
  scaled pane), it moves as little as it can to fit inside the viewport and may cover the field. It
  appears in place, without the menu's entrance motion. It is not portalled: it stays beside its
  field and takes the field's font. Its placement is measured against its real containing block
  (§2.10), so an ancestor container cannot move it.
  It replaced `.ui-select-list`.

### 9.2 Popover

Anchored, 8px from the trigger, same container recipe as the menu, padding 16px, width 280–360px.
Optional title row (`--type-section` + close icon). Used for inline detail (usage cost breakdown,
context window). Rules for both menus and popovers:

- `consumeEscape: true` by default (fixes Escape leaving the session).
- Close on outside click and on ancestor scroll (or re-anchor); never float over a dialog header.
- Only one floating layer open at a time; opening another closes the first.
- On phones every other menu and popover becomes a bottom sheet with a 48px title row and 44px
  items, and the same 4px × 36px grabber as a dialog sheet (§7.5), so every bottom sheet reads
  alike. Two lists stay anchored at every width instead. The Select and SearchableCombobox list
  (`.menu.listbox`, §9.1) opens beside its field, fitted to the viewport (#2547). The composer's /
  and @ pickers (§21) open above the composer (#2155).

### 9.3 Tooltip

`--bg-elev-3`, `--text`, `--type-small`, `--radius-xs`, padding 4px 8px, max-width 280px, 500ms delay
(`--delay-tooltip`), sentence case. Tooltips never hold information the user needs to act (disabled
reasons, option descriptions): that information must also be visible.

---

## 10. Tabs and Segmented Controls

### 10.1 Tabs (Switch Between Sibling Views of a Place)

Examples: Connections (Machines, Instances, People and Devices), Sessions project splits, Settings on
compact widths, detail sub-views.

- `--control-h-lg` tall (40px, 48px on touch), `--type-body-strong`, `--text-dim`; hover `--text`; active `--text` plus a 2px `--accent`
  underline on the tab's bottom edge, sitting on the header's hairline.
- 24px between tabs (no fills, no borders).
- Counts: 4px after the label, `--type-micro` `--text-faint`, tabular. An attention count uses a warning
  count badge (§11.4) instead.
- Overflow: horizontal scroll with a 24px edge fade on the clipped side; the active tab scrolls into
  view on load, clear of the fade. On phones, more than 4 tabs become a Select-styled "view picker"
  in the app bar.
- Tabs change the URL.
- **Tab bar** (`.tabs-bar`, Sessions' groups, #2180): a row of user-named tabs that can run long.
  The tab row, then a `.icon-btn.sm` list button (`ChevronDown`, "All Groups") that opens a §9.1
  menu of `menuitemradio` rows, one per tab in tab order (the name, the plain count, its badges and
  the trailing check on the current one), then `.tabs-tools` at the far end for the row's tools
  (search, filters). A tab's label is at most 200px and ends in an ellipsis, with the full name in
  its tooltip; the count and badges never truncate. Two tabs with the same name add what tells them
  apart as quiet text ("Docs Site on Build Server 02"). Only the selected project tab is followed by
  a `.icon-btn.sm` ⋯ ("Docs Site Actions"), outside the tab; a right-click, Shift+F10 or the
  context-menu key on any project tab opens the same menu without selecting it, and Escape returns
  focus to that tab (#2199).
- **Counts follow a search** (#2200): while the row's search holds a query, each tab counts its
  matching sessions and its badges count only matches, so a tab with none stays in place reading a
  plain 0 with no badge. Clearing the query restores the totals.
- **Board filters** (`BoardFilterTools`, #2201): in Board mode `.tabs-tools` holds, before the
  search, two `.btn.sm.ghost` menu buttons, "All Machines" and "All Agents" with a trailing
  `ChevronDown`. Each names its choice once one is set (ending in an ellipsis past 200px) and is
  `aria-pressed` while set. Each opens a §9.1 menu of `menuitemradio` rows with the trailing check:
  All, then the machines by their disambiguated names, or each machine's agents in a group under
  its name as a `MenuLabel`. An agent its machine reports unavailable is an `aria-disabled` row with
  its `unavailableReason` (or "Not available on {machine}.") as the second line. A set filter adds a
  quiet "10 of 29" (`--type-small`, `--text-faint`, tabular) and a ghost **Clear**. In the compact
  tier (761–1099px) the two fold into one **Filters** menu button with
  the plain count of active filters, `aria-pressed` while any is set and named "Filters, 1 Active";
  its menu holds a Machine group and an Agent group, then **Clear Filters** after a separator while
  any is set, so the row keeps room for the group tabs.

### 10.2 Segmented Control (Switch the Mode or Filter of the Same Content)

Examples: List / Board, Active / Snoozed, Theme, Unified / Split diff.

- Track: `--control-h` (or `--control-h-sm` in dense toolbars on fine pointers; always `--control-h`
  on touch), `--bg`, 1px `--border` (decorative), `--radius-sm`, 2px inset.
- Options: equal-width, `--type-body-strong` `--text-dim`, nowrap, `--radius-xs`. Selected: the
  **knob**, a `--bg-elev` fill with a 1px `--control-outline` edge and `--elev-1`, text `--text`.
  **No accent fill.** The edge carries the state (4.77:1 dark, 3.99:1 light); a fill-only chip
  measures 1.42:1 and 1.15:1 and fails WCAG 1.4.11.
- The same rule marks every neutral "chosen one among peers": the knob and a toggle that is on
  (§3.1). Hover never draws the edge.
- 2 to 4 options, each label fits on one line at the control's width. If they do not fit, use a
  Select. A segmented control never wraps.
- Counts inside options: `--text-faint`, tabular, after the label.
- **Full width** (`.seg.block`): the group fills its row with equal options instead of sitting at
  its content width, for a filter in a narrow panel (the Projects list's visibility filter). It is
  opt-in: a segmented control in a toolbar does not stretch.
- Keyboard: radio-group semantics (arrow keys move and select).

---

## 11. Badges, Status and Meta

### 11.1 Status Badge (the Only Colored Chip)

```
( ● Approval Required )   pill: 20px (sm) or 24px (md), padding 0 8px, radius pill
```

- Tinted fill `color-mix(tone var(--tint))`, text `--tone-text` (§2.2), **no border**, `--type-micro`
  (11px/500, tabular) at sm, 12px/500 at md. Padding 0 8px; leading 6px dot in the tone's full color,
  4px gap.
- The dot pulses only for Running/Starting.
- Inline variant `.status.inline`: dot + label with no pill, for dense rows and tables.
- Label is Title Case from one vocabulary (§11.2), never raw enum text, never uppercased by CSS.
- **One status badge per entity per surface.** Attention outranks lifecycle: if the session needs the
  user, show only the attention badge, not "Awaiting Input" as well. A Sessions row (#2209) shows the
  top attention kind with a neutral "+N" for the others (listed in its tooltip), on the session bar's
  ranking (`sessionRowStatus()` over `sessionStatusSummary()`), and no badge for Awaiting Prompt.
  Stalled is not a second badge: the row's badge takes the danger tone, stops pulsing, and its tooltip
  says how long the session has been silent. Where that badge would be a busy lifecycle (Queued,
  Starting, Running) it reads **Stalled** (#2215), named "Status: Stalled, Running" with the tooltip
  "Running, but no activity for 14 minutes.", so forced colors and readers without colour vision
  still tell a stalled row from a working one. An attention badge keeps its own label (attention
  outranks lifecycle) and adds ", Stalled" to its accessible name. No rail, border or second pill.

### 11.2 One Vocabulary and Tone Table

| Domain | Label | Tone |
| --- | --- | --- |
| Session attention | Approval Required, Answer Required, Authentication Required, Account Required | warning |
| Session attention | Recovery Required | danger |
| Session lifecycle | Starting, Running, Stopping | info (pulse on Running/Starting) |
| Session lifecycle | Awaiting Prompt | neutral |
| Session lifecycle | Stalled, Failed, Stop Failed | danger |
| Session lifecycle | Stopped, Archived, Snoozed | neutral |
| Session lifecycle | Completed | success |
| Machine / instance | Online | success |
| Machine / instance | Connecting | info |
| Machine / instance | Offline | neutral (hollow dot) |
| Machine / instance / device | Update Required, Sign-In Required, Pairing Required | warning |
| Machine / instance | Unreachable, Error | danger |
| Skill deployment | Linked | success |
| Skill deployment | Pending | neutral |
| Skill deployment | Edited (a machine copy differs from the library) | warning |
| Skill deployment | Update Held (a Git or built-in update waits for review) | warning |
| Skill deployment | Error | danger |
| Automation / run | Enabled | success · Paused: neutral · Running: info · Failed: danger |
| Tool call | Running: info · Completed: success (inline, no pill) · Failed: danger |
| Session family rollup chip | "N Awaiting Input" when a child waits on the user: warning. Otherwise neutral. The settled design's "tints orange" is implemented as the warning tone; `--accent-2` keeps no UI role. |
| Subagent / background job | Queued, Canceled: neutral · Running: info (pulse) · Stalled: warning (still listed by its runner with no result past the stall bound) · Completed: success · Failed: danger · Unverified: neutral, hollow dot (its runner is offline) · Lost: danger (replaces Orphaned) · Result Missing: warning (finished, but the result never arrived) |
| Session header, background work | "Background Work Lost": danger (was "Background Work Orphaned") |
| Delivery receipt | Delivered: success (inline, no pill) · Delivery Failed: danger |
| Queued message (`queuedMessage`: the composer queue) | Pending, Queued, Canceled: neutral · Sending, Starting, Steering…: info (pulse) · Accepted, Pending Delivery: info · Held, Delivery Uncertain: warning · Delivery Failed, Not Sent: danger. Rendered as the inline badge. |
| Message receipt (`messageReceipt`: the one line under a sent message in the transcript — pending prompts, steering, provider commands, the rename) | Sending: a spinner and the word, no badge · Queued, Canceled, Dismissed: neutral · Delivered, Steered the Current Turn: success (inline) · Delivery Uncertain: warning · Delivery Failed, Not Sent, Not Accepted, Rejected, Rename Failed: danger. Rendered as the inline badge. |
| Workflow gate / run decision | Awaiting Decision: warning · Approved: success (inline) · Rejected: neutral |
| Request decision (`requestDecision`: the outcome of every Decision Record and of the settled question row, #2204) | Allowed, Answered, Answered by Policy, Answered by Parent, Rechecked Automatically: success · Rejected, Dismissed, Dismissed by Parent, Ended Early, Replaced, Expired, Resolved by Provider, Another Account Selected, Escalated, Resolved: neutral · Blocked (by a policy, or fail-closed by Wollipog): danger · Timed Out: warning. Always past tense, never a provider's option id. |
| Pod | Active: info · Paused: neutral · Conflicted: warning · Failed: danger |
| Campaign work item (`campaignWork`, Campaign Status) | Planned, Queued, Canceled, Scope Removed: neutral · Running: info (pulse) · Waiting: warning · Blocked: danger · Delivered: success. Rendered as the inline badge on work rows. |
| Provider account | Signed In: success (inline) · Sign-In Required: warning · Signed Out, Status Unknown: neutral |
| Usage (provider availability) | Available: success · Approaching Limit: warning · Temporarily Unavailable: danger |
| Transcript share link | Active: success · Expired, Revoked: neutral. Rendered as the inline badge on Share Transcript's link rows. |
| Pull request | Open, Draft, Merged and Closed are **facts**: row meta with the Git icon, not status badges. |

"Orphaned" is retired everywhere, including the session header badge, which reads "Background Work
Lost". Update Required applies to machines, instances and devices alike.

The queued-message labels were the composer's and the pending bubble's own tables (`LABELS` in
`PendingPromptBubbles.tsx`, `queueLabel` in `SessionDetail.tsx`). The words are unchanged. Held was
drawn in red and is now the warning tone, and every label now renders in Title Case instead of an
uppercase transform.

**Queue tray** (`QueuedMessages`, #2178). Messages not yet sent wait in `.queue`, docked on the
composer card: inset `--space-3` from its edges with no gap, a solid `--border` edge, top corners
`--radius-md`, and a hairline between rows. One header reads "<n> Queued", carries the one Held
badge when the whole queue is held, and says once in sentence case what holds for every row: the
held explanation, a steering reason every row shares ("Claude Code can't take steering mid-turn, so
these send when the turn ends."), a cancel none of them can use, or a Viewer's refusal. A row carries
a badge only where it differs from "Queued" (Steering…, Pending Delivery, Delivery Uncertain,
Delivery Failed), reads its first line (an image-only message reads "Image attachment" after the
paperclip icon), and ends in Steer (`.btn.sm.ghost`, only where steering works for that row), Edit
and Cancel or Dismiss (`.icon-btn.sm`). A cancel that is not available stays, disabled, with its
reason referenced by `aria-describedby`. Below 760px a row is its text and one 44px "Queued Message
Actions" ⋯ button whose menu sheet lists Steer into This Turn, Edit Message and Cancel Message (or
Dismiss Message), each disabled one with its reason as the second line. A delivery failure's reason
is a notice of the slot (§13.2), not part of the row.

**Message receipts** (#2171). What happened to a message after it was sent is one `.tl-receipt` line
under that message, inside the scrolling transcript: after the last canonical item and before the
Working row, right-aligned like the person's own messages. The line reads status first, then the
reason, then the actions (`.btn.sm`, outside the bubble, never an outline button on a fill), with
Show Details last. While the message is not the agent's yet its bubble is unfilled: `.is-pending`
is a dashed `--control-outline` edge, `.is-failed` a red-tinted edge, and `.is-command` sets a
provider command in mono. Reasons come from one `deliveryReason(code)` table in
`conversation-steering.ts`, written for people; an unknown code reads "Wollipog couldn't confirm this
message was delivered." Raw provider text and attempt counts wait behind Show Details. A steer the
agent took keeps a quiet "Steered the Current Turn" under its canonical row. A failed message that
has scrolled out of view raises "1 Message Not Sent" in the floating tail control (#2153).

**Agent rows** (#2183). Each agent a turn spawned is one `.tl-agent` row on the work rule, built
like a step: the §5.5 chevron on a `button.disclosure-trigger[aria-expanded]`, a `Bot` icon, the
spawning call's name ("Coordinate Release Audit"), then `--type-small` meta (the role when the
provider gave one, and "N Steps"), the status from the Subagent row above
(Running a pulsing info badge, every other state inline), and Open, a sibling `.btn.sm.ghost` named
"Open {name}". Below 760px the name takes the whole first line and the meta and status wrap to a second
line under it, so a phone never trades the name for the counts. The spawning call has no step row of its own; its output, when it has any, is a
collapsed Result step after the agent's steps ("Result of {name}"), in the quiet output well with a
failure's lines in the danger colour. A nested agent's steps add one rule under its chevron.

**Plan cards and file diffs** (#2187). A plan is a `.tl-plan` card: a `ListTodo` head with "Plan" and
a plain count (§11.4) "{done} of {total} Done", then its items in a 16px icon column (`CircleCheck`
done in the success text colour, `CircleDot` in progress in blue, `Circle` pending), so every label
starts at the same x. The card appears once per turn, where the plan first changed in that turn, and
updates there; the turn's earlier versions sit behind a §5.5 Show Earlier Versions disclosure inside
it, and a later turn that revises the plan gets its own card. A file edit's step names its
workspace-relative path once (`.tl-path`: mono 12px, the directory in `--text-faint`, giving way before
the file name when the row is short of room) with "+24 −3",
and a `FilePen` icon, or `FilePlus` for a new file. Its body offers Open in Review (the Review tab,
scrolled to that file), Copy Path and Open File as `.btn.sm.ghost`, then the parsed diff: Git's
metadata lines are dropped, each hunk opens with "Lines 12–40" (plus "in Header()" when its header
names one), and each line is a three-column grid of number, sign and text in a sunken well.
An edited file's added and removed lines take a 9% wash of their tone; a new file is plain code with
green + signs. After 8 lines the rest waits behind Show N More Lines. A binary, renamed or empty
change has no lines; it says what changed in one sentence instead ("Binary file changed."). The
runner's per-turn capture names every file it shows, even a lone one.

**Question rows** (#2188). An agent's question is one step (`QuestionHistoryRow`): the §5.5
chevron, a 16px `MessageCircleQuestion` (§18), line 1 the question's header or first line (several
questions in one request name every header), line 2 in `--type-small` `--text-faint` with the answer
("Answer: Destination 1 (Production)", free text in quotes, "Answer not shown" for a secret or email
answer, "Policy: <name>" after a policy's answer), then the clock time and the inline `question`
status above. Both lines clip at the end. The body shows each question once, its options with a 14px
success check on the chosen ones, free text in quotes, and one faint sentence saying who settled it:
"Answered by you at 12:31 AM", the policy, or the parent session. A member's answer names them
relative to the viewer (#2527): "you" only when the viewer answered, otherwise their display name
from the organization directory, or "another member" when it has none, never a raw user id. The
runner records the answering member's user id as `answeredByUserId` on that exact
`question_resolved` (protocol 205). The row reads "Answered at …" until the viewer's identity is
loaded, and in a shared organization for an answer an older runner or control plane recorded
without a member; a single-member installation reads "you" either way. Governance decision rows
follow the same rule ("Approved by You", "Denied by Grace Hopper", "Approved by Another Member"),
and their Decided By fact names the member the same way. The answer is the content-safe
summary the control plane sends with it, which the runner records as `answers` on that request's
`question_resolved`; a dismissal records none, and an answer from an older runner or control plane
reads "Answered" with no second line. Shared transcripts exclude every question event.

**Decision Records** (#2204). A finished decision is one `DecisionRecord`
(`components/requests/DecisionRecord.tsx`), the same in the transcript and in Decision History:
resolved permissions, governance decisions and automated reviews. Pending permissions are not
records; the request dock owns them (#2179). The row is a `<details class="disclosure">` whose
summary is `--control-h` tall (44px on touch): the §5.5 chevron, a 16px outcome icon in its tone
(`CircleCheck` success, `CircleX` neutral, `ShieldX` danger, `TimerOff` warning, §18), the
`requestDecision` word in its tone, the request's title, "by" who decided, and when: how long ago
while the session runs (the transcript's live clock), otherwise the clock time like every other
transcript timestamp, with the absolute date and time as its tooltip. Who decided is "You" (relative to the viewer, #2527), a policy's
display name from the organization's policies (never "Policy · <id>"; "Policy" until the names
load; they reload once for a policy they lack and after a policy is saved), the parent session's title, the reviewer, or "Wollipog" for a fail-closed block. A permission
row names who decided from its own `permission_resolved` (#2628): the control plane sends
`resolvedBy`, the member who submitted the decision or the policy that auto-resolved it, and the
runner records it on that exact resolution (protocol 211), so each occurrence of a reused provider
request id is named by its own decider. The member reads relative to the viewer by the #2527 rules,
the policy by its name. A Parent Control decision names the parent session instead. A resolution
from an older runner or control plane, or one Wollipog made itself, names nobody rather than
guessing: the audit cannot be tied to one occurrence of a reused provider request id. The
body is a §5.4 `.facts` list, each fact once: Decided By (a parent session's title links to it),
Tool, Path, Branch, the command in a §11.7 code well, Risk for a review, and Recorded as one absolute
time with seconds. Ids (request, audit, policy, session, review) are never shown; Copy Audit ID copies
them. The chosen option's kind decides the word (`allow_*` Allowed, `reject_*` Rejected, `cancel`
Ended Early, even though the runner records a chosen Cancel as a dismissal); the runner's own
sign-in resolutions keep their words.

**Decision History** (#2213) is the side panel's list of every decision in the session: what the
person allowed, rejected, answered or dismissed (permissions, questions, workflow decisions,
guardrail and sign-in cards), read from the content-safe audit, alongside the policy and fail-closed
outcomes. The transcript keeps its own inputs, so a person's decisions, already rows there, are not
repeated. Rows are Decision Records, newest first, under §5.2 day group headers ("Today",
"Yesterday", then the date), below a full-width §10.2 segmented filter, **All**, **You** and
**Policies**, kept while the panel is open. An open row adds **Show in Transcript** before Copy
Audit ID; when the request's row is not in the loaded transcript it is `aria-disabled` with "Not in
the loaded transcript." beside it. **Load Older Decisions** is a `.btn.sm` `BusyButton` at the
list's left edge after the last row. Loading is skeleton rows at `--control-h` after 300ms, a
failed load a danger notice with **Retry**, and an empty session a compact "No Decisions Yet"
state whose action, **Approval Policies**, opens Settings › Approvals (#2158); the launcher row is
always enabled.

Facts are not statuses: "Detached Work: Untracked", "Changes Present", "Worktree", "Kept Aside" are
meta (§11.3). This table lives in code as one `statusMeta(domain, value) → {label, tone, pulse}` map;
`STATE_LABELS`, `LIFECYCLE_LABELS` and per-component label tables are deleted.

### 11.3 Meta (Neutral Facts)

- Default: plain `--type-small` `--text-dim` text with a 14px leading icon (branch, machine, agent,
  project), separated by 12px.
- Meta chip `.chip`: only when the fact is clickable or removable (a filter, a reference): 20px, 1px
  `--border`, `--radius-xs`, padding 0 8px, `--type-micro` weight 400, `--text-dim`. A clickable chip
  gets the 44px hit area on touch. Never colored. Machine and agent
  tags lose their purple and blue.
- Flag badge: a non-interactive flag next to a status ("Required" beside a Blocker or Major severity)
  is a **neutral badge**, `.status.t-neutral.no-dot`, not a chip. `.chip` stays for facts
  you can click or remove.
- IDs, hashes and paths: `--font-mono` 12px, shortened (12 characters for hashes, directory-first
  truncation for paths), with a copy button. Full ids live behind "Show Details" or copy only.

### 11.4 Counts

- Plain count: `--type-micro`, `--text-faint`, tabular, no pill (tabs, groups, segmented options).
- Count badge (needs attention): 16px pill, min-width 16px, 11px/600 tabular, `--amber` fill with `--count-warning-fg` (9.47:1 dark, 4.87:1 light); danger variant uses
  `--danger-bg` with `--danger-fg`. `--accent` and `--accent-2` never fill a count.
  One per rail item, showing the highest-severity tone and the total.
- **Rail attention (`railAttention`, #1967).** Each destination carries at most one mark, and the
  same one on the desktop rail, the phone tab bar and a More sheet row, so a reordered destination
  carries it with it:
  - Sessions: one count badge of blocked plus stalled sessions, danger when any is stalled and
    warning otherwise.
  - Connections: never a count. An 8px dot in the warning tone (`.rail-attention-dot`) while a
    machine needs the user: it is offline while a session assigned to it has work in flight, or its
    runner is outdated (Update Required). Machines that are online, idle, or offline with nothing
    running are normal and draw nothing.
  - Every other destination: nothing.
  - The phone's More tab (#2110): while any destination in its sheet has a mark, one
    `.rail-attention-dot` on its icon's shoulder, in the most severe tone among them (`t-danger`
    when a Sessions badge behind it is red, `t-warning` otherwise). Never a count: a sum would mix
    sessions with machines. Its accessible name stays "More Destinations" (or "…, <destination>
    selected"); its description names each destination behind it with its breakdown, in sheet
    order: "Sessions: 12 waiting on you, 3 stalled. Connections: 1 machine needs an update". A
    destination on the bar contributes nothing to it.

  The mark sits on the icon's shoulder in the 64px rail and on a phone tab, and inline after the
  name in the labelled rail and the More sheet. Its icon box (`.rail-icon`) is wider than the glyph,
  so neither the badge nor its ring covers the glyph's stroke; on a phone tab it is also shorter
  than the glyph, so the badge stays under the bar's clipped top edge. The ring is the item's fill:
  `--bg-elev` at rest, `--bg-elev-2` on hover, `--surface-selected` on the current item, and the
  bar's `--bg-elev` on a phone tab. The accessible name stays the destination's name; the
  breakdown in sentence case ("12 waiting on you, 3 stalled", "1 machine needs an update") is the
  item's description and the rail tooltip's second line.
- Inline by default, in the text flow of a list-foot row, a menu row or a tab. `.count-badge.on-icon`
  places it on an icon's top-right shoulder (the icon's wrapper is the positioned box), growing
  away from the icon, with 2px sides rather than 4px (one digit stays a 16px circle, two are about 17px
  wide) and a 2px ring in `--count-badge-ring`. On the 64px rail a count too wide for the room
  beside the glyph grows back over the icon box's corner instead, so the badge and its ring end at
  the rail's border and never cross it, in every tier (#2110). Grown back, its lower corner would
  reach the glyph's shoulder, so it also rises by twice the distance it grew back plus 1px, up to
  7px. A count that fits does not move. Two digits fit in most faces and rise about 3px in a wide
  one (DejaVu Sans); three digits rise the full 7px, clear of the glyph, with their ring leaving the
  item's top edge by 4px to 10px, over the gap and the empty foot of the item above. That is the
  one case where the ring leaves its item. A phone tab has room to grow away as usual. That property defaults to
  `--bg-elev`; a surface that is not `--bg-elev` (a selected rail item on `--surface-selected`)
  sets it once on an ancestor rather than redrawing the badge. Forced colors drops the ring's
  box-shadow, so there a 2px `Canvas` outline redraws it.
- Draw it with `CountBadge` (`count`, `tone: "warning" | "danger"`, `onIcon`), never by hand. The
  badge is `aria-hidden` and holds only the number; the control that shows it states the count in
  its accessible name or description.
- Zero is never shown in color ("0 Stalled" is not red): `CountBadge` renders nothing for a count
  of zero or less.

### 11.5 Keycap

`kbd`: `--font-mono` 11px, 18px tall, min-width 18px, padding 0 4px, 1px `--border-strong`,
`--radius-xs`, `--bg-elev-2`, `--text-dim`. One recipe for hints, menus and the shortcut reference:
it is the element rule, so a surface places a keycap but never sizes it or sets its font or border.
A hint's label beside it is `--type-small` in `--text-dim`. A menu item with a binding shows the
keycap in its trailing slot (§9.1).
Hidden on coarse pointers (`@media (pointer: coarse)`), never by viewport width, except in the
Keyboard Shortcuts reference, which keeps its keycaps because it is where someone with a hardware
keyboard on a touch device looks them up. Inline hints still hide there (§15.1). The Reply shortcut's
hint is a bare `R` keycap at the end of the idle, unfocused composer's placeholder row (#2166): the
placeholder is its label, and the row takes no height, so the keycap comes and goes without moving
the textarea. The transcript's floating Jump to Latest control (#2153) carries the End keycap on fine
pointers only; its tooltip names the chord.

### 11.6 Meter

`.meter`: a level against a known capacity (context window, subscription window, budget). It is the
§19.4 merge of the areas' `.meter` and the progress bar.

- 6px tall, `--radius-pill`, track `--bg-elev-3`; the fill is a child `<span>` whose width is set
  inline, in `--text-dim`. A level is not forward progress, so it is not teal (§2.2).
- `.meter.is-progress` is normal forward progress through known steps (a replacement worktree being
  created, §13.2), so its fill is `--accent` (§2.2). A label beside it names the phase and step
  ("Running Setup, Step 3 of 4"); progress is never drawn in a warning tone.
- `.meter.t-warning` and `.meter.t-danger` fill with the tone when the level needs attention. The
  context window is warning from 75% and danger from 90%, and its ring takes the same tone classes
  on `.context-control`; below 75% the ring's fill is the neutral `--text-dim` on a `--bg-elev-3`
  track.
- The element carries `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`
  and a Title Case `aria-label`.
- Replaces the context meter's bar (`.context-popover-bar`). The context control itself (the ring
  button and its popover) is `.context-control`, which is local to the composer.

### 11.7 Code Well

`.code-well`: a read-only command, build or identifier with its copy button. It is the §19.4 merge
of `.code-well` and `.copy-field`.

- `--bg` (the sunken ground), 1px `--border`, `--radius-md`, padding 4px 4px 4px 12px, the copy
  button trailing at the top.
- The value (`code` or `pre`) is `--type-small` in `--font-mono` and `--text`, and wraps anywhere:
  the whole value is what gets copied, so it is never clipped. A single-line form for one-line
  secrets and URLs (`.code-well` with the value on one line, ellipsis, and the copy button centered)
  lands with its first consumer.
- Replaces `.connection-details-code`.

### 11.8 Masked Personal Identifier

`.pid`: an email or other personal identifier, masked until the person reveals it. It is the §19.4
merge of `.pid` and `.masked-field`. `PersonalIdentifier.tsx` keeps the logic: while masked, the
value is not in the DOM.

- `.pid` is inline. The mask `.pid-mask` says what it hides: a 14px `Mail` icon and the words
  **Email Hidden** (a `Lock` icon and **Hidden** for any other `kind`) in a subtle dashed chip
  (`--border-strong`, `--radius-xs`, `--text-dim`, not selectable). The words are the accessible
  text; no part of the value — length, domain or first letter — is ever a hint.
- Revealed, `.pid-shown` keeps the same icon at the same inset around the value `.pid-value`, so the
  row moves only by the text.
- A masked value is `kind: "email"` when it is masked for being email-shaped. A value masked by
  provenance alone (`sensitive`) is **Hidden** unless the caller knows it is an email.
- The reveal control `.pid-toggle` is a square `.icon-btn.sm` (28px, a 44px hit area on touch) with
  the normal focus ring and the Eye icon; its name is "Show …" or "Hide …" and the value's label. In a
  picker's field head it is a `.btn.sm.ghost` with the Eye icon and the action as text ("Show
  Emails"). Inside a compact `.tag` the chip drops its frame and the control keeps the tag's height.
- A mask never stands alone: a visible label comes before it — the field's own label, "Account:",
  or the component's `lead` ("Account", "Person", "Claude Code reports"), which appears only when the
  value is masked, so an alias still reads as the account's configured name.
- A field label with a reveal control for the values its picker hides is `.pid-field-head`.
- Replaces `.personal-identifier`, `.personal-identifier-value`, `.personal-identifier-mask`,
  `.personal-identifier-toggle` and `.personal-identifier-field-head`.

---

## 12. Empty, Loading, Error and Offline States

One `State` component with variants; the states are **mutually exclusive** in this priority order:
**offline → loading → error → empty → no results → content**.

### 12.1 Empty (First Use)

```
 ┌──────┐
 │  ⌗   │  40px tile, --bg-elev-2, --radius-md, 24px icon in --text-dim
 └──────┘
 No Skills Yet                                  --type-title
 Skills teach an agent a repeatable task.       --type-reading, --text-dim, max 56ch
 Write one, or import from Git or a machine.
 [+ New Skill]  [Import from Git…]              primary (lg on page) + secondary
```

- Top-aligned and **left-aligned with the page grid**, `padding-top: var(--space-12)`, max-width
  480px. It spans the whole content area when the collection is empty (not squeezed into a list
  column). In a narrow panel it is left-aligned at the panel's padding.
- Title in Title Case, one or two sentences in sentence case, at least one action. The action is not a
  duplicate of the page header's primary if that is visible: the header primary is hidden while the
  empty state shows it.
- No bordered card around it, no ✓ glyph.

### 12.2 No Results

Inline in the list: `Search` icon, "No skills match “terr”." and a `.btn.sm` "Clear Search". Neutral
tone, never a success mark. Inside a picker's open list (§8.4) the row is the icon and the sentence, and an optional create row
follows it instead of Clear Search: the query lives in the field, where clearing it is one keystroke.

Sessions (#2200) replaces both panes, list and preview, with one No Matches state (§6.1): the
search-off icon (`SearchOffIcon`), the title "No Matches", "No sessions match “terraform” in Docs
Site." ("in any group" on All), then **Clear Search** (`.btn`; Escape does the same) and **Search
Transcripts** (`.btn.ghost`), which opens the command palette with the query. Built by
`SessionsNoMatches`.

### 12.3 Loading

- Under 300ms: render nothing new (keep the previous content).
- Lists: skeleton rows at the real row height and anatomy (a 60% title bar and a 40% meta bar),
  flush with the list's padding. 3–6 rows.
- Detail: skeleton title plus two section blocks.
- Buttons: inline spinner (§3.1 Busy). Spinners are never a page's only content for more than 1s.
- Status text in sentence case: "Loading sessions…". No "Showing 0 Sessions" while loading.
- **Sessions (#2220).** Before the first snapshot, and while a group's count says sessions exist and
  none has arrived, the list is `SessionsListSkeleton`: a status line, "Loading 8 sessions…" when the
  count is known, over `--row-h-2` skeleton rows (a phone's are three-line cards), as many as are
  coming between 3 and 6. The preview shows a skeleton of its bar. Never a state card in between.

### 12.4 Error

A danger Notice (§13.2) in place of the content: title "Couldn't Load Skills", one sentence in user
terms, **Retry** as the action, raw detail behind "Show Details" in mono. Render-error boundary uses
the same notice with Reload and Copy Error Details, top-left in the content area.

- **A crashed view** (`ErrorBoundary`) is titled with the destination's name, "Automations Couldn't
  Be Shown" ("This Session" inside a session), over "Part of this page failed to display. Nothing was
  changed." Its actions are **Reload Page** (primary) and **Copy Error Details**; Show Details opens a
  code well with the error message and the first three component frames, which is also what Copy
  copies. There is no Try Again: re-rendering the same data crashes the same way. The route's page
  header stays above it, and navigating elsewhere clears it.
- **A crashed shell** has no header or rail to sit under: a full-window `State`, "Wollipog Couldn't
  Show This Screen", with **Reload Wollipog**, Copy Error Details and the same details.
- **A turned-off experiment's route** is not an error: it keeps its page header, and below it an
  empty-style `State` with a flask icon, "{Name} Are Turned Off", a sentence on why it is hidden and
  what turning it on adds, **Turn On** (primary, the same switch as Settings › Experimental; the
  feature mounts in place) and Open Experimental Settings.
- Below 760px the actions of all three stack at full width and are 44px tall.

### 12.5 Offline

- A single global banner (§13.3). Per-view data states show a neutral "Reconnecting…" line with the
  last-known content dimmed, never "All Agents Unblocked", zero counts or "No … Yet".
- Copy is for users: "Can't reach Wollipog on this machine. Reconnecting…" with **Retry Now**.
  Developer hints (`pnpm dev`, origins) are shown only in a dev build, behind "Show Details".
- The banner appears only after 2s of disconnection (no cold-load flash).
- **Last-known content** under a Reconnecting line is `.is-stale` (`StaleContent`): one dimming for
  the whole block, on the content and never on the Reconnecting line itself. It is done by token
  (primary text steps down to `--text-dim`), not by `opacity`: subtree opacity multiplies into every
  color beneath it and un-certifies the contrast checks. It stays readable, scrollable and operable
  (no `aria-hidden`, no `inert`). The Sessions list uses it (#2220): on disconnect the last-known
  rows stay, wrapped in `StaleContent` under a neutral `.inbox-list-status` "Reconnecting…" line, and
  the wrapper stays mounted, so reconnecting keeps the grid, its scroll and its focus.

**An entity page before its entity loads** (Session, Run, Pod; `detailPlaceholder()`, #2202) shows one
state with a next step, in the person's terms (never "control plane"):

| State | Title | Sentence and actions |
| --- | --- | --- |
| Loading | Loading Session… | Transcript skeleton rows after 300ms; no sentence. |
| Not found | Session Not Found | "It may have been deleted, or you may not have access." **Back to Sessions**, **Search Sessions** (opens the palette; a Run or Pod offers Back only). |
| Offline | Waiting to Reconnect | "Wollipog opens this session when the connection comes back." The offline banner has Retry Now. |
| Not paired | Pair to Load Session | "This device needs to be paired before it can open sessions." The pairing banner is the next step. |
| Load error | Couldn't Load Session | One sentence, **Retry**, and the raw error behind Show Details. |

The page has one heading. On desktop the session bar keeps only Back and the state carries the `h1`
(`#page-title`; Loading's is visually hidden). On phones the top bar shows the state's title, the
state leaves its own out, and the bar has no panel toggles.

**A session's reading column** (#2172) shows one state at a time, at its top left, with no follow
control in any of them:

| State | Presentation |
| --- | --- |
| Loading | Two turn-shaped skeleton placeholders (a right-aligned bubble, a work bar, three prose lines). After 3s: "Loading a long conversation ({count} events)…" when the snapshot has a count, otherwise "Loading the conversation…". |
| Awaiting the first prompt | Compact `State` "Start the Conversation", "{Agent} is ready in {project} on {machine}." and **Browse Files** (opens the Files tab). |
| Starting | Compact `State` "Starting {Agent}" with a spinner tile. |
| Ended before any activity | Compact `State` "No Messages", "This session ended before anything was sent." No action: the session notice slot offers the way back. |
| History failed or partial | One compact danger `Notice` in a band above the transcript, which takes its own height so it never covers a row and stays in view at the tail: "Couldn't Load the Full Conversation", how much loaded and from which machine, **Retry** and Show Details (the raw error). It replaces the unavailable state when nothing loaded, and the empty state when a once-empty history fails to refresh. |
| Cached while disconnected | One neutral compact `Notice`: "Showing cached activity while disconnected." Over a once-empty history it stands alone: offline outranks empty. |

The head of a bounded window is one `.tl-earlier` row in every state: a hairline, centered content, a
hairline. Idle is a `.btn.sm.ghost` "Load Earlier Activity" with a `.count` of older events when
known; loading is a spinner and "Loading earlier activity…"; failed is a compact danger notice with
Retry. Scrolling to the top still loads automatically; the row is the fallback for people who cannot
scroll to trigger it (#313).

---

## 13. Toasts and Notices

### 13.1 Toast

```
┌───────────────────────────────────────────────┐
│ [✓] Session snoozed until tomorrow.  [Undo] [×]│  360px, padding 12, gap 12
└───────────────────────────────────────────────┘
```

- Position: toasts appear at the bottom and **never cover the app bar**.
  - Desktop: bottom right, `bottom: calc(var(--toast-clear, 0px) + 16px); right: 16px`, 360px wide.
  - Touch widths (phone): bottom center, `left: 8px; right: 8px`, just above the tab bar or the
    composer and inside the safe area:
    `bottom: calc(var(--toast-clear) + env(safe-area-inset-bottom) + 8px)`.
  - `--toast-clear` is the height of whatever is docked at the bottom of the view: the tab bar on
    phones, the composer in a session (measured), 0 elsewhere. A toast never covers Send, the tab bar
    or a dialog footer. Phones show the newest toast only.
  - The "+N More" list opens upward from the stack.
- Container recipe of a menu (`--bg-elev`, `--border-strong`, `--radius-md`, `--elev-2`). No colored
  left stripe. Tone is carried by a 16px icon in the tone color (Info, CircleCheck, TriangleAlert,
  CircleAlert).
- Message `--type-body`; optional detail line `--type-small` `--text-dim`, set in `--font-mono` for
  text the person may copy, such as a URL (`detailStyle: "mono"`), and wrapping so all of it shows.
  An optional link under it (`link`, "What's New") opens in the system browser on desktop. Title Case
  only in the action and the link ("Undo", "Retry Undo", "Open Session", "What's New").
- One `.btn.sm.ghost` action (44px coarse) and a Lucide `X` close.
- Info and success dismiss after 5s (paused on hover or focus); errors persist. Maximum 3 visible,
  newest on top; older ones collapse into "+2 More".
- Redundant toasts are removed: nothing that the UI already shows (an attached file chip, a visible
  state change) gets a toast.
- A decision is never a toast. When the desktop app holds a quit because sessions are still working,
  it asks with the Quit Wollipog confirmation (§7.4): the working sessions as detail rows, Keep Open
  (the cancel, initial focus), Show Sessions and Quit Anyway. A desktop update held for the same
  reason asks with Restart to Install Update, wherever the install started (the update toast or
  Settings › About): the working sessions as detail rows, Install Later (the cancel, initial focus)
  and Restart Anyway. Install Later leaves the update on offer in Settings › About.
- A desktop update is an info toast: "Wollipog 0.29.0 is ready to install." (or "…is available."
  when it installs from the release page), a detail line saying it can be installed later from
  Settings, a What's New link, and one action, Install and Restart or Open Release Page. Dismissing it
  is "later".
- A link the desktop app could not open says so and gives the URL instead of the shell's error: an
  error toast "Couldn't open the link in your browser." or, for a link the policy blocks, a warning
  toast "Wollipog only opens web links in your browser.", each with the URL as a mono detail line and
  Copy Link. The shell's own text goes to the console. There is no Retry: a browser that refused a link
  once usually refuses it again.

### 13.2 Notice (Inline, One Primitive for Every Banner and Callout)

```
┌─────────────────────────────────────────────────────────┐
│ [⚠] Conversation Quarantined                       [×]   │  title --type-body-strong
│     The provider rejected an item in this history.       │  body --type-body, 1–2 sentences
│     [Recover Session]  Show Details                      │  actions
└─────────────────────────────────────────────────────────┘
```

| Part | Spec |
| --- | --- |
| Tones | info (blue), warning (amber), danger (red), success (green), neutral. Tone must match the badge tone of the same state. |
| Surface | `color-mix(tone 7%, var(--bg-elev))`, 1px `color-mix(tone 32%, transparent)` (a low tint keeps amber from turning olive on slate), `--radius-md`, padding 12px 16px. No left stripe. |
| Icon | 16px tone icon at the title's first line. |
| Title | Optional, `--type-body-strong`, Title Case. |
| Title row | With a title, trailing controls (the slot's "+N More", then the dismiss button) sit in the title row only, so the body and the actions use the full width. |
| Body | `--type-body`, 1–2 sentences, sentence case. Everything else behind "Show Details" (`Notice`'s `details`): a `.btn.sm.ghost` toggle at the end of the action row that reads "Hide Details" while open; the details are not in the DOM until it opens. |
| Actions | `.btn.sm` row under the body, left-aligned; the resolving action first (primary only if it is the page's main next step). An action a person cannot take now keeps a visible reason line in the body ("Build Box is offline.", a Viewer's refusal) that the button references with `aria-describedby`, never only a `title`. |
| Compact | One line: icon + sentence + one `.btn.sm` trailing, 40px. For inline field-group and composer notices. |
| Placement | Directly where the problem is: above the composer for session state, above the footer for submit errors, at the top of a section for section state. Aligned to that column's edges. |
| Budget | **One notice slot between the transcript and the composer.** When several session conditions hold (quarantine, recovery, a queued-message error), the highest severity shows and the rest collapse into its trailing "+2 More" menu. Receipts and queued rows are not notices and do not share this slot: receipts are rows of the transcript under their message (§11.2), and queued rows belong to the composer. This is the bottom-edge counterpart of the one-bar rule for the top of the session. A pending request (the request dock below) takes this slot ahead of every notice. |

**Session notice slot.** `SessionNoticeSlot` (`apps/web/src/components/SessionNoticeSlot.tsx`) is that
slot: the first child of the composer column, on the composer's width and gutters. It takes a list of
session conditions `{ key, severity: "danger" | "warning" | "info", rank, title, render }` and shows
exactly one: the most severe, then the lowest rank.

- Ranks live in one table, `SESSION_NOTICE_RANK`: worktree missing 1, conversation quarantined 2,
  worktree setup failed 3, invalid worktree setup configuration 4, account switch failed 5, session
  archived 7, skills unavailable 8, setup suggestion 9, composer error 10, command not sent 11,
  attachment error 12, attachment note 13, editing a copy 14, attachment that couldn't be shown 15,
  queued-message delivery failure 16. A new entry adds its rank there.
- The others are a `.btn.sm.ghost` "+N More" in the shown notice's title row. It opens a menu (§9.1)
  of their tone icons and one-line titles; choosing one shows it until the set of conditions changes,
  and focus moves to the new notice's "+N More".
- `render` returns one `Notice` and passes the slot's `trailing` to it. Info conditions are
  dismissible per session (the slot passes `onDismiss`); danger and warning ones are not, except where
  the condition has its own dismissal (a failed account switch, which lets the person send with the
  session's configured account). Session Archived and Editing a Copy are the info exceptions: each
  has its own way out, so neither is dismissible.
- **Session Archived** (info, #2202): an archived session that has stopped reads "This session is
  archived and stopped." with **Unarchive and Restart** (the control plane's one preflighted
  operation) or, on an older control plane, **Unarchive**. A person the server would refuse sees it
  disabled with the reason. The composer's placeholder is "Unarchive the session to send a message."
- Every session notice above the composer is an entry of this slot: the Composer epic's composer
  errors, attachment notes and queued-message errors join it rather than building a second slot.
- **Composer entries** (#2156): what the composer couldn't do is danger, titled for the menu
  ("Message Not Sent", "Image Not Supported"), with one sentence that says what to do and the
  server's own words behind Show Details. Each has its own Dismiss, and a failed send has Retry, which
  sends the kept draft again. A failed send and an attachment that did not land are separate entries,
  so both can wait in the slot; every composer entry clears when the draft changes or the next send is
  accepted. A command that keeps the attached images for the next message is an info entry ("/review
  doesn't send images. They stay here for your next message."), dismissible like other info entries.
  Nothing renders inside the composer card or between it and the slot.
- **Composer action errors** (#2511): every other action that reports through the slot (Cancel,
  Dismiss and Retry on a pending message, Stop Turn, Rewind, Fork, Recover Session, Restart, Retry
  Setup, an @ reference, Steer and Queue Again) follows the same rule, under its own title
  ("Rewind Failed", "Fork Not Created", "Session Not Restarted"), never "Action Failed". The sentence
  opens with what failed ("Couldn't restart this session.") and ends with what to do. A cause the
  person can act on has its own sentence (the machine is offline, the turn has no checkpoint) and no
  details; anything else ends "Try again." with the server's words behind Show Details. The copy is in
  `composer-action-errors.ts`. Edit in a Fork reports in its confirmation, whose danger notice keeps
  the server's words behind Show Details the same way.
- **Unknown Command** and **Command Unavailable** (warning, #2176): a slash command the composer
  refused to send. "“/reveiw” isn't a recognized command, so nothing was sent. Did you mean /review?"
  with **Use /review** (replaces only the token), **Send as Text** (sends or steers the text as typed,
  the same as a leading `//` or `\/`) and Dismiss; without a close match the sentence ends after
  "nothing was sent." An unavailable command typed in full reads "“/stop” can't run here, so nothing
  was sent." followed by its reason, with Send as Text. The draft, its attachments and the caret
  stay; editing the draft clears the entry, and the / picker closes for that draft so the entry is in
  view. The picker shows the same state first: "“/reveiw” isn't a recognized command." with Send as
  Text and a Close Matches group in which no row is active, so Enter can't guess. A Claude Code
  session whose runner doesn't report Claude Code's built-in commands (source `builtin`, #1224) keeps
  sending an unknown token as text, because that is how those built-ins run there.
- **Editing a Copy** (info, compact, #2185): Edit as a New Turn opens no dialog. It loads the
  message's text and attachments into the composer and focuses it; over a draft it first confirms
  "Replace Draft". While the copy is there the slot reads "Editing a copy of your Turn N message.
  Earlier turns stay as they are." with **Discard Edit**, which puts back the draft it replaced (or
  clears the composer). An accepted send of the copy ends it; a send that fails leaves it. It is kept
  with the draft, so leaving the session or reloading keeps Discard Edit; while a queued message is
  being edited it waits, since that edit owns the composer.
- **Queued-message delivery failure** (#2178): a queued message whose delivery failed is a danger
  entry, "Message Not Delivered": "“<first words>” wasn't delivered. <reason>", with Dismiss
  (named "Dismiss Failed Message"), the same request as the row's own Dismiss. Delivery that could
  not be confirmed is the warning "Delivery Uncertain". The row keeps its badge and its Dismiss; a
  failed message still cannot be edited or resent.
- **Drop target** (#2156): files dragged over the composer turn the card's own edge dashed
  `--text-dim` and change only the bar row, to "Drop to attach 2 images"; the draft and its
  attachments stay in view. A model without image input refuses the drop in the same row, with the
  image-off icon and the one sentence the notice and the + menu's Attach Image row also use: "<model>
  can't read images. Choose another model in Model Settings to attach them."
- A session notice says whether this session can take its next turn. A campaign notice describes an
  Orchestrator campaign instead: Campaign Continuation (the delivery of the campaign's durable events
  to the Orchestrator) and Held Children (the roster of child sessions that cannot start their next
  turn). They are not entries of this slot, and a new notice about the campaign follows the same
  rule. They sit directly under the session bar of the Orchestrator's session, Campaign Continuation
  first and then Held Children, and never collapse into "+N More". The reasons: Held Children lists
  other sessions, each with its own hold and recovery action, which one `Notice` body cannot hold;
  Campaign Continuation's pending, running and held states are neutral progress, a tone the slot does
  not have; and a failed continuation whose automatic retries have stopped needs a person, so it must
  not wait behind a danger condition's "+N More".
- **Campaign notices** (#2157) are `Notice`s in `.campaign-notices`, the head of the chat column, on
  the composer's width and gutters. Campaign Continuation speaks plainly by state: a missing result
  is the warning "Update Result Missing" ("The Orchestrator accepted an update but never reported a
  result. It won't be sent again automatically.") with **Acknowledge**; a failure whose automatic
  retries stopped is the danger "Couldn't Resume the Orchestrator" ("Automatic retries stopped. Retry
  when the problem is fixed.") with **Retry Now**. A failure Wollipog still retries is a compact
  warning, "Couldn't resume the Orchestrator. Wollipog will try again."; pending, running and held are
  compact neutral lines ("Catching up on 3 updates before the Orchestrator continues.", "The
  Orchestrator is working through 3 updates.", "Updates are kept until the current hold clears.").
  Pending Updates, Attempt and Error (in a code well, §11.7) are `.facts` behind Show Details. Both
  actions are `BusyButton`s, and a person who may not act reads the refusal as a body line. Held
  Children is a neutral notice with the `CirclePause` icon and a count badge in its title: the
  summary sentence, then a focusable list capped at 280px (220px on phones) that scrolls. Each child
  is its session link, followed by one `.facts` list per hold (Hold, Reason, Recovery Action with its
  backtick spans as code, Held Decision Resumes); on phones each label stacks over its value. As with
  the request dock, the transcript keeps at least half the column: the band takes at most 50%, Held
  Children's list gives up height first (to 96px, the list never more than 40% of the window), the
  notice then scrolls inside its own edge down to 10rem (12rem on phones), and only past that does
  the band scroll.
- A condition nothing waits on is info, compact and dismissible: skills that a container or cloud
  session cannot use (the dismissal is kept per session on the device, and the Pinned Summary keeps
  a Skills: Not Available row) and the Project setup suggestion (dismissed for the Project on the
  server). A suggestion about a Project rather than one session also shows once above that
  Project's Sessions tab, never inside a list row.
- Below 760px the action row is one row: the resolving action fills it (the one exception to "buttons
  never stretch", §3.1) and a disclosure toggle such as Show Details keeps its own width.

Replaces `.quarantine-banner`, `.skills-unavailable-notice`, `.worktree-setup-notice`,
`.campaign-continuation-notice`, `.campaign-held-children`, `.box-hint`, `.composer-error`, `.composer-attachment-notice`,
`.queued-error`, `.form-error` (when used as a banner), `.settings-inline-error`, `.skills-git-held`
and `PendingSetting`.

**Request dock.** Pending permission requests and questions dock directly above the composer, in the
notice slot, in attention priority order. The dock is the only amber surface for a request, and it
follows these rules so it never crowds out the conversation it asks about:

- **The transcript keeps at least half.** The dock caps at 40% of the chat column (the space between
  the session bar and the composer) on desktop and 50% on phones, and at 40% while the software
  keyboard is open. The card's head, title and footer stay fixed; only its body scrolls (a question
  card may scroll as a whole under its footer instead, below).
- **Only the top request is expanded.** The others wait behind one "+N More Requests" row that opens
  into one-line rows (kind icon, title, owner, time; owner hidden on phones). Choosing a row brings
  that request to the top for this view; the priority order is unchanged. A and D act on the
  expanded request; a decision brings up the next one.
- **In the Sessions preview** (#2210), which has no composer, the dock heads the preview directly
  under the meta line, so Approve and Deny are under the cursor that selected the row, and A and D
  act on it while focus stays in the list. It caps at half the preview with its body scrolling, and
  never shrinks to the reading-back strip: there are no rows under it to give height back to. A
  question is not answered in the preview: its card shows the question and **Answer in Session**
  (Enter keycap), which opens the session with the question docked.
- **The Request Card** (`components/requests/RequestCard.tsx`, #2179) is the dock's card and the
  Requests and Agents panels' card for a child's or a worker's request. Head line: the kind's 16px
  icon and label (`requestKindMeta()`: Permission, Budget, Tool Calls, Workflow Decision, UI Evidence,
  Sign-In, Question), the owner and the time. Then the title in `--type-section`, a policy ask's
  "Asked by <policy>" and "Rejects automatically in 9:42", and the body: the command in a code well
  (§11.7) and the match context as facts (§5.4). The footer is `requestCardActions()`: `reject_*`
  options as secondaries, `allow_always` and every other option in a ⋯ menu with its description as
  the item's second line, and the first `allow_once` as the one primary, last; a request with no
  `allow_once` has no primary. A reason nobody can act (the runner is offline, a Viewer's refusal, a
  machine-owner-only sign-in) is a visible foot-note the disabled buttons reference; a failed
  decision is a compact danger notice above the footer. The dock is the notice slot's `lead`
  (`SessionNoticeSlot`), at the end of the `.chat-reading` column, a size container its caps are
  measured against. A worker's request stays in the Agents panel.
  In a panel's detail (`presentation="panel"`, #2206) the card is flush on the panel, with no wash or
  frame, its title in `--type-title`, and its footer stuck to the panel's lower edge above a
  `--border` hairline; questions, permissions, workflow decisions and evidence all use it. A request
  the Orchestrator handles is the same card, read-only (`readOnlyNotice`): a neutral compact notice,
  "The Orchestrator is handling this request.", then its facts, and no footer.
- **A question is the same card, one question per step** (`SessionQuestionBanner` with
  `QuestionStep`, #2196). The head line is the kind ("Question", "Async Question", or "Recovery
  Required" in the danger tone after a provider restart), owner and time; then the question's header
  with "Choose one", "Choose any" or "Optional" as 12px dim text, the question as the title, its
  context, and its options as ChoiceRows (§8.4) whose last row is **Something Else…**, which opens a
  text field in the step. Each description is one line; the chosen row shows all of it. The footer is
  Dismiss (ghost) at the far left, "Question 2 of 3" with step dots when there are several, Back from
  step 2, and Next or **Submit Answers** as the one primary, last; on a narrow card the step count
  takes its own row above the buttons. Nothing is marked before Next or Submit Answers: then the
  unanswered question shows a field error (§8.5) and takes focus. A failed submission is a compact
  danger notice above the footer, the answers stay and the primary reads **Try Again**. The step is
  kept with the request's draft, so a card that remounts returns to the same question. While focus
  is in the card, 1–9 pick rows, Enter moves on, Ctrl/Cmd+Enter submits from any step and D
  dismisses; their keycaps show on fine pointers only. In Composer Response (#2212) the question
  is shown once: while it waits the docked card is compact (head line, title, the foot-note "Your
  message draft is kept while you answer." and a footer of Dismiss and **Answer**, the primary, with
  an R keycap on fine pointers), and while it is answered the dock leaves it out and the composer
  holds it (Answer Mode, below). A person who may not answer reads the refusal as the foot-note and
  Answer is disabled with it as its description. Where no composer can answer the question (a
  worker's or a child's, in a panel) the card is the form in either style, and the Sessions preview
  keeps its own question card (#2210). A long question never scrolls on its own (#2683): it
  ends on a whole line with an ellipsis, five lines or three on a phone, and a `.link` **Show Full
  Question** under it (`aria-expanded`, controlling the title) shows it whole; **Show Less** clamps
  it again, and neither touches the answers or the step. The toggle shows only when the clamp hides
  something, and gives way with the head line while the software keyboard is open. In a capped card
  (the dock, the Agents panel), an expanded question, or a card that would leave its body less than
  about a row, scrolls as a whole under a footer that stays at its bottom edge, inside the cap.
  While content is under the footer or above the top padding, that edge shows a `--border`
  hairline, as a sticky header does (§2.6), so answers under the footer read as more to come
  (#2698); neither line takes room.
- **UI evidence is a grid of named tiles** (`components/requests/EvidenceReview.tsx`, #2197). The
  card's title says what to do ("Review 4 screenshots before approving") unless the request has a
  title of its own. The body is, top to bottom: the HTTPS or Localhost Required notice (warning,
  `LockKeyhole`; once per card, only on a page that cannot check digests and only when an item is an
  artifact it could show), a compact danger notice "Deny this request and ask for a new capture."
  whenever an item can't be reviewed, `.ev-progress` ("1 of 4 reviewed", a polite status), the
  `.ev-grid` (`repeat(auto-fill, minmax(150px, 1fr))`; a strip of four tiles in the dock, at most
  160px each on a phone, while a dock body 780px or wider sets each tile's 104px frame beside its
  words so a four-item review fits under the dock's cap with nothing scrolled away), then one row
  holding the `.ev-checked` caption (`CircleCheck` in green, once any artifact is shown) and Show
  Details (§5.5), which takes its own line when opened, with the resource key, digest, who decides and, for a human fallback, why. A tile
  is its 16:10 frame with the Reviewed mark on the picture's corner, its name by media type
  ("Screenshot 2", "Recording", "Link"; numbered only when the request has several), the capture's
  pixel size once shown, and the evidence id in mono, which ellipsizes; the name wraps and never
  truncates. An artifact tile that is still loading has no mark yet. Activating a shown tile opens
  the Evidence Viewer on it (below). In a frame under 120px on a touch screen the mark's 44px target
  grows out past the frame's corner rather than over the picture, so a tap on the tile's middle
  opens the viewer. A tile
  that can't show its evidence is `.ev-blocked` in place of the picture: `ShieldX` "Doesn't Match",
  `CircleAlert` "Can't Load" (with Retry when trying again can help) or "Can't Show", in danger
  ink; `LockKeyhole` "Not Shown" in neutral ink on a plain-HTTP page. A blocked tile has no mark,
  no link and no viewer target. A link-only item has `a.btn.sm` **Open Link**, and its mark stays
  disabled until that link was opened in this browser (kept per occurrence, like the marks). The
  footer's foot-note always says why Approve is off: "Review 3 more to approve.", "Can't approve
  until every item can be reviewed." or "Approve needs HTTPS or localhost. Deny works from here."
  Small buttons in a tile borrow only height for their 44px touch target, so the strip never
  scrolls sideways.
- **The Evidence Viewer is where evidence is reviewed** (`EvidenceViewer` in
  `components/EvidenceArtifactView.tsx`, #2207): a `Modal` with `size="full"` (§7.1), a full-height
  sheet with a back arrow on phones (§7.5). Its title is the item's name and how many of its kind
  there are ("Screenshot 2 of 4"; the bare name when it is the only one), with the capture's pixel
  size and the evidence id in mono as the description. The picture fills what the header,
  filmstrip and footer leave. Under it, `.ev-strip` holds a 72×45 thumbnail for every viewable item
  in grid order, the current one selected in accent and each reviewed one with a check chip; a
  thumbnail jumps to its item. Previous and Next, and ← and → outside a player or field, move
  through the same items; blocked, Not Shown and link-only items are never in it, and an item that
  fails while shown closes the viewer so its tile can say why. The footer's left slot holds the
  **Reviewed** checkbox and the foot-note ("2 of 4 reviewed"), then Previous, Next and **Mark
  Reviewed and Next**, the primary, which marks the item and moves on, or closes on the last.
  Opening focuses the primary; closing returns focus to the tile of the item last shown. Marks are
  the grid's own, so its progress and saved draft follow them. While the viewer is open every
  artifact loads, not only those near the viewport. On a phone, Previous and Next are 48px squares
  named by hidden words, and the primary takes the rest of their row, under a row with the checkbox
  and foot-note.
  A recording plays in the viewer with its controls.
- **A sign-in states facts and offers one primary** (`signInCardActions()`, #2198). Its kind icon is
  `KeyRound`. The body is `.facts`: This Session Uses (the configured account, masked, or Machine
  Default Sign-In, with its help beside it), Signed In Now (the provider-reported account, masked,
  with Show Email) and Last Checked (a relative time with a `.btn.sm.ghost` Check Again that runs the
  runner's recheck), then one sentence naming the situation and what the primary does, never claiming
  a mismatch Signed In Now cannot show; the runner's guidance waits behind Request Details, and a body
  cut by the dock's cap fades its lower edge. The primary is Use Current Account or Start Sign-In, and
  Recheck Authentication only when the runner offers neither (then Check Again is hidden). Dismiss
  Recovery is a ghost tertiary at the footer's far left, and Choose Another Account… is the
  secondary when the session can switch accounts; below 760px, where the two and the primary do not
  fit one row, both overflow into ⋯ (§3.1) so the footer stays one row. Choose Another Account…
  opens `ChooseAccountDialog` (#2208, a sheet on phones): "Continue this session with another
  <Provider> account on <machine>.", an Accounts head with Show Emails, the Machine's other accounts
  as the shared account rows, each with its state as an inline provider-account badge (§11.2), and
  Cancel and Use Account, whose label follows the chosen row: Use Account for Signed In, Check and
  Use for Status Unknown; a Sign-In Required choice leaves it disabled, described by a footer reason
  that says the account must be signed in first. A signed-out row has Sign In as its row action for
  someone who may start one, or else says who can. A refused choice is a field error in that row,
  worded from the refusal's code and never in the runner's words, and focus moves to the row; after
  Cancel the card keeps it as a one-line danger notice. The card's notices head its scrolling body,
  so the facts under them keep the body's room. An account removed from the Machine while the dialog is open leaves the list with one
  compact neutral `UserX` notice naming it, masked ("<label> was removed from <machine>, so it's no
  longer listed."), and clears the choice if it was chosen. A conversation that cannot continue
  under any account (`not_resumable`) closes the dialog and leaves a compact danger notice with
  `Ban` on the card, and Choose Another Account… leaves that request's footer. With no other account
  the dialog is the compact No Other Accounts state with Open Connections. While a sign-in
  runs, Cancel Sign-In is the only button, the sentence carries the sign-in's status, and the runner's
  sign-in renders in the body without repeating the account, so Open Provider Sign-In and the code
  field are in view. An agent
  with several sign-in methods lists them as ChoiceRows with their descriptions visible and one
  Start Sign-In. A machine-owner-only Start Sign-In is disabled with its reason as the card's
  foot-note. No control in the card has a `title`: every name is visible or is its accessible name.
- **Reading back shrinks it to a strip.** While the reader scrolls up away from the live tail (the
  follow-tail state is paused), the dock becomes one 44px `.dock-strip` on the card's warning
  surface: kind icon, the expanded request's title, its position ("1 of 3") and Expand, icon-only
  below 760px with the name "Expand Request". Returning to the tail restores the card without moving
  focus; activating the strip or Expand restores it and moves focus to the card's heading, and it stays
  expanded until the reader is back at the tail. A and D do nothing while the strip shows. A new
  request updates the strip's title and count and is announced once. The request never disappears,
  and the height the dock gives back goes to the transcript without moving its reading anchor: the
  strip waits until the reader is at least that height above the tail, so nothing clamps the rows.
- **The question and its context link both ways** (#2205). A pending question lives only in the
  dock; its transcript row is a compact neutral marker where it was asked (`AskMarker`: a 16px amber
  `MessageCircleQuestion`, "Question · title", and a ghost `.btn.sm` Jump to Question), which becomes
  the answered question row in the same place. The card head has Show Where Asked (Lucide `Locate`)
  after the time, which scrolls the transcript so the marker sits in the upper third, gives the marker
  the selected wash until the reader next scrolls, and pauses following, so the dock takes its strip
  as reading back does. A marker older than the loaded transcript is loaded back to first; when it
  can't be found, Show Where Asked is disabled with "This question's place in the transcript isn't
  loaded." as its foot-note. Jump to Question restores the dock (or the answer panel), expands the
  question if another request is expanded, and moves focus to its heading.
- **The software keyboard leaves the question and its answer.** While it is open the question card
  drops its head line, its title takes one line, and its footer keeps only Back and Next or Submit
  Answers; a field that takes focus is scrolled into view within the card's body, never the page.
- **Answer Mode is the composer answering a question** (`ComposerQuestionResponse`, #2212). The
  `.answer-head` holds the kind ("Question"), "Question 2 of 3" only when there are several, a
  ghost `.btn.sm` Show Context (Lucide `ChevronsDown`) and an `.icon-btn.sm` × named "Exit Answer
  Mode" (28px, a 44px target on touch); there is no mode eyebrow and no exit bar. Then the question,
  its context, its options as the card's ChoiceRows in `.answer-options` numbered 1–9 (capped at
  288px, 188px below 760px, scrolling past that), and the answer field: the composer's own, in
  `--type-reading` with a placeholder that says what to type and no edge or ring of its own. The
  composer card's edge is its focus, and an invalid answer turns that edge `--red` with one field
  error under the field (§8.5); a failed submission is a compact danger notice above it. The footer
  is Back from question 2 and Next or **Submit Answers** as a BusyButton. Escape exits; no sentence
  names a key.
- **Answer Mode has Show Context.** Show Context shrinks the panel to its head: the question on one
  line, a summary of the answer so far ("Nothing chosen yet" when empty, a polite live line) and
  Show Answer (`ChevronsUp`). Nothing resets: selections, draft and step are kept in the
  request-keyed draft the card shares. A number key opens the panel before it chooses, and Jump to
  Question opens it and focuses its field. Below 760px Show Context, Show Where Asked and Jump to
  Question are icon buttons with the same accessible names.

### 13.3 Page Banner

A Notice variant spanning the top of the main area (under the rail's top, above the page header):
36px, no radius, no side borders, bottom hairline in the tone. For offline and pairing states only.
It pushes content down with a `--dur-base` height transition. A held desktop update is a decision,
so it is the Restart to Install Update confirmation (§13.1), never a banner or a notice.

---

## 14. Tables

- Use a table only when rows are compared across 3+ columns. Otherwise use rows (§5.2).
- Header: 32px, `--type-label` (12/500) in `--text-dim`, Title Case, no uppercase, bottom hairline.
  Sortable columns show a 14px sort chevron on hover and when sorted.
- Rows: `--row-h` (40px), `--type-body`, hairline dividers, no vertical lines, no zebra. Hover
  `--bg-elev-2`; selected as §5.2.
- Alignment: text left, numbers, costs and durations right with tabular numerals; status column uses
  the inline badge.
- `table-layout: fixed` with declared column widths; cells truncate with ellipsis
  (`overflow-wrap: anywhere` is never inherited by cells). The name column takes the remaining width.
- The first column is the row's name and is the open target (the whole row is clickable).
- Actions column: last, right-aligned, one inline `.btn.sm.ghost` plus `.icon-btn.sm` ⋯. No
  wrapping, no 2–4 text buttons.
- Totals row: `--type-body-strong`, top hairline in `--border-strong`.
- Sortable headers are buttons; on touch the header row is 44px tall.
- Wide tables sit in a scroll wrapper with a right edge fade; the name column is sticky.
- **Phone (and containers under 560px): tables become two-line rows**: name + status on line 1, the
  two most important other columns as meta on line 2, the rest in the detail. No 620–980px min-widths.
- **Compact tier (761–1099px): a table whose declared widths exceed the tier folds its secondary
  columns into the name cell** as a meta line under the name, and hides those columns, so it never
  scrolls sideways and the name keeps about 150px at 761px. The meta line wraps between values
  rather than truncating, so every value stays on screen. Archived Sessions does this for Project,
  Location and Agent, and narrows State to 188px, room for its longest badge, so its badges stack
  (§15.2).
- **The fold ends where the full layout fits, not at the tier's edge.** A folding table answers to
  the main column (`@container app`, §2.10), not the viewport, and keeps its fold until the column
  holds its declared widths plus 200px for the name, its wrapper's borders and the page gutters.
  Archived Sessions' six declared columns need 970px, so it folds below a 1220px column: up to a
  1283px window with the icon rail and a 1427px window with the labelled rail (#2114).
  `tokens.test.ts` derives that edge from the declared widths.

---

## 15. Mobile and Compact Adaptation

### 15.1 Phone (≤ 760px)

| Element | Phone behavior |
| --- | --- |
| Rail | Bottom tab bar, 56px + safe area, **labeled** (24px icon + 11px label). Default slots: Sessions, Projects, Connections, Automations, More. Experimental destinations never take a primary slot by default. Active: accent icon and label plus a tinted pill behind the icon (not a bar below it). `phoneBarViews()` in `rail-preferences.ts` is the one source for the slots: an optional per-instance `phoneBar` list replaces the default, and a hidden or turned-off slot is filled in place by the next visible non-experimental destination in rail order. From 600px the tabs keep a 480px centered measure. |
| More | A real bottom sheet with a scrim and a "More" title; rows 48px with icons; Settings last after a separator. It holds every other visible destination in rail order. A tap opens it focused on the sheet itself, with no ring; closing it hands focus back to More only from the keyboard (Escape, or Enter on a row). At 420px tall and below the rows form two columns, so every row fits a 568×320 screen. While a destination in the sheet needs the user, the More tab carries one mark for them all (§11.4). |
| App bar | 48px: ‹ Back (on detail routes) or nothing, title 16/600 (truncates), trailing icons (search, primary `+`, ⋯). Icons are 36px visual with 44px hit areas, as in the settled phone session header. No page description. |
| Page header actions | Primary as `+` icon (accessible name "New Skill"), all others in ⋯ sheet. |
| Master-detail | Two routes (§6.2). |
| Dialogs, menus, popovers | Bottom sheets (§7.5, §9.2), each with the 36px grabber. |
| Selects and comboboxes | An anchored list beside the field, fitted to the viewport, not a sheet (§9.1). |
| Tables | Rows (§14). |
| Toolbars and filters | One row: search field + a "Filters" button that opens a sheet with the filters and a result count. Native selects that size to their longest option are removed. |
| Tabs | Scroll with fade and active-into-view; more than 4 become a view picker. |
| Sessions app bar | One 48px bar (`SessionsAppBar`, #2211) replaces the page header, its action row and the group tabs, so the first row starts 56px down. The title is the group picker: the group's name, a caret and its attention count badges (none in Snoozed), named with the attention in words; it opens the Session Groups sheet of §10.1's All Groups rows. Then Search, which swaps the bar for the full-width search field (focused) and Cancel, which clears the query and restores the bar; it filters the list as §8.4's field does and never opens the palette. Then ⋯, a sheet with View (List, Board) and Show (Active Sessions, Snoozed Sessions with its count) as radio items, New Project…, and the current project's actions under a section label with its name; and the 44px `+` New Session. In Board mode, Filters follows Search (see Board below). While Snoozed is on, a strip under the bar says "Showing snoozed sessions." with Show Active. A confirmation opened from a sheet replaces it with Back (§7.5). |
| Board | One column at a time (#2216). Under the app bar, the column tabs (§10.1) in the order Needs Input, Running, Review, Done, Queued, each with its plain count, Needs Input's a warning count badge while above zero; each tab is named "Running, 13" and is at least 44px wide. The row scrolls with the edge fade when the tabs do not fit. Below it, the chosen column's cards run the width inside the gutter and scroll on their own; an empty column says "No sessions are in Done." The Board opens on the first column with a card in that order and keeps its column, the opening one or the one chosen, while it stays open: a live update never moves it. Each tab is also a drop target for a card dragged with a mouse. The app bar's **Filters** (`FilterIcon`, `.icon-btn`) follows Search: named "Filters" or "Filters, 1 Active", `aria-pressed` and showing the plain number applied while any filter is set. It opens the Filters sheet: the result count ("Showing 10 of 29", which also describes the sheet), the Machine group and the Agent group of §10.1's rows (44px on touch), then Clear Filters after a separator while any is set. A choice applies at once and the sheet stays open, so the count answers it; the scrim, Escape or Tab closes it. While a filter is set, a strip under the Snoozed strip says what is filtered and how many remain ("Machine: Studio Mac. Agent: Codex. Showing 3 of 29.", a long name ending in an ellipsis, the count never) with **Clear Filters**, which hands focus to Filters. |
| Toasts | Bottom center above the tab bar or composer, inside the safe area; one visible (§13.1). |
| Request dock | Caps at 50% of the chat column, 40% while the software keyboard is open; its body scrolls, and it shrinks to the 44px strip while reading back (§13.2). |
| Keyboard hints | Hidden (`pointer: coarse`). |
| Live usage | The composer bar seats the context ring and the session cost before the mic as two borderless ghost `ComposerButton` triggers (§3.1, #2174), `--composer-ctl` tall, in `--type-small` and `--text-dim`, each opening its popover. Below 760px, or in a composer column narrower than 40rem (640px at the default text size) at any width, they leave the bar so it never wraps, and Model Settings opens with a Session Usage group at the top: Context Window (ring, percentage and "72K of 200K") and Session Cost. Each is a row named by its label that opens its trigger's breakdown in Model Settings' place, as a dialog pushes onto a sheet (§7.5): the title row names the breakdown and gains Back, Escape returns to the choices with focus on the row, and the next Escape closes Model Settings (#2447). Where Model Settings cannot open (an agent with nothing to configure, or a person who may not change it), they take their own right-aligned row above the bar instead, hidden while a phone composer is collapsed. Answer Mode, which replaces the bar, carries the two triggers beside Submit, or on their own row above its buttons in a narrow column. A session with no usage yet shows neither (#2166). |
| Dictation | The mic is a ghost square `ComposerButton`, named "Dictate", with a 44px hit area on touch like every bar control. A tap starts dictation and the next tap stops it; a press held 400ms or longer is push-to-talk and stops on release; Enter or Space on the focused mic toggles it, and Escape in the composer or Send ends it. While it listens the mic wears the pressed toggle (§3.1) and is named "Stop Dictating", and the bar's left group becomes a `role="status"` strip: an 8px `--red` dot (still under reduced motion), "Listening…", an mm:ss timer, words not yet final in `--text-faint`, and "Tap the mic to stop" ("Release to stop" while held). The hint outranks the unsettled words: in a strip narrower than 20rem (a phone) the words stay out, and below 15rem the hint does too. The mic is disabled with the composer (#2154), and a composer that becomes blocked stops listening (#2193). |
| Fixed bottom layers | Every bottom-anchored surface (right panel sheet, shell dock, composer) follows the same `:has(textarea:focus)` rule as the rail so nothing shows through. |
| Gutter | `--page-gutter: 16px`. Centered columns use `max(var(--space-3), (100% - max) / 2)` so content never touches the screen edge. |

### 15.2 Compact Desktop (761–1099px, Including the Tauri 940px Minimum)

- Rail unchanged, including the opt-in labelled rail. Page header: primary + one secondary + ⋯.
- Short windows with a mouse (`(max-height: 700px) and (pointer: fine)`, at any desktop width): the
  rail tightens to 36px items 2px apart, with 4px either side of a group hairline, so Search, every
  destination, the brand or instance tile and Settings fit at the desktop app's 600px minimum
  height. It does this by redefining `--control-h-lg` on the rail. Touch keeps 48px items (§15.3).
- Master-detail list pane 280px. Sessions is always stacked here (§6.3); its Preview Right option
  applies at 1100px and wider.
- Page content follows the tier too (#2106). The Archived Sessions table folds Project, Location and
  Agent into its Session cell (§14), and keeps that fold above the tier until the main column fits
  the full layout. The Usage API card's description takes the line and its three segmented
  controls follow as one group: beside the description while it keeps 220px (about 30 characters),
  otherwise together on their own line below it. The Pod Orchestration Controls keep their five
  fields on one row; each column is at least as wide as its label on one line, and Arbitration as
  wide as its longest mode.
- Session and detail bars: the status badge collapses to a dot + label only if it fits, else a dot
  with the label in its tooltip, keeping the session bar's `+N`; the project crumb is dropped;
  text buttons become icon buttons with tooltips. `DetailBar` (Run, Pod, Project) does this now. Its
  badge becomes a dot, with the label in the tooltip, when keeping the full badge would leave the
  truncated title under 200px (`DETAIL_TITLE_READABLE_PX`). A `primary` or `secondary` that carries
  an `icon` becomes a square icon button whose label is its tooltip and accessible name. The session
  bar (#2146) hides its project button and separator here, and Open <Project> and Move to Another
  Project… lead More Actions above a separator instead, as they do on phones. Its Session Status
  badge is drawn as its dot and label, and becomes the dot alone, with the label in its tooltip,
  when keeping the label would leave the truncated title under `DETAIL_TITLE_READABLE_PX`, measured
  as `DetailBar` does. At 1100px and wider it is always the full badge.
- Right panel docks at 320px or overlays as a sheet from the right with a scrim when the chat column
  would drop below 480px.

### 15.3 Touch on Any Width

`@media (pointer: coarse)` applies the control and row sizes in §2.8 regardless of width (tablets at
834px get 44px targets). Hover styles are wrapped in `@media (hover: hover)`.

The browser's tap highlight is off on the phone tab bar and the More sheet (its rows, Close and
scrim), and nowhere else (#2084). Chromium paints it above every layer, so a tap on More left a
translucent rectangle over the sheet it had just opened. A tab gives its own feedback instead: the
current tab's pill and `aria-current`, and a pressed tab on a coarse pointer fills its pill with
`--bg-elev-2`, as hover does for a mouse. Every other control keeps the browser's highlight, which
is its only tap feedback until it draws a pressed state of its own; turning it off is a decision
per control, not a global reset. Focus rings are unaffected (§16.1).

---

## 16. Focus, Keyboard and Motion

### 16.1 Focus

```css
:where(:focus-visible) { outline: var(--focus-width) solid var(--focus); outline-offset: var(--focus-offset); }
:where([tabindex="-1"]):focus { outline: none; }            /* page title, dialog card, panes */
.clip-focus :focus-visible { outline-offset: calc(-1 * var(--focus-width)); }  /* inside overflow:hidden */
input:focus-visible, textarea:focus-visible, .select-trigger:focus-visible {
  outline: none; border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus);
}
```

- The ring is neutral (`--text`, or a neutral pushed past it in One Dark and Dracula's dark theme,
  §21 item 8), not teal, so focus is never confused with selection.
- `:where()` keeps the global rule at zero specificity so components that draw their own focus do
  not get two rings (composer, search fields).
- Programmatic focus targets (`#page-title`, `.modal`, `.detail-scroll`) never show a ring.
- Controls inside `overflow: hidden` containers use the inset ring (`.clip-focus`).
- F6 zones exist on every page (rail, list, main). The zone indicator is a 2px `--focus` line on the
  zone's top edge, shown for 1.5s after F6 only, never after a click or route change. F6 into the
  rail lands on the current destination, not the logo.

### 16.2 Keyboard

- Every interactive element is reachable; row lists use roving tabindex with arrow keys.
- Shortcuts shown in menus and tooltips use the keycap recipe (§11.5), fine pointers only.
- Escape closes the top-most layer only (popover → menu → dialog → selection), consumed at each layer.
- Closing a menu, popover or dialog returns focus to the control that opened it.
- Controls inside a focus-holding region (the composer, the side-chat composer, the terminal search)
  call `preventDefault` on `pointerdown`, so a tap acts on the first press instead of first blurring
  the textarea and reflowing the region.

### 16.3 Motion

See §2.9. Reduced motion is honored everywhere, including sheets (fade only) and the Running pulse.

---

## 17. Copy Rules

### 17.1 Casing

The casing rules follow `AGENTS.md`.

**Title Case** (standard title casing: capitalize first, last and principal words; keep short
articles, coordinating conjunctions and prepositions lowercase unless first or last; phrasal-verb
particles are capitalized: "Set Up", "Sign In", "Log Out"):

- Buttons, links styled as actions, menu items, tabs, segmented options, navigation items.
- Page, dialog, section, fieldset and card titles; field labels; table headers; list-group labels.
- Badges and status labels; definition terms.
- Accessible names of controls, matching the visible label exactly. Icon-only controls use Title
  Case names ("Close", "More Actions", "New Skill").

**Sentence case**:

- Descriptions, helper text, placeholders, empty-state and error sentences, notices' bodies,
  toasts' messages, tooltips, confirmation bodies, validation messages.
- Checkbox consent labels, which read as sentences ("Open the session after creating it",
  "I understand this deletes 3 assignments").
- Loading and status messages ("Loading sessions…", "No skills match “terr”.").

Never use CSS `text-transform` to achieve either. Enum values pass through `statusMeta` or a
`labelFor()` formatter; `titleCaseLabel` must preserve acronyms (HTML, PR, SSH, URL, ID, MCP, CLI, UI).

### 17.2 Words

- One name per destination (§4.1) and one verb per action across trigger, dialog title, confirm
  button and toast: Archive → "Archive Session" → "Archive Session" → "Session archived".
- Trailing ellipsis in a label only when the action opens a dialog, menu or sheet that needs more
  input before anything happens ("Import from Git…", "Rename…"). Navigation never has an ellipsis.
- User nouns, not system nouns: "machine" (lowercase in prose), "sign in", "changes", "background
  work". Retire: control plane (use "Wollipog"), runtime capacity, durable, snapshot, projection,
  runner protocol numbers, reminder parser, `pnpm dev`.
- No raw ids, enums, MIME types, provider option ids, hashes or env var names in headline slots.
- Errors say what happened and what to do. They do not apologise and do not show raw exceptions
  (those go behind "Show Details").
- Explanations are one sentence at most in the UI; longer policy text moves behind an "About…"
  disclosure or a Learn More link.
- Locale: US English spelling ("Color", "Behavior").
- Relative times in sentence case: "4m ago" (never "4m Ago").

---

## 18. Icons

- Lucide only, through `Icons.tsx`, stroke 1.8, outline. Sizes 14, 16, 20 (24 for empty-state tiles
  and the phone tab bar). An icon inherits `currentColor`.
- Remove every emoji and text glyph used as an icon: `× ✕ ✓ ⚠ ▸ ▾ ↻ ← → ▤ ❞ △ ◐ ○ 📁 📄 📎 🔐 ❓ 🛡️ ⚖️
  💰 📅 🧰 🔑 📖 ✏️ 🔎 ⚡ 🌐 🔧 💭 ⑃ ✎ ◒ ↯ ↳ ⓘ`. Map: close `X`, check `Check`, warning
  `TriangleAlert`, error `CircleAlert`, disclosure `ChevronRight` (rotates to down), back
  `ChevronLeft`, refresh `RefreshCw`, folder `Folder`, file `File`, attach `Paperclip`, info `Info`,
  permission `Shield`, question `MessageCircleQuestion`.
- Disclosure has one look: a 14px `ChevronRight` that rotates 90° when open. The right chevron alone
  means "navigate"; a disclosure chevron sits at the leading edge.
- One glyph per meaning; duplicate aliases (`WarningIcon`/`WarningTriangleIcon`,
  `GearIcon`/`SettingsIcon`, Automations and Service Tier both `Zap`) are removed.
- Guards (#1955): `LibraryIcon` warns in development for a size off the scale, a unit test fails on
  an off-scale size literal, and `text-glyph-ratchet.test.ts` records each remaining text-glyph site
  with the area epic that removes it (docs/icon-system.md). A stylesheet rule that sizes an icon
  (`svg` or `.app-icon`) uses the `--icon*` tokens or 24px; `stylesheet-guardrails.test.ts` fails on
  any other px width or height (#2081).

---

## 19. Migration Map

### 19.1 Tokens

| Current | New | Note |
| --- | --- | --- |
| `body { font-size: 14px }` | `body { font: var(--type-body) }` (13px) | Unclassed text drops 1px; it was larger than its designed neighbors. |
| `--text-2xs` (10) | `--text-xs` (11) | Removed. |
| `--text-status` (11.5) | `--text-xs` (11) | Removed. |
| `--text-lg` (17) | `--text-lg` (16) | Value change; page titles move to `--text-xl`. |
| literal 12.5 / 13.5 / 15 / 16.38px | nearest role token | 12.5→12 (`--text-sm`), 15→16 (`--type-title`). |
| `--radius-sm` 8 | `--radius-sm` 6 | Controls tighten. |
| `--radius-md` 10 | `--radius-md` 8 | Containers. |
| `--radius` 12 | `--radius-lg` 12 | Rename; keep alias for one release. |
| literal radii 2/3/5/7/9px | nearest tier | 2–5→`--radius-xs`, 7→`--radius-sm`, 9→`--radius-md`. |
| `--shadow` | `--elev-2` (popovers) / `--elev-3` (dialogs) | Removed. |
| `--primary-to`, `--primary-hover-to`, `--primary-active-to`, `--primary-*-border`, `--primary-hover-inset` | unused | Flat primary; keep in schemes until regeneration, then drop. |
| `--row-pad-*`, `--inbox-row-pad-*`, `--project-row-pad-*`, `--card-pad-*`, `--agent-row-pad-*`, `--finding-row-pad-*`, `--ext-row-pad-*`, `--artifact-row-pad-*`, `--run-card-pad-*`, `--runner-card-pad-*`, `--ws-row-pad-*`, `--files-entry-pad-*`, `--usage-cell-pad-*` | `--row-pad-x` + `--row-h*` | Density changes row height, not per-family padding. |
| `--bp-tablet` 900 / `--bp-desktop` 1240 | `--bp-compact` 1100 / `--bp-wide` 1440 | Documentation tokens; media queries use 760 / 1100 / 1440. |
| where `--radius-sm/-md` live | edit the values in the `:root, :root[data-theme="dark"]` block | They are declared only there, and `:root` also matches in light, so one edit covers both themes. Do not redeclare them in the shared token block (its comment explains the specificity trap). |
| `--mobile-session-action-gap` 7px | `--space-2` | |
| (none) | `--control-h-sm/-/-lg`, `--row-h/-2/-dense`, `--bar-h`, `--rail-w`, `--page-max/-wide/-form`, `--page-gutter`, `--measure`, `--list-pane-w`, `--sessions-list-h`, `--panel-w`, `--bottom-bar-h`, `--toast-clear`, `--space-0-5`, `--space-12`, `--space-16`, `--focus*`, `--surface-selected`, `--field-bg`, `--primary-bg*`, `--primary-fg`, `--danger-bg*`, `--danger-fg`, `--count-warning-fg`, `--tint`, `--type-*`, `--icon*` | New. Nothing else: no aliases of palette names. |

### 19.2 Classes and Components

| Current | New |
| --- | --- |
| `.topbar` (title-only), `.view-heading`, `.skills-heading`, `.automation-heading`, `.projects-intro`, in-page `h2` | `PageHeader` → `.page-header` (`.page-title`, `.page-desc`, `.page-actions`, `.page-tabs`) |
| `.topbar-create` (Runs `btn.sm`, Pods `icon-btn +`) | Page header primary `.btn.primary` with `+` icon |
| `.detail-head` + `←` glyph (Run, Pod), session `.detail-head` | `.detail-bar` |
| `.btn` (padding-sized, 34px) | `.btn` (`--control-h`, secondary look) |
| `.btn.sm` (26px) | `.btn.sm` (28px) |
| `.btn.primary` gradient | `.btn.primary` flat |
| `.btn.danger` tint | `.btn.danger` solid (confirm only); inline destructive → menu item or `.btn.ghost.danger` |
| `.btn.subtle`, `.btn.secondary` (no CSS), `.btn-rediscover`, `.connection-details-trigger`, `.seg-btn`, `.scope-opt`, `.hunk-act`, `.rp-back`, `.rp-close` | `.btn` / `.btn.ghost` / `.icon-btn` / `.seg` at a token height |
| `.icon-btn` (padding only, 27–40px) | `.icon-btn` (square, 28/32/40) |
| classless `<button>` | `button { background: none; border: 0; color: inherit; font: inherit; padding: 0 }` reset + a component class |
| `.menu-pop`, `.plus-pop`/`.plus-item`, `.rail-more-sheet` (desktop), `.palette-item` rows | `.menu`, `.menu-item`, `.menu-label`, `.menu-sep` |
| `.plus-section`, `.menu-label` (uppercase) | `.menu-label` (Title Case, `--type-label`) |
| `.modal-head h2` 15px, `.modal-body` 18px pad, `.modal-foot` 14/18 pad | `.modal-head .modal-title` (`--type-title`), `.modal-body` (20), `.modal-foot` (16/20) |
| `ConfirmationDialog` sentence-case question titles, default "Continue" | Title Case action titles, verb-matched confirm label; `.modal.sm` |
| `.status-badge`, `.inbox-status-pill`, `.background-work-badge`, `.automation-state`, `.pod-status`, `.pod-orchestration-status`, `.workflow-status`, `.connection-status`, `.subscription-state`, `.loc-kind`, `.project-availability`, `.access-role-badge`, tool-row uppercase pills, receipt rectangles | `.status` (`.sm`/`.md`, `.inline`, tone classes `.t-info/.t-success/.t-warning/.t-danger/.t-neutral`) |
| `.tag`, `.tag-machine`, `.tag-agent`, `.tag-wt`, `.atag`, `.os-badge`, `.cctx-chip` | plain meta (`.meta-item`) or `.chip` (neutral) |
| `.tab-count`, `.group-count` | `.count` (plain) or `.count-badge` (attention) |
| rail `.rail-badge`, More sheet `.rail-more-count` (removed, #1967) | `CountBadge`, or `.rail-attention-dot` for Connections (§11.4) |
| `.quarantine-banner`, `.skills-unavailable-notice`, `.worktree-setup-notice`, `.campaign-continuation-notice`, `.campaign-held-children`, `.box-hint`, `.composer-error`, `.composer-attachment-notice`, `.queued-error`, `.settings-inline-error`, `.settings-pending-reason`, `.skills-git-held`, `.error-boundary` | `.notice` (`.t-*`, `.compact`) |
| `.toast` + 4px left stripe, `.toast-region` under the bar | `.toast` + tone icon; `.toast-region` bottom right (bottom center on phones) above `--toast-clear` (§13.1) |
| offline banner, pairing banner | `.notice.page-banner` |
| `.empty` (bordered card), `.empty-title` 15px, `.inbox-zero-mark ✓`, `.sidechat-empty`, `.background-work-empty`, `.subagents-empty`, `.rp-launcher` centring, "Select a …" detail placeholders | `.state` (`.state-icon`, `.state-title`, `.state-body`, `.actions`), top-left aligned; `.overview` default detail |
| `.skeleton` (flat bars, 16px inset) | `.skeleton-row` shaped like the real row |
| `.skills-section` (all tiers), `.project-location-card` in cards, `.runner-card` stacks | `.section` / `.surface` / `.notice` tiers |
| `.skills-item`, `.project-manager-item`, `.run-card` (button) | `.row` (`.row-2` for two-line) or `article.card` |
| `.ui-seg` / `.ui-seg-option` / `.sessions-view-toggle` | `.seg` / `.seg-option` (neutral selected chip) |
| `.inbox-tab`, `.connections-tabs > button`, `.settings-nav` on phone | `.tabs` / `.tab` |
| `.ui-select-trigger` (160px min, content width), native `<select>` | `.select-trigger` (full width in `.field`, list min 280px) |
| `ui/ChoiceControls` `Checkbox` (native 13px) | `.checkbox` + `.switch` |
| `ChoiceCards` (`.ui-choice-cards`, `.ui-choice-card*`, trailing `.ui-choice-mark`), `.workflow-preset`, `.agent-pick`, `.pod-member-pick`, `.access-choice`, the People member checklist | `ChoiceRows` (`.choice-row`, leading `.radio-mark` / `.checkbox-mark`) or `ChoiceList` (`.choice-list`) (#1952) |
| `.field` / `.access-form` (two systems) | `.field` (label, control, helper/error) |
| `.ui-row`, `.ui-row-choice`, `.orchestrator-number-row`, `.orchestrator-policy-control`, `.rail-order-row`, `.agent-defaults-editor` grids | `.setting-row` |
| `.archive-table`, `.usage-table`, `.skills-table`, assignment matrix | `.table` (fixed layout) with phone row fallback |
| `.shortcut-row kbd`, `.shortcut-hint kbd` (9px) | `kbd` (one recipe) |
| `code` global chip | `:not(pre) > code` chip only |
| `a` (unstyled) | `a, .link { color: var(--accent) }`; `accent-color: var(--accent)` on `:root` |
| `:focus-visible` accent ring | `:where(:focus-visible)` neutral ring + programmatic-focus suppression |
| zone frame `.inbox-preview-pane:has(.detail-scroll:focus-visible)::after` | F6-only top-edge indicator |
| `.inbox-splitter` (10px band, borders top and bottom, 40×2px grip), `.inbox-list-pane` / `.inbox-preview-pane` inline heights | `.master-detail.sessions-md` stacked grid with `.master-detail-resize` on the list's bottom hairline (§6.3) |
| Per-page master-detail grids (Skills, Projects, Machines, Settings) | `.master-detail` (§6); `.md` stays the markdown class |
| `.review-required` chip | `.status.t-neutral.no-dot` flag badge (§11.3) |
| `.inbox-activity-footer`, `.inbox-shortcut-rail` between the list and the preview | nothing: counts move to tabs and the rail, actions to the preview and row menus |
| `.agent-details-grid`, `.background-work-job-meta`, `.usage-totals`, `.subscription-buckets`, `.skills-orphan-facts`, `.settings-about` | `.facts` (`.facts.strip` for the Usage totals) (§5.4) |
| `.access-manual-disclosure`, `.project-location-create-disclosure`, `.runner-disclosure-chevron`, `.tl-disclosure` | `.disclosure`, `.disclosure-trigger`, `.disclosure-chevron`, `.disclosure-body` (§5.5) |
| `.share-disclosure` (a risk warning) | `Notice` with the warning tone (§13.2) |
| `.context-popover-bar`, and `.context-meter` as the control's root | `.meter` (§11.6); the control's root is `.context-control` |
| `.ui-select-list` | `.menu.listbox` (§9.1) |
| `.connection-details-code` | `.code-well` (§11.7) |
| `.personal-identifier*` | `.pid`, `.pid-value`, `.pid-mask`, `.pid-toggle`, `.pid-field-head` (§11.8) |
| `.agent-defaults-toolbar`, `.archive-toolbar`, `.board-toolbar`, `.connections-toolbar`, `.view-toolbar`, `.inbox-toolbar`, `.usage-toolbar-controls` | `.toolbar` (§4.7) |
| `.files-crumbs`, `.files-crumb` | `.crumbs`, `.crumb`, `.crumb-sep` (§4.8) |
| `.queued-badge`, `LABELS` (`PendingPromptBubbles.tsx`), `queueLabel` (`SessionDetail.tsx`) | `StatusBadge` with `statusMeta("queuedMessage", …)` (§11.2) |
| `error-text` (Settings › Network, Tailnet) | `.danger-text` (§8.5) |
| `.editor-split-segment` (Open in Editor) | `.split` of two `.btn`s (§3.2) |
| `.seg.is-block` | `.seg.block` (§10.2) |
| `.onboard-steps` | `Steps` → `.steps` (§8.7) |
| `.modal-backdrop ~ .modal-backdrop` | `.modal-backdrop.stacked`, set by `Modal` (§7.1) |

### 19.3 Rollout Order

1. Base resets and tokens: `font: inherit` on form controls and buttons, classless button reset,
   body 13px, `:where` focus, programmatic focus suppression, `accent-color`, link color, `code`
   scope, flow-spacing reset. (One PR; fixes Arial inputs, gray buttons and the teal focus box
   around page titles app-wide.)
2. Control heights and `.btn` / `.icon-btn` / inputs / selects / `.seg` on tokens, plus the single
   coarse-pointer block. Delete per-selector 44px patches.
3. `Modal` portal + anatomy + phone sheet; `ConfirmationDialog` copy rules.
4. `PageHeader` + page container + detail bar; delete in-page h2s.
5. `StatusBadge` + `statusMeta` table; `Notice`; `State`; `Toast` anatomy.
6. Menus, tabs, segmented; tables and rows; then per-area redesigns.

A CI check should fail on: `text-transform: uppercase|capitalize`, literal `font-size`,
`border-radius`, `gap` or `padding` px outside the token block, a hard-coded `"Cascadia Code"` stack
instead of `var(--font-mono)`, `justify-content: flex-end` together with `overflow-x: auto` (the start
becomes unreachable), a viewport `@media` query inside a panel's rules, `window.confirm`, TSX class
names with no CSS rule, and emoji in TSX outside content.

Organize the new component CSS by component (one block per primitive, in the order of this
document) rather than appending to the area where it was first needed. The timeline alone is spread
over four regions of the stylesheet today, which is how one component drifts into several recipes.

Two engineering fixes are not visual but cause visual bugs: key detail views by
entity id (`RunDetail`, `PodDetail`) so drafts and errors do not carry across resources, and guard list
views on snapshot load and connection state so they render Loading or Reconnecting instead of a
"No … Yet" empty state (§12.5).

### 19.4 Area Proposals: Promote, Already Delivered and Reject

The area redesigns proposed 118 classes and patterns beyond this document. Each got one decision
before any area work starts, by one rule:

- **Promote** a class when two or more areas use it, or when it replaces an existing ad hoc
  pattern in production.
- **Merge** overlapping proposals into one class each.
- **Reject** single-use classes. They stay local to their component's CSS block; area work does not
  add them to the shared primitives.

In total, 42 proposal entries merge into 20 promotions, 20 are already delivered, and 56 are
rejected. `.field-error` (#2150) was promoted later, from the production patterns it replaces rather
than from an area proposal. Cite this section when an area design uses one of these names.

**Promote.** Each promoted class is written once, in the component-ordered part of `styles.css`
(§19.3), with tokens only. A promoted class with no production screen using it yet lands with its
shared component (named below), which renders it, so the stylesheet guard's dead-class check stays
green. Area work adopts the component instead of writing the class again.

| Class | Merges | Section | Status |
| --- | --- | --- | --- |
| `.facts` (`.facts.strip` for a summary strip) | `.facts`, `dl.facts`, `.kv`, `.kv-list` | §5.4 | Six production lists |
| `.disclosure` | three area recipes | §5.5 | Four production disclosures |
| `.meter` | `.meter` (two areas), the progress bar | §11.6 | The context window meter |
| `.menu.listbox` | `.menu.listbox`, `.listbox`, the combobox popup | §9.1 | Select and SearchableCombobox |
| `.modal-backdrop.stacked` | `.stacked`, `.nested`, the stacked modal | §7.1 | `Modal` (#1800 shipped the behavior) |
| `.menu.flip-up` | `.flip-up`, `.drop-up` | §9.1 | Already delivered: `Menu.tsx` placement (#1803) |
| `.menu-note` | one area class | §9.1 | Already delivered: `MenuNote` (#1803) |
| `.menu-scroll` | one area class | §9.1 | Already delivered: the one `Menu` height cap (#1803) |
| `.code-well` (with a single-line form) | `.code-well`, `.copy-field` | §11.7 | Connection details (the single-line form lands with its first consumer) |
| `.pid` | `.pid`, `.masked-field` | §11.8 | `PersonalIdentifier` |
| `.split` (split button) | three area classes | §3.2 | `EditorSelect` |
| `.seg.block` (full-width segmented) | two area classes | §10.2 | The Projects visibility filter |
| `.toolbar` with `.filter-btn` | `.toolbar`, `.tools-group` | §4.7 | Seven production toolbars; `FilterButton` |
| `.is-stale` | four area classes | §12.5 | `StaleContent` |
| `.field-warn` | two area classes | §8.5 | `FieldWarning` |
| `.field-error` | `.question-field-error`, `.form-error` under a field, the composer answer's invalid border | §8.5 | `FieldError` (#2150), first used by New Skill (#1964) |
| `.list-foot` | three area classes | §5.6 | `ListFoot` |
| `.crumbs` | `.crumbs` | §4.8 | The Files panel path |
| `.save-bar` with `.is-error` | `.save-bar.is-error`, the settings save-bar placement | §8.6 | `SaveBar` |
| `.steps` (with a horizontal variant) | `.steps` (Machines), `.how-steps` | §8.7 | `Steps` (Connect a Machine) |
| `statusMeta("queuedMessage", …)` | the composer's queued-message vocabulary | §11.2 | Pending bubbles and the composer queue |

The merged-away names (`.kv`, `.kv-list`, `.copy-field`, `.drop-up`, `.modal-backdrop.nested`,
`.masked-field`, `.how-steps`, `.tools-group`, `.progress` and a bare `.listbox`) are never
written. The Automations workflow step list is a different component from `.steps`, and takes a
local name so the two do not collide.

**Already delivered** (no promotion needed):

- #1799 (§2.8): coarse segmented height and hit area, inline-link hit area, disabled segmented
  options and switches, `.icon-btn.primary:disabled`, input affixes.
- #1801: `.detail-head` becomes `.detail-bar`; the list-page tab rows use the page header's tabs.
- #1802: `.status.family` (family rollup tone), `.notice.compact` with dismiss, the phone toast
  "+N More", and the page banner's phone stacking.
- #1803: the dense 32px tree row (§5.2), trailing check slots in menus, the row's single open
  target, and the Menu primitive's `.menu-note` (which replaced `.menu-caution`), placement that
  flips upward (the proposed `.menu.flip-up`) and one height cap (the proposed `.menu-scroll`).
  Neither of the last two needs a class: the placement and the cap are the menu's own, and a rule
  of their own would change what the menu draws.
- §6.3 and §19.2: `.sessions-md`, which is `.master-detail.sessions-md` and is built with Sessions.
- §8.4 ChoiceRow: the choice list, ChoiceRow selection that follows the checked input, and
  `.cand-list`/`.radio-mark`. #1952 built them as `ChoiceRows`/`ChoiceRow`, `ChoiceList` and the
  `.radio-mark`/`.checkbox-mark` markers; a candidate list is a `multiple` `ChoiceRows` group.

**Reject** (component-local; area work keeps these in its component's CSS block):

- **Notices:** `.composer .send` sizing, the session notice slot (built by the Notices area on
  `Notice`).
- **Sessions:** `.srow`, `.activity`, `.bar-picker`, `.bar-strip`, `.board`/`.bcol`/`.bcard`,
  `.notice.inset`, `.preset-grid`.
- **Session Chrome:** `.ps` family, `--summary-w`.
- **Composer:** `--composer-ctl`, `.composer-btn`, `.model-chip`, `.picker*`, `.queue`,
  `.composer-mode`.
- **Approvals:** `.request`, the decision record row, evidence tiles and viewer, `.policy-row`.
- **Right Panel:** `.seg.fit`, `.selbar`, `.outdated`.
- **Agents:** `.worker-row`, `.sc-composer`, `.dock`/`.term`, `.dock-tab .cmd`.
- **Skills:** the skill file diff, `.modal-body.split`, `.modal-foot.has-consent`, `.rule-row`.
- **Projects:** `.select-trigger .value-sub`, `.field-row.two`, `.fb`, `.inline-state`,
  `.changed-mark`.
- **Automations:** `.glance`, `.chip.toggle`, `.compare`, check-list rows (a `.surface` of existing
  check rows), `.foot-note.keep`.
- **Machines:** `.checklist`, `.signin`.
- **People:** `.inst-tile`, `.state.recovery`, top-anchored step dialogs.
- **Archive and Usage:** `.row-3`, `.u-overview`, `.sub-win`, `.usage-capsule`.
- **Settings:** `.setting-row` details, `.set-sublabel`, `.update-block`, `.modal-body.allow-overflow`
  (unneeded once #1800 portals menus out of dialogs).

**Remaining `<dl>` recipes.** Ten other label and value lists still carry their own rules and
move onto `.facts` with their area: `.context-popover-facts`, `.session-usage-facts`,
`.auth-recovery-identity`, `.shortcut-list`, `.instance-meta`, `.governance-decision-facts`,
`.runner-meta`, `.connection-details-list`, `.approval-selector-context` and `.automation-facts`.
(`.workspace-reference-details` moved onto `.facts` with the File Reference dialog, #2177, and
`.campaign-held-child-hold` with Held Children, #2157.)

---

## 20. Problems Addressed

| Problem | Fixed by |
| --- | --- |
| No control-height scale | §2.8, §3.1 |
| Arial inputs, 13.333px button rows, bold automation values | §2.3 rules |
| Body 14px vs `--text-base` 13px; 11+ literal sizes | §2.3 |
| Literal spacing, radius drift, no nesting rule | §2.4, §2.5 |
| No page header; duplicate titles; inverted type scale; ragged action rows | §4.2, §3.2, §3.3 |
| No page container; six left edges | §4.5 |
| Three back patterns; triple chrome on Run and Pod | §4.3 |
| Buttons stretch to full-width bars; buttons wrap to 2 lines | §3.1 rules |
| Accent overload; focus ring on page title, dialogs, panes | §2.2, §16.1 |
| Tracked all-caps labels; `text-transform` Title Case shims | §2.3, §17.1 |
| Five-plus chip styles; status said 2–3 times; color misused for identity | §11 |
| Four notice recipes; bare colored-sentence errors; `PendingSetting` | §13.2 |
| Toasts over Send and the phone rail; tone by stripe only | §13.1 |
| Empty void detail panes; bordered empty banners; success-looking offline states | §6.1, §12 |
| Modals not portalled; phone dialogs as 350px centered cards with 34px footers | §7 |
| Three menu primitives; selection by color only; uppercase menu labels | §9 |
| Loud accent segmented controls; segmented wrapping | §10.2 |
| Wide tables on phones; row actions as text-button strings | §14 |
| One breakpoint (dead zone 761–1000px); ad hoc 600/640/680/700px; viewport queries inside panels | §2.10, §15.2 |
| Hover sticks on touch; touch targets patched per selector | §2.8, §3.1, §15.3 |
| Unicode glyphs and emoji as icons; filled rail outlier; duplicate icon aliases | §18, §4.1 |
| Two names per destination; "Inbox"; vocabulary drift; jargon; raw ids | §4.1, §17 |
| Card nesting (card > card > card > chip) | §5.1 |
| Errors far from their cause; three form systems; native validation bubbles | §8.5, §7.3 |
| Master-detail with no phone route and no URL selection; scroll leaks | §6, §6.2 |
| Popovers leak Escape; floating layers stack | §9.2 |
| Disabled reasons hidden in `title` | §3.1, §7.3, §9.1 |
| Unbuilt features advertised in production UI | §13.2 (`PendingSetting` removed) |
| Selected segment invisible in light theme (1.15:1) | §10.2, §2.11 |
| Hover looks the same as on for toggle buttons | §3.1 |
| First tap lost in a focused composer | §16.2 |
| Bottom-edge chrome stacking between transcript and composer | §13.2 Budget |
| Fixed `min-height` dialog bodies; nested dialogs replacing their parent | §7.1 |
| Negative margins escaping a parent's padding | §4.5 |
| Sibling management pages at different widths (880 vs full) | §2.7, §4.5 |
| Hard-coded mono stacks; one component's CSS in four places | §19.3 |
| Unkeyed detail components; list views without a snapshot guard | §19.3, §12.5 |

---

## 21. Known Tensions

These trade-offs are deliberate. Keep them in mind when a screen seems to argue against a rule.

1. **Density vs 44px on touch laptops.** `@media (pointer: coarse)` also fires on touch-screen
   laptops running the Tauri app at desktop widths, so every row grows 8px there. That is intended:
   touch needs the size. Do not add a width condition to avoid it.
2. **The session bar status.** The desktop session bar shows a full status badge at 1100px and
   wider and a dot only at compact widths (§15.2), where a long title would otherwise drop under a
   readable width. §9.3 says a tooltip must never be the only carrier of needed information, so
   wherever only a dot shows, the Session Status popover is the visible label: the control is a
   button, and the popover lists every condition in words.
3. **The phone session header's badge line.** The phone session header keeps one full badge and
   "+N" at the start of its second line, beside Share and More Actions. §11.1 allows one pill per
   attention kind, but the line cannot hold them, so the other kinds are counted in "+N" and listed
   in the Session Status sheet; the control clips rather than pushing the two buttons.
4. **Top-left empty states in tall panes.** This system top-aligns every state. In a 900px right
   panel a top-left state can read as part of the header, so inside panels use `.state.compact`
   (24px top).
5. **Amber meaning.** Amber is "needs you" (attention, held updates, edited copies). The settled
   composer layout also tints its shield amber for no-approval modes. That is a risk warning, not
   a request, so it takes the warning color **on the icon only**, never an amber pill or count.
6. **Light theme hierarchy is compressed.** `--text-dim` and `--text-faint` are only 1.2:1 apart in
   light (6.35 vs 5.24 on `--bg`), so timestamps and descriptions read as one gray. Use weight and
   size, not the faint tier, to build hierarchy in dense light screens. Re-spacing the tiers is a
   separate palette change.
7. **Danger fill in other schemes.** `--danger-bg` is set for the Wollipog scheme only. Until the
   scheme generator emits a checked `--danger-bg`, destructive confirm buttons in Dracula, Monokai,
   GitHub and One Dark use the Wollipog red.
8. **The composer's one-edge focus.** The composer is a card that is focused almost all the time,
   so it shows focus as its own 1px edge in `--focus` instead of the §16.1 input recipe's edge plus
   ring. A 2px near-white ring around a card that is almost always focused reads as an alarm, and a
   teal edge would compete with Send. The card rests on `--control-outline`, so rest to focus
   measures at least 3:1 in every scheme and theme. Other inputs keep §16.1. Because
   `--control-outline` must itself clear 3:1 on the surfaces it bounds, `--focus` has to clear
   about 9:1 on them, which `--text` does not in One Dark (both themes) or Dracula's dark theme.
   The scheme generator therefore emits `--focus` per scheme: the palette's `--text`, moved toward
   white (dark) or black (light) only as far as the 3:1 step needs. One Dark dark focuses in
   `#c5c9d2` (3.00:1), One Dark light in `#313239` (3.02:1) and Dracula dark in `#ffffff`
   (3.00:1, the most any colour reaches there). Every other generated theme keeps its `--text`.
9. **Composer pickers on phones.** The / and @ pickers (`ComposerListbox`, #2155) open above the
   composer on phones too, with 44px rows and no footer keys, instead of becoming a bottom sheet
   (§9.2). A sheet would cover the caret and compete with the software keyboard while the person is
   still typing the query the picker filters on. The Select and SearchableCombobox list is the
   other list that stays anchored on phones (§9.1).
10. **Model Settings is a popover of menu rows.** Model Settings (#2191) holds a segmented Context
    Window (§10.2), which a menu cannot contain, so it is a §9.2 popover (`role="dialog"`) of
    labelled radio groups. Its Model, Reasoning Effort and Service Tier choices keep §9.1's rows
    and trailing check, so the popover takes the menu's 4px inset instead of 16px, and it is 536px
    wide when it has two columns. In those groups the arrow keys move between options without
    choosing one, and Enter or Space chooses, as in the menu it replaced. Every choice is a live
    configuration request and a model change resets the effort, so arrowing past a model must not
    choose it. The segmented Context Window keeps §10.2's arrows-select behavior.
