---
name: ProoflineQA
description: The signed-in QA control center and auth pages, laid out as Lifecycle Lanes in the landing page's dark editor world, with a matching light theme.
colors:
  ground: "#0a0d0f"
  sunken: "#070909"
  panel: "#0f1418"
  raised: "#141b20"
  hover: "#182128"
  hairline: "#1f282e"
  hairline-strong: "#2c373e"
  ink: "#e9eeec"
  ink-dim: "#a8b3b0"
  ink-muted: "#84918f"
  approve: "#35d08f"
  approve-ink: "#04150d"
  approve-hi: "#4fe0a2"
  approve-wash: "#0f2a1f"
  pending: "#f2b544"
  pending-wash: "#2a2111"
  change: "#ff6b5c"
  change-fg: "#ff7d70"
  change-wash: "#2c1412"
  ai-grey: "#c3ccc9"
  ai-wash: "#182023"
  inverse: "#e9eeec"
  inverse-fg: "#0a0d0f"
  inverse-hi: "#ffffff"
  ground-light: "#f3f5f4"
  sunken-light: "#e9edeb"
  panel-light: "#ffffff"
  raised-light: "#f7f9f8"
  hover-light: "#eef2f0"
  hairline-light: "#e0e6e3"
  hairline-strong-light: "#c8d1cd"
  ink-light: "#0d1214"
  ink-dim-light: "#3b484b"
  ink-muted-light: "#5a686a"
  approve-light: "#16a46a"
  approve-fg-light: "#0b7a4c"
  approve-hi-light: "#12925d"
  approve-wash-light: "#e2f5ec"
  pending-light: "#d99a12"
  pending-fg-light: "#8a5a00"
  pending-wash-light: "#fbf1dc"
  change-light: "#df4a3a"
  change-fg-light: "#b8362a"
  change-wash-light: "#fce9e6"
  ai-grey-light: "#56656a"
  ai-wash-light: "#eef2f1"
  inverse-hi-light: "#273034"
typography:
  display:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(26px, 2.6vw, 34px)"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  title-overlay:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "\"ss01\", \"cv11\""
  label:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
  column-head:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    letterSpacing: "0"
  figure-lg:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\""
  figure:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "18px"
    fontWeight: 500
    fontFeature: "\"tnum\""
  mono-meta:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
  mono-status:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    letterSpacing: "0.01em"
  mono-step:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  xs: "4px"
  sm: "5px"
  md: "6px"
  lg: "7px"
  xl: "8px"
  frame: "10px"
  pill: "999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  row-y: "9px"
  lg: "12px"
  row-x: "14px"
  xl: "16px"
  gutter: "clamp(16px, 2.4vw, 32px)"
components:
  button-primary:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.inverse-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.inverse-hi}"
  button-run:
    backgroundColor: "{colors.approve}"
    textColor: "{colors.approve-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-run-hover:
    backgroundColor: "{colors.approve-hi}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-mini:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  button-submit:
    backgroundColor: "{colors.approve}"
    textColor: "{colors.approve-ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
    width: "100%"
  input:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  status-pill:
    backgroundColor: "{colors.ai-wash}"
    textColor: "{colors.ink-dim}"
    typography: "{typography.mono-status}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  status-pill-approved:
    backgroundColor: "{colors.approve-wash}"
    textColor: "{colors.approve}"
  status-pill-pending:
    backgroundColor: "{colors.pending-wash}"
    textColor: "{colors.pending}"
  status-pill-failed:
    backgroundColor: "{colors.change-wash}"
    textColor: "{colors.change-fg}"
  chip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.sm}"
    padding: "0 7px"
    height: "20px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.xl}"
    padding: "16px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "30px"
  nav-item-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  lifecycle-rail:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.frame}"
    padding: "14px 16px"
  inspector:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.frame}"
    width: "340px-400px"
  modal:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.frame}"
    width: "520px"
---

# Design System: ProoflineQA

Scope: the signed-in app and the auth pages (`apps/web/src/app`, `apps/web/src/components`), styled by `apps/web/src/app/globals.css` and scoped to `.shell` and `.auth-shell`. The marketing pages (the `(marketing)` route, `landing.css`, `components/marketing`) are a separate Tailwind world this file does not govern, though the app deliberately shares their palette, faces and brand mark.

## Overview

**Creative North Star: "Lifecycle Lanes"**

The approval lifecycle is the spine of every screen. Generated, Pending review, Approved, Running and Passed/Failed appear as a connected rail of mono counts, as tabbed lane totals, and as lanes of dense rows. Selecting a row opens a persistent right inspector, so the reviewer reads steps and evidence next to the list instead of in a modal. The world is the landing page's dark editor/diff surface carried into the product: a near-black ground, panels one tonal step up, 1px hairlines doing the structural work, and three verdict colors that only ever mean a state.

Density is high and deliberate: 13px body, 30 to 54px rows, 9px by 14px row padding, 16px between blocks. Schibsted Grotesk carries all UI language; JetBrains Mono is kept for the machine's words, meaning SHAs, branches, counts, steps, code and status labels. Dark is the default theme. Light keeps every role and swaps only the values, and the auth intro column stays dark in both themes as a piece of the landing world.

The system rejects the stat-card dashboard: no icon tiles, no hero numbers in floating cards, no gradient or glass surfaces, and no modal for a detail that fits in the inspector.

**Key Characteristics:**
- A five-stage lifecycle rail and lane columns instead of stat cards.
- Hairline borders and tonal steps (ground, panel, raised) separate surfaces at rest. Shadow is reserved for floating layers.
- A dot plus a mono label marks every state, colored only by the three verdict hues and AI grey.
- Lists inside a panel bleed to its edges instead of nesting a second box.
- Motion runs 120 to 220ms ease-out on state changes only, with no page-load choreography.

## Colors

A near-monochrome editor palette, cool green-grey neutrals, plus three verdict colors and an AI grey that carry all meaning.

### Primary
- **Approve Green** (`approve`, light `approve-light`): passed, approved and completed states; status dots; the progress and segment bar fill; the focus ring and input focus border; the active nav icon; the current-plan and selected-project inset rail; and the fill of the forward action on a surface (Run approved, Approve, the auth submit). Green text uses `approve-fg` (the same value in dark, `approve-fg-light` in light) to keep contrast on white.
- **Approve Ink** (`approve-ink`): text on a green fill. In light it is white.

### Secondary
- **Pending Amber** (`pending`, light `pending-light`, text `pending-fg-light`): pending review, queued, needs review (dashed outline, no fill), HIGH priority, and the "Review" stage node.
- **Change Coral** (`change`, text `change-fg`, light `change-light` / `change-fg-light`): failed, rejected, CRITICAL priority, destructive buttons, error banners and form errors, the record dot, and the failed segments of a run bar.

### Tertiary
- **AI Grey** (`ai-grey`, wash `ai-wash`; light `ai-grey-light`): the neutral status pill, used for generated or unclassified states that have no verdict yet.

### Neutral
- **Ground** (`ground` / `ground-light`): the page behind the workspace.
- **Sunken** (`sunken` / `sunken-light`): sidebar (dark), input wells, step lists, code blocks and segmented-control troughs. In light, the sidebar and wells use Raised or Panel instead.
- **Panel** (`panel` / `panel-light`): every bordered container: panels, lanes, library tables, the rail, the inspector, modals and menus.
- **Raised** (`raised` / `raised-light`): table header rows, selected rows, the active nav item, the inspector and modal footers, and secondary buttons.
- **Hover** (`hover` / `hover-light`): the row and menu hover fill.
- **Hairline** (`hairline` / `hairline-light`): every divider and container border at rest.
- **Hairline Strong** (`hairline-strong` / `hairline-strong-light`): control borders (inputs, buttons, chips), overlay borders, and the inactive dot.
- **Ink, Ink Dim, Ink Muted** (`ink`, `ink-dim`, `ink-muted` and their `-light` pairs): primary text, secondary copy and labels, and metadata, placeholders and icons.
- **Inverse** (`inverse`, `inverse-fg`, `inverse-hi`): the primary button, the toast, and the sticky bulk-action bar. It flips with the theme (light ink on dark, dark ink on light).

### Named Rules
**The Three Verdicts Rule.** Green, amber and coral mean approve, wait and change, and nothing else. They never decorate a heading, an icon tile or an empty state. If a color isn't reporting a state or committing an action, it is a neutral.

**The One Green Button Rule.** A green fill marks the single forward action that moves work through the gate (Run approved, Approve, the auth submit). Every other primary action uses the inverse fill.

**The Washed State Rule.** A state surface pairs a 1px border, the state color mixed at 30 to 40% into transparent, with its wash token behind text in the state's `-fg` color. A state is never shown as a solid fill under body text.

## Typography

**Display Font:** Schibsted Grotesk (with ui-sans-serif, system-ui)
**Body Font:** Schibsted Grotesk, with stylistic sets `ss01` and `cv11` on
**Label/Mono Font:** JetBrains Mono (with ui-monospace), always with tabular numerals where it shows figures

**Character:** A compact, slightly condensed grotesk for everything a person reads, set against a code mono for everything the machine reports. The pairing reads like an editor sidebar next to a diff.

### Hierarchy
- **Display** (600, clamp(26px, 2.6vw, 34px), 1.12, -0.025em): auth intro headline only. It drops to 22px under 860px.
- **Headline** (600, 20px, 1.2, -0.015em, balanced wrap): page `h1` and auth form heading.
- **Title** (600, 14px, 1.3): panel headings and project names. Overlay titles in the inspector, modals and drawers use 15px.
- **Body** (400, 13px, 1.45): all UI copy, row titles (500 weight), and inputs. Long prose such as empty states caps at 60ch.
- **Label** (500, 12px): form labels in Ink Dim. Section labels use 11.5px at 600, and column heads use 11.5px at 500 in the sans.
- **Figure** (JetBrains Mono 500, 24px on the rail and 18px on tab and summary strips, tabular): stage and lane counts.
- **Mono meta** (JetBrains Mono, 10.5 to 11.5px): SHAs, branches, repo paths, versions, timestamps, step lists, and status pill labels (10.5px, 500, 0.01em). The priority label is the only uppercase text (10.5px, 0.03em).

### Named Rules
**The Machine Voice Rule.** Mono is for what the system emits: SHAs, branches, counts, steps, code, status and priority labels, and meta lines. Column heads, sentences, labels and button text stay in the sans. The build moved table heads from mono to sans for exactly this reason.

**The Three Weights Rule.** Use 400, 500 and 600 only. Hierarchy comes from size steps of 1 to 2px and from Ink, Ink Dim and Ink Muted, never from 700 or heavier.

## Layout

The shell is a two-column grid: a 216px sidebar and a workspace that scrolls on its own (`100dvh`, overflow hidden on the shell). The workspace gutter is `clamp(16px, 2.4vw, 32px)` with 56px of bottom padding. The overview opens with a sticky 48px commit bar (repo, branch chip, sha, slots, AI quota meter) that bleeds across the gutter. Other pages open with a page header: an `h1` plus a mono meta line on the left and actions bottom-aligned on the right.

Content stacks at a 16px gap. Within containers, rows sit at 9 to 12px vertical by 14px horizontal padding and are separated by 1px top hairlines. Tables are CSS grids with fixed mono-friendly columns (28px check, flexible title, 118px status, 76px priority, 120px actions) and a 34px header row on Raised.

The lifecycle rail is a five-column grid with hairline-divided stages, each placing its action under its own count. The test library switches between Lanes (repeating `minmax(200px, 1fr)` columns that scroll horizontally), Table and By module. When a row is selected, the frame becomes list plus a 340 to 400px sticky inspector whose height is fitted to the viewport so its decision footer is always visible.

Breakpoints:
- **1180px and below:** the rail reflows to 3 columns, two-up grids collapse, and the inspector becomes a fixed full-height right sheet (min(420px, 100vw)).
- **860px and below:** the sidebar becomes an off-canvas drawer behind a 52px mobile bar, nav rows grow to 40px and touch targets to 44px, the rail goes 2-up, table heads hide and rows restack into grid areas, lanes scroll-snap at `minmax(240px, 82vw)`, modals dock to the bottom, toolbar filters fold behind a Filters toggle, and buttons grow to 40px.

### Named Rules
**The Lane-and-Inspector Rule.** A record opened from a list opens in the right inspector beside that list, not in a modal. j and k move through the lane, a approves, r rejects, and Esc closes. Modals are for creating, editing, confirming and viewing artifacts.

**The Bleed, Don't Nest Rule.** A list, how-to sequence, request table or stacked detail grid placed directly in a panel drops its own outer border and radius and bleeds to the panel's edges. A box is never drawn inside a box.

## Elevation & Depth

The system is flat and tonal. At rest, depth comes from three surface steps (ground, panel, raised) and 1px hairlines. In dark, panels carry only a 1px inner top highlight. Real shadow is used only by layers that float above the page: menus, tooltips, modals, the drawer, toasts and the sticky bulk bar. The sticky commit bar is the one translucent surface: Ground at 92% with a 10px blur, so scrolled content doesn't show through as it passes underneath.

### Shadow Vocabulary
- **Panel edge** (dark `box-shadow: 0 1px 0 rgb(255 255 255 / 0.03) inset`; light `0 1px 2px rgb(15 23 26 / 0.04)`): resting panels, the rail and the inspector.
- **Pop** (dark `0 1px 0 rgb(255 255 255 / 0.04) inset, 0 18px 48px -12px rgb(0 0 0 / 0.75), 0 6px 16px -8px rgb(0 0 0 / 0.6)`; light `0 18px 44px -14px rgb(15 23 26 / 0.28), 0 4px 12px -6px rgb(15 23 26 / 0.16)`): menus, combo lists, info tooltips, modals, the drawer, toasts, the bulk bar, and the inspector or sidebar once they become fixed sheets.
- **Selected rail** (`box-shadow: inset 2px 0 0 var(--fg)`, or `var(--approve)` for the current plan or project): marks the selected row without a border change.
- **Light lift** (`0 1px 2px rgb(15 23 26 / 0.05-0.06)` plus a 1px inset hairline): active nav item and active segment, light theme only.

### Named Rules
**The Hairline-First Rule.** If a surface rests in the page flow, separate it with a hairline and a tonal step, never with a drop shadow. Shadow means the layer is floating and can be dismissed.

## Shapes

Corners are small and nest from the outside in. The outer frames (the lifecycle rail, the inspector, modals) use 10px. Containers (panels, lanes, tables, menus, empty states) use 8px. Nested lists, banners, detail grids, code blocks and the project switcher use 7px. Controls (buttons, inputs, nav items) use 6px. Chips, menu items and segments use 5px. Code, kbd and skeleton bars use 4px. Pills, meters and avatars are fully round. Segment bars are the deliberate exception, at 2px with 1px segments, so a run reads as a measurement.

Borders are always 1px. Dashed hairlines mean provisional or empty: needs-review pills and lane dots, empty and loading states, the closed run gate, and the step-insert affordance. kbd keys carry a 2px bottom border. The auth intro column has a 44px ruled gutter (16px line pitch) as its only ornament, echoing the landing's editor margin.

## Components

### Buttons
Quiet, compact and instrument-like. Every variant is 32px tall at 6px radius, 500 weight, with a 6px icon gap and a 160ms ease-out color transition. Disabled buttons sit at 42% opacity.
- **Primary (inverse):** an Inverse fill with Inverse-fg text. Hover moves to Inverse-hi. A danger variant fills with Change Coral and white text.
- **Run / Approve (green):** an Approve fill with Approve-ink text at 600, hovering to Approve-hi. The auth submit is the same treatment at 38px and full width.
- **Secondary:** Raised fill, Hairline Strong border and Ink text. Hover moves to the Hover fill.
- **Mini (26px, 0 8px):** transparent with Ink Dim text and a Hairline Strong border. The approve and danger variants tint the text and border, then fill with the matching wash on hover. The ghost variant drops the border. Square 26px minis carry the row actions, which sit at 55% opacity until the row is hovered or selected.
- **Icon (30px square), text-link (Approve-fg, underline on hover, 3px offset), split action** (a joined caret with a hairline divider).

### Status pills
A 20px pill with a 6px dot, a mono 10.5px label, a 32% state-tinted border and the state's wash. Variants: approved, passed or completed (green); pending or queued (amber); needs-review or blocked (amber, dashed, no fill); failed or rejected (coral); archived, canceled or skipped (muted, hollow dot); running (Ink, pulsing dot at 1.2s). The count variant drops the dot and uses tabular figures. Inside lane meta the pill shrinks to 17px.

### Chips
A 20px chip at 5px radius with a Hairline Strong border, a Raised fill, Ink Dim text and 11px type. Module chips use Ink. Tag chips are mono. A 14px remove x sits inside the chip.

### Cards / Containers
- **Corner Style:** 8px for panels, lanes and tables. 10px for the rail, the inspector and modals.
- **Background:** Panel. Headers and footers inside a container use Raised.
- **Shadow Strategy:** the panel edge only (see Elevation & Depth).
- **Border:** a 1px Hairline. The inspector, modals and menus use Hairline Strong.
- **Internal Padding:** 16px for panels. Flush panels put their 12px by 14px heading on a hairline and let their rows run edge to edge.

### Inputs / Fields
- **Style:** 32px tall, 0 10px padding, a Sunken well (Panel in light), a Hairline Strong border, 6px radius and 13px text. Labels sit above in a 6px grid at 12px/500 Ink Dim. Hints are 11.5px Muted.
- **Dropdowns:** no native `<select>` in the app. Use `Select` (`components/select.tsx`) for fixed lists and `SearchableSelect` for long or user-created lists. Both use the same 32px trigger as inputs with a 14px chevron, and a Panel listbox with Hairline Strong border, 8px radius and the Pop shadow. The selected option carries a green check. The menu is pinned to its trigger with `position: fixed` (`useAnchoredMenu`), so it never clips inside modals, the inspector or panels. It flips above the trigger when there is no room below and shifts left rather than overflowing the viewport. Keyboard: arrows, Home/End, type-ahead, Enter/Space, Esc. In forms, `name` plus `defaultValue` submits through a hidden input.
- **Focus:** the border turns Approve Green with a 3px ring of the same green at 18%. Keyboard focus anywhere is a 2px Approve outline at 2px offset.
- **Error / Disabled:** errors use a coral-washed message block (12.5px, 8px by 10px padding, 6px radius). Disabled and read-only fields sit at 60% opacity.

### Navigation
The sidebar sits on Sunken (Raised in light) with the brand mark and name, a project switcher (a 7px-radius Panel button with a mono branch subline and a popover menu), then 30px nav rows: 13px/500 Ink Dim text with Muted icons. Hover fills with Hover and Ink. The active row sits on Raised with a 1px inset hairline and an Approve-colored icon. The account row sits at the bottom behind a hairline, with a mono-initial avatar, theme toggle and sign-out. Under 860px the sidebar becomes a 280px drawer behind the scrim.

### Lifecycle Rail (signature)
Five hairline-divided stages inside a 10px Panel frame. Each stage holds a 9px node (filled green when done, amber when waiting, coral when failed, pulsing Ink when live, hollow when idle), a mono 11px stage name with a chevron, a 24px mono figure, a 12px Ink Dim detail line, and the stage's own action at the foot: Analyze, Regenerate (split), Open review queue, Run approved, All executions. The same vocabulary repeats as the library's lifecycle tabs (mono label, dot and 18px figure, with a 2px Ink underline on the pressed tab) and as the executions and projects summary strips.

### Lanes and Inspector (signature)
Lanes are 8px Panel columns, each with a 38px head (state dot, 12.5px/600 name, mono count) and a 4px-padded body of 6px-radius rows: a checkbox, a two-line-clamped 12.5px title, and a mono meta line (priority, category, version). The selected row gets Raised plus a 2px Ink inset rail. Checked rows get a 6% green tint. The inspector stacks a header (status, meta, j/k keys, 15px title, chips), a scrolling body (detail grid with 1px gaps, numbered mono step list on Sunken, expected-result block), and a Raised footer that carries Approve (a), Reject (r) and Edit. It slides in from 10px over 200ms.

### Segment Bar (signature)
A 6px proportional run bar with 2px gaps: pass green, fail coral, running Ink at 55%, queued Hairline Strong, and an empty run as a single Hairline segment. It carries an aria-label with the counts and animates `flex-grow` over 320ms.

## Do's and Don'ts

### Do:
- **Do** show any approval state as a dot plus a mono label, colored only by approve, pending, change or AI grey.
- **Do** attach each action to the stage it moves, under its count on the rail, rather than in a generic toolbar.
- **Do** open record detail in the right inspector beside the list, with j/k/a/r/Esc, and keep its decision footer in view.
- **Do** separate resting surfaces with 1px hairlines and the ground, panel and raised steps. Use the pop shadow only on layers that float.
- **Do** set SHAs, branches, counts, steps and code in JetBrains Mono with tabular figures, and everything else in Schibsted Grotesk.
- **Do** define every color through the theme tokens so dark and light stay role-for-role.
- **Do** keep motion to 120 to 220ms ease-out on state changes, `cubic-bezier(0.16, 1, 0.3, 1)` for things that enter, and honor reduced motion.

### Don't:
- **Don't** build stat-card dashboards, icon tiles or hero numbers in floating cards. Counts live on the rail, the tab strips and the summary strips.
- **Don't** use a verdict color for decoration, branding or emphasis that isn't a state or the gate's forward action.
- **Don't** put drop shadows on resting panels, rows or cards.
- **Don't** use decorative color gradients or translucent, blurred panels. The skeleton shimmer, the auth gutter rules and the sticky commit bar's 92% backdrop are the only gradient and translucency in the system.
- **Don't** nest a bordered box inside a panel. Bleed the list to the panel's edges.
- **Don't** set sentences, labels, column heads or buttons in mono, or use any weight above 600.
- **Don't** add page-load choreography or staggered entrances. Animate only when state changes.
