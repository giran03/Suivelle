---
name: Suivelle
description: A calm, midnight-blue local workspace where the document is the one lit instrument and a single starlight accent marks what matters.
colors:
  sapphire-fill: '#3b5ba9'
  sapphire-fill-hover: '#4a6bbf'
  sapphire-deep: '#2f4a91'
  starlight-ink: '#a9c4ff'
  sapphire-wash: '#15224a'
  sapphire-wash-light: '#e6edf9'
  brand-midnight: '#0b1226'
  brand-comet: '#7fa4f0'
  brand-starlight: '#cfe0ff'
  brand-navy: '#16275a'
  night-canvas: '#0c1329'
  night-sidebar: '#0a1022'
  night-surface: '#131c3a'
  night-floating: '#172243'
  night-field: '#0b1127'
  night-hover: '#172245'
  night-pressed: '#243257'
  starlight-text: '#e8edf8'
  starlight-dim: '#a4afc6'
  starlight-faint: '#94a0bb'
  paper-canvas: '#f7f6f2'
  paper-sidebar: '#eeeff0'
  paper-surface: '#ffffff'
  paper-hover: '#e9ecf1'
  paper-pressed: '#d8dde6'
  ink-text: '#151b2e'
  ink-dim: '#4f5a72'
  ink-faint: '#59647a'
  signal-green: '#62b886'
  signal-amber: '#e0a050'
  signal-red: '#ef6e62'
  tone-blue: '#6fb1e8'
typography:
  page-title:
    fontFamily: Segoe UI Variable Display, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 2.125rem
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: -0.02em
  welcome-title:
    fontFamily: Segoe UI Variable Display, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 2rem
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: -0.02em
  brand:
    fontFamily: Segoe UI Variable Display, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 1.0625rem
    fontWeight: 650
    letterSpacing: -0.01em
  doc-heading-1:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 1.875rem
    fontWeight: 700
    lineHeight: 1.25
  doc-heading-2:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 1.5rem
    fontWeight: 650
    lineHeight: 1.25
  doc-heading-3:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.25
  doc-body:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.45
  ui-compact:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 0.875rem
    fontWeight: 500
  section-label:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 0.75rem
    fontWeight: 600
    letterSpacing: 0.02em
  micro:
    fontFamily: Segoe UI Variable Text, Segoe UI, system-ui, sans-serif
    fontSize: 0.75rem
    fontWeight: 400
  code:
    fontFamily: ui-monospace, Cascadia Code, Consolas, monospace
    fontSize: 0.875rem
    lineHeight: 1.55
rounded:
  tiny: 4px
  compact: 6px
  control: 8px
  menu: 10px
  panel: 12px
  modal: 14px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  page-gutter: 56px
components:
  button-primary:
    backgroundColor: '{colors.sapphire-fill}'
    textColor: '#ffffff'
    rounded: '{rounded.control}'
    height: 32px
    padding: 0 12px
  button-primary-hover:
    backgroundColor: '{colors.sapphire-fill-hover}'
  button-secondary:
    backgroundColor: '{colors.night-surface}'
    textColor: '{colors.starlight-text}'
    rounded: '{rounded.control}'
    height: 32px
    padding: 0 12px
  button-secondary-hover:
    backgroundColor: '{colors.night-hover}'
  button-ghost:
    textColor: '{colors.starlight-dim}'
    rounded: '{rounded.control}'
    height: 32px
    padding: 0 12px
  search-field:
    backgroundColor: '{colors.night-field}'
    textColor: '{colors.starlight-faint}'
    rounded: '{rounded.control}'
    height: 34px
    padding: 0 8px 0 10px
  nav-row:
    textColor: '{colors.starlight-dim}'
    rounded: '{rounded.control}'
    height: 34px
  nav-row-selected:
    backgroundColor: '{colors.sapphire-wash}'
    textColor: '{colors.starlight-text}'
  menu:
    backgroundColor: '{colors.night-floating}'
    textColor: '{colors.starlight-text}'
    rounded: '{rounded.menu}'
    padding: 4px
  palette:
    backgroundColor: '{colors.night-floating}'
    textColor: '{colors.starlight-text}'
    rounded: '{rounded.modal}'
---

# Design System: Suivelle

## Overview

**Creative North Star: "The Quiet Observatory"**

A dark room built for looking at one thing. The instruments are put away or drawn in hairlines; the document is the lit eyepiece, and a single starlight accent marks what is selected, primary or in focus. Nothing in the interface competes with the writing, and nothing in it moves unless the user did something.

The system is dark-first and flat at rest. Depth comes from small steps in surface tone (canvas, sidebar, surface, floating) and from hairline borders tinted starlight blue at 7 to 20%, not from shadows or glass. Shadow appears only on layers that float: menus, the command palette, toasts, drag chips. The accent is sapphire, used sparingly: filled on the primary button, as starlight ink on selected icons, links and focus rings, and as a faint navy wash behind the selected row. It stays a signal, never a theme. The light theme is a faithful counterpart with the same structure: warm off-white paper, a cool blue-gray sidebar, and deep sapphire where the dark theme uses starlight.

The sky shows up in exactly three places: the mark (an S whose first stroke ends in a four-point star), the welcome screen (a few stars joined by hairlines around the mark), and the launch splash. Everywhere else the celestial idea is carried by colour and restraint alone. It is a desktop app, so controls are compact, type is 15px, and every spacing value derives from one interface-spacing setting (compact, normal, relaxed).

**Key Characteristics:**
- Deep navy canvas, a slightly darker sidebar, one tonal step per layer.
- One sapphire accent; starlight-blue icons mean selected or significant, never decoration.
- Hairline blue-tinted borders; stronger lines only for focus and active states.
- Flat by default; soft shadow reserved for floating layers. No glow, glass or decorative gradients.
- Compact, keyboard-first controls; actions appear on hover or focus instead of sitting permanently.
- The editor is the hero: no card around the document, an 840px column with 56px gutters (all adjustable in Settings).
- Appearance is the user's: accent colour, corner roundness, line strength, spacing, interface zoom, page font, size, width and spacing are all preferences, applied through tokens.

## Colors

A deep, cool navy with one sapphire accent and quiet status hues. Values below are the dark home theme; the light theme keeps the same roles (paper canvas, cool sidebar, white surface).

### Primary
- **Sapphire Fill** (#3b5ba9): the filled accent in both themes. Primary button fill, checked checkboxes, the brand star on light tiles. White text sits on it at about 6.4:1.
- **Sapphire Lift** (#4a6bbf): hover of the fill on dark. It lightens slightly while white text stays above 4.5:1 (5.1:1).
- **Sapphire Deep** (#2f4a91): in the light theme, both the hover of the fill and the accent as ink (links, selected icons, focus ring).
- **Starlight Ink** (#a9c4ff): the accent as text, icon and focus colour on dark surfaces (links, selected icons, focus ring, palette active icon, toast action). Passes 4.5:1 on every dark surface.
- **Sapphire Wash** (#15224a): the selected row, active footer row, active palette item, chip-on. A tint, never a block. Light theme: #e6edf9.

### Secondary
- **Comet Blue** (#7fa4f0) and **Starlight White** (#cfe0ff): the mark only. The S is comet blue and the star starlight white on the midnight tile (#0b1226); on the light tile the S is navy (#16275a) and the star sapphire. They are brand colours, not interface colours.

### Neutral
- **Night Canvas** (#0c1329): app and editor background.
- **Night Sidebar** (#0a1022): sidebar, one step darker than the canvas so the document reads as lit.
- **Night Surface** (#131c3a): cards, secondary buttons, kbd chips, database cards.
- **Night Floating** (#172243): menus, palette, popovers, toolbars, toasts. The lightest surface, because it is closest to the user.
- **Night Field** (#0b1127): inputs and search fields, recessed below their surroundings.
- **Night Hover** (#172245) and **Night Pressed** (#243257): opaque hover and pressed surfaces, opaque so sticky table cells never show content through.
- **Starlight Text** (#e8edf8): primary text. **Starlight Dim** (#a4afc6): secondary text, inactive nav. **Starlight Faint** (#94a0bb): placeholders, metadata, section labels.
- **Paper** (#f7f6f2 canvas, #eeeff0 sidebar, #ffffff surface, #e9ecf1 hover, #d8dde6 pressed) and **Ink** (#151b2e text, #4f5a72 dim, #59647a faint): the light theme's counterparts.
- **Hairline** (rgba(169,196,255,0.07) subtle, 0.12 default, 0.2 strong): borders on dark. Light theme uses rgba(21,27,46) at 0.07, 0.12, 0.2.

### Status
- **Signal Green** (#62b886), **Signal Amber** (#e0a050), **Signal Red** (#ef6e62): success, warning, danger on dark (light theme: #2a7348, #9b4f08, #b73426). Used as text, as 10 to 16% tints behind them, and as tone colours in databases and history diffs. Blue (#6fb1e8) joins them only as a data tone.

### Alternate accents
Settings offers Cyan, Violet, Green and Rose in place of Sapphire. Choosing an accent clears explicit button, link, selection, focus and keyword-color overrides in both palettes, so accent choices remain effective after applying a full palette preset. The brand mark does not change.

### Custom theme roles
The default visual world stays intact when no custom colors are set. Theme mode and palettes are application preferences shared by every workspace, including Workspace settings; switching workspaces preserves the current mode. Appearance can override separate light and dark palettes through semantic roles: app canvas (`--background`), sidebar (`--sidebar`), editor (`--editor-background`), toolbar (`--toolbar-background`), panels, menus/dialogs and fields. Editor and toolbar backgrounds inherit the canvas by default. Sidebar primary, secondary and muted text have independent roles (`--sidebar-text`, `--sidebar-secondary`, `--sidebar-muted`) that inherit the corresponding global text tokens by default.

Primary, secondary and muted text, button fill/text, accent ink, selection wash, hover/active backgrounds, button hover, focus ring, borders and status colors are also editable. Code backgrounds have their own role; Advanced includes syntax keyword, string, number, title and comment colors, plus gray, violet, red, orange, green and blue data/text tones. Canvas, sidebar and accent overrides derive sensible related states; explicit role overrides win. These preferences do not recolor the brand mark. Contrast warnings cover text/surface pairs and focus visibility; a suggested correction is an explicit user action.

Three full palette presets are available per mode: Midnight (navy/sapphire), Graphite (charcoal/soft blue) and Forest (evergreen/mint) for dark; Paper (warm paper/sapphire), Mist (pale blue/ink) and Sand (parchment/terracotta) for light. Selecting a preset replaces only the palette currently being edited and remains a draft until Apply.

**The Synchronized Theme Rule.** Settings, its header/footer, navigation and controls, confirmations, menus and workspace surfaces consume the same semantic theme tokens. Live preview reaches every UI surface. Accent fills pair with `--on-accent` rather than fixed white text, and focus/active outlines use `--focus-ring`. Color swatches and picker gradients represent selected content colors; the brand identity remains fixed.

### Named Rules
**The One Star Rule.** The accent covers roughly 5% of any screen. If a second thing glows, remove one.

**The Wash, Not Block Rule.** Selection is a tint plus brighter text plus an accent icon. Never a solid accent rectangle, never a coloured side stripe.

**The Opaque Hover Rule.** Hover and pressed surfaces are opaque tokens, not translucent overlays, so sticky headers and cells stay solid.

## Typography

**Display Font:** Segoe UI Variable Display (with Segoe UI Variable Text, Segoe UI, system-ui)
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui)
**Label/Mono Font:** ui-monospace, Cascadia Code, Consolas, for code and equations only

**Icon Font:** Suivelle Nerd Symbols, a locally bundled subset of Nerd Fonts 3.5.1 Material Design symbols. Use only through the shared `Icon` component or generated glyph variables for native control pseudo-elements. Never apply it to prose, user emoji, or branding. Fixed square boxes inherit semantic color; favorites use a separate filled star glyph. Existing semantic names and saved page/workspace choices remain stable. Rebuild and coverage instructions: `docs/icon-system.md`.

**Character:** The native Windows 11 variable fonts, so the app reads as part of the OS and bundles only its interface symbol font. Hierarchy comes from weight (650 titles, 550 selected, 500 controls) and from opacity steps, not from large size jumps. Page text can be switched to a serif or mono stack in Settings; titles and chrome keep their own face.

### Hierarchy
- **Page title** (650, 2.125rem, 1.2, -0.02em): the editable title above every page. The welcome title uses 2rem at the same weight.
- **Doc headings** (700/650/600 at 1.875/1.5/1.25rem, 1.25): block headings in the editor.
- **Body** (400, 1rem, 1.5): document text. Text size (Small to Extra large) and page spacing (line height 1.4, 1.5, 1.72) are preferences.
- **UI** (400, 0.9375rem, 1.45): the application chrome. Menus and dense controls drop to 0.875rem.
- **Section label** (600, 0.75rem, +0.02em, sentence case): "Pages", "Favorites", palette groups.
- **Micro** (400, 0.75rem): kbd hints, footers.

### Named Rules
**The Weight Over Size Rule.** Reach for weight, opacity or spacing before a larger size. The chrome never exceeds 0.9375rem; only titles go above 1.25rem.

**The Quiet Label Rule.** Section labels are sentence case, small, faint. No uppercase tracking, no eyebrows.

**The Tagline Rule.** "A universe for your thoughts." appears on the welcome screen and in About, in accent ink at body size. It is never a banner and never repeated on working screens.

## Layout

A two-column shell: a sidebar of `clamp(204px, 22vw, 272px)` (user-resizable) and a fluid main column. The main column is a topbar over a tab strip over a scrolling content area. Content is centred in a column of 840px (Narrow 680, Wide 1080, Full 100%) with 56px side gutters and 44px top padding; databases, dashboards and boards drop the cap and go full width.

All spacing derives from one multiplier, `--density`: 0.72 compact, 1 normal, 1.35 relaxed. List-row padding is 2, 6 and 11px; buttons are 24, 32 and 43px high; sidebar rows measure about 26, 34 and 43px; the topbar is 40, 52 and 60px; page gutters are 40, 56 and 76px. Menus, the palette, Settings, Files, Import and export, workspace dialogs and the bottom-left Trash to Settings group all follow it. Interface size (90 to 150%) zooms the whole webview on top of that.

The desktop sidebar collapses into a 56–76px icon rail (scaled by spacing density), preserving the workspace badge, search, page icons and utility actions with named tooltips. Collapse and expand arrows use the shared icon-swap animation and motion preferences; expanded width and collapse state are saved. The separate toolbar sidebar button fully hides or shows navigation, preserving its previous expanded or rail state and saving visibility. At 760px and below, full-width navigation and content take turns, preserving the desktop preference. The topbar adapts to its available content width, with search reduced to an icon and controls wrapping into two rows below 640px. Focus mode (Ctrl+Shift+\) hides the sidebar and fades the topbar until the pointer or keyboard returns to it.

Settings uses a viewport-bounded dialog (980px maximum width, 760px maximum height), a fixed header/footer and a 208px navigation column beside an independently scrolling panel. Navigation becomes horizontally scrolling tabs when the dialog or viewport is 700px wide or less; setting rows stack and controls can wrap. Below 440px, the miniature theme preview stacks its sidebar above the document. Flat rows and subtle dividers organize controls without enclosing each section in a card. The settings shell uses fixed readable padding while existing density-sensitive controls retain their preferences.

## Motion

Motion explains state and never decorates. The vocabulary is the transitions.dev set, run through one dial. `src/motion.css` holds the tokens (`--duration-*`, `--distance-*`, `--scale-*`, `--blur-*`, and the per-component ones such as `--modal-open-dur`), each multiplied by `--k-time`, `--k-dist`, `--k-blur` or `--k-scale`. Settings > Motion sets those four numbers, and `src/lib/motion.ts` keeps the same table for script-driven effects.

### Levels
- **System:** full motion, and the Reduced behaviour when Windows asks for less.
- **Subtle:** about 65% of the time and 60% of the distance, half the scale change, no blur.
- **Reduced:** nothing moves, scales, blurs or loops. Short fades (about 110ms) stay, so a state change or a confirmation never goes silent.

### Vocabulary
- **Modal and menus:** a dialog scales up from 0.96 in 250ms and leaves in 150ms; the scrim fades with it. Menus and popovers grow out of the point or trigger that opened them (97% to 100%) and leave at 99%.
- **Toast:** rises 16px with a 2px blur in 350ms, leaves in 250ms.
- **Selection:** one highlight slides to the selected item in segmented controls, the database view tabs (as the underline) and the open-page strip.
- **Controls:** the toggle thumb settles with a small overshoot (none when reduced); the checkbox fills, then the tick is wiped in; icons swap with a cross-fade and a blur; changed text and digits rise in.
- **Loading:** the 4x4 dot loader replaces "Loading…" text; placeholders breathe and loaded cards ease in; a status line shimmers while it works. Loops are still when reduced.
- **Feedback:** an invalid field shakes once; an error line fades in; the success check draws itself.
- **Layout:** dashboard widgets and page width tween their size; collapsible regions use a one-row grid so height is never measured.
- **Search fields:** clearing drops the typed words away blurred, with a soft streak under each, and the field is empty at once.

### Named Rules
**The Faster Exit Rule.** A thing leaves faster than it arrives. Dialogs 250 in, 150 out; menus 250 and 150; toasts 350 and 250; the tooltip 150 and 50.

**The One Dial Rule.** Every new animation takes its time, distance, scale and blur from the tokens, never a literal, so Subtle and Reduced reach it with no extra code. Anything that loops needs an explicit still state when reduced.

## Elevation & Depth

A tonal-layered system with shadow only for floating layers. At rest every surface is flat: depth is the step from sidebar to canvas to surface to floating, plus a hairline border. Shadows appear on things that detach from the page.

### Shadow Vocabulary
- **Float** (`0 14px 36px rgba(2,5,15,0.55)` dark, `0 10px 30px rgba(21,27,46,0.14)` light): menus, palette, popovers, toasts, drag chips.
- **Button lift** (`0 1px 2px rgba(0,0,0,0.45)` plus `inset 0 1px 0 rgba(255,255,255,0.14)`): the primary button only.
- **Scrim** (rgba(3,6,16,0.65) dark, rgba(21,27,46,0.32) light): behind modal dialogs, with no blur.

### Named Rules
**The Flat-Until-Floating Rule.** Layout containers never carry a shadow. If it does not float over content, it gets a tone step or a hairline instead.

**The Still Sky Rule.** No glow, no radial halo, no animated or drifting stars. The mark and the welcome constellation are static drawings.

## Shapes

Controlled, small radii and no pills. Tiny elements (kbd, inline code, input carets) use 4px; compact controls (icon buttons, menu items, chips) 6px; inputs, buttons, nav rows and cards 8px; menus and the workspace row 10px; panels 12px; the palette and modal dialogs 14px. The Corners preference rescales all six together (Sharp 2 to 8px, Round 6 to 22px). Borders are one-pixel hairlines, with a Lines preference (Soft, Default, Clear). The mark sits on a 22%-radius rounded square.

## Components

### Buttons
- **Shape:** 8px radius, 32px high, 12px horizontal padding, 0.875rem at weight 500.
- **Primary:** Sapphire Fill, white text, button-lift shadow with a faint top highlight. Hover lifts to Sapphire Lift on dark and deepens to Sapphire Deep on light. The hero CTA on the welcome screen grows to 40px.
- **Secondary (default):** Night Surface fill, default hairline, Starlight Text; hover moves to Night Hover with a stronger hairline.
- **Ghost:** transparent, Starlight Dim text, hover fills Night Hover.
- **Danger:** neutral until needed: red text on the secondary body, red tint and red-tinted border on hover.

### Search and inputs
- **Style:** Night Field fill, subtle hairline, 8px radius, 34px high, faint placeholder and a kbd hint on the right.
- **Hover:** hairline steps from subtle to default.
- **Focus:** a 2px `--focus-ring` outline at 75% opacity, starlight by default; inline title and palette inputs drop the ring and tint the icon instead.

### Navigation (sidebar page lists)
- **Style:** rows with 8px radius, a 16px indent per level and a hairline guide line down each nested list. Favorites, Recent and Pages are three ARIA trees, each a single Tab stop, with arrow keys, type-ahead, Enter and the menu key on the row.
- **Hover:** Night Hover; the row's action buttons (more, add page inside) fade in as an overlay at the right and are mouse-only, because the context menu carries the same actions for the keyboard.
- **Selected:** Sapphire Wash fill, brighter text at weight 550, starlight icon. Drop targets draw a 2px accent line or a 1.5px outline.
- **Footer rows:** Trash, Backups, Import & export, Settings, each with a trailing chevron.

### Brand mark and workspace row
The sidebar starts with a 10px-radius workspace row holding the badge, name and disclosure chevron; clicking opens the quick switcher. App branding lives in the desktop titlebar rather than repeating in the sidebar. The badge uses an existing symbol or a user emoji, or the mark itself by default. The window and taskbar icon swap between the dark and light tile to follow the theme.

Workspace settings is a native modal dialog (up to 780px) with a directory beside an editable profile, stacking at narrow widths. Save is explicit; dirty settings block switching and closing asks to discard. Deletion is a separate confirmation with content counts, a typed name, an optional export and a verified safety backup first.

Image replacement and removal share one action row that wraps when space is limited. Sidebar spacing is an icon-and-text segmented radio group: Compact, Normal and Comfortable apply vertical padding of 2, 5 and 8px to page and favorite rows. The selected option is the group's Tab stop; arrow keys move and select, and Home/End select the first/last option. This workspace preference is separate from app-wide interface spacing.

### Desktop titlebar
The main desktop window has a flat, themed titlebar (34px high) above the workspace. Its existing mark (18px) and Suivelle name (0.75rem UI type) sit at the left; the remaining space is a native drag region that also supports double-click maximize/restore. Three permanently visible window controls (46px wide each) sit at the right. The titlebar remains mounted when switching workspaces; browser previews and Quick Capture have no added titlebar.

The surface uses `--toolbar-background`, a `--border-subtle` hairline and `--text-primary`; the name dims to `--text-secondary` when the window loses focus. Controls use `--surface-hover` and `--surface-active`, with `--danger` text and a danger tint for Close. Keyboard focus uses the shared `--focus-ring`, inset within each control. There are no titlebar animations or additional palette primitives. Minimize and Close respect the existing tray preferences; Maximize switches to Restore when maximized. The maximize button does not provide the Windows hover Snap Layout menu.

### Menus and palette
- **Menu:** Night Floating, hairline, 10px radius, Float shadow, 0.875rem rows with 6px radius and a hover tone; separators are hairlines; danger rows are red text. Opens with a 180ms fade and 4px rise.
- **Palette:** 600px wide, 14px radius, scrim without blur. The active result is a Sapphire Wash row with a starlight icon; group headings are quiet labels; a footer lists the keys.

### Tooltips
One bubble for the whole app, using the transitions.dev tooltip motion. It rests on a `title` or `data-tooltip` attribute: any control that has one gets the tooltip, so nothing else needs wiring. The pointer must rest for 350ms before it appears (keyboard focus shows it at once); it then fades and scales in from 0.98 over 150ms after an 80ms delay, and leaves in 50ms. Moving to a neighbouring control while it is showing makes the same bubble travel and resize to the new target over 160ms instead of popping a second one. It sits centred above the control, or below when there is no room, stays inside the window, and wraps beyond 280px. The surface is Night Floating with a hairline ring and the Float shadow, 8px radius, 0.8125rem text; a trailing shortcut such as "(Ctrl+B)" is drawn as a small key chip. It rises above open dialogs and hides on click, scroll, Escape and resize. The native `title` is borrowed while the bubble is in play and given back afterwards, and an icon-only control keeps an accessible name throughout.

### Settings
One modal dialog with eight left-side pages: Appearance, Layout and motion, Editor, Window and startup, Keyboard and capture, Data and backups, Updates, and About. A search field finds settings and opens/focuses the relevant control. Tabs use roving keyboard focus and associated panels; narrow dialogs put the tab strip above the content. Selected tabs use the established selection wash, brighter text and accent icon. Page headings are 1.125rem; controls retain the native UI type ramp.

Labels and explanatory copy in app Settings and Workspace settings do not select on drag; input, textarea and editable content text remain selectable.

Appearance contains accent presets, three full presets per palette mode and a precise theme editor, organized into Backgrounds, Text, Accent and Advanced roles. Each color row pairs a label with a swatch, exact hex field, picker and reset action. A miniature sidebar/document/toolbar/field/button composition previews the selected light or dark palette; optional live preview applies the draft throughout the app, including Settings. Apply persists the theme, Cancel restores the committed colors, and closing with pending changes offers Apply, Discard or Continue editing. Reset can restore one role or the selected palette. Named themes can be saved, loaded, duplicated, deleted and imported/exported as validated theme files. Palettes and profiles are device-local; System mode selects the palette without replacing either one.

Layout and motion contains density, interface zoom, corners, lines and motion. An optional switch beneath Corners applies the selected style to the native application window on Windows 11; it defaults off, persists per device, and restores system behavior when disabled. Maximized and snapped windows retain system-controlled square corners. Editor keeps text size, font, page width and spacing with a live reading sample. Existing startup, tray, capture, backup and update controls remain grouped by purpose. Segmented preference controls still come from one table. About retains the mark, name, tagline and version.

Updates sits before About, using the same rows and switches. The installed version, status and primary action lead; when a verified download is ready, Install and restart appears beside the status, including at the minimum window size. Errors remain inline and download progress uses a native progress element. The palette opens and focuses this section. The changelog is a separate native dialog with version/date, plain readable headings and lists, a scrolling body, and a fixed Continue/Back to updates action. Settings closes before the changelog opens. Automatic presentation waits for a restored workspace and a visible, non-minimized native window; it never raises a hidden tray launch.

### Backups

The existing modal groups backup actions, the daily schedule, retention and saved backups. Automatic retention uses a labeled numeric input (default 3, whole numbers from 1 to 1,000) with an adjacent explicit Save button. The field reuses the theme's field surface, border, small radius and control height; the group uses 6px vertical gaps and 8px between input and action. Supporting text explains that cleanup follows the next successful automatic backup and preserves manual and safety backups. The saved policy applies across workspaces, including newly created ones.

### Welcome state
A centred column: the mark at 64px inside a constellation of seven stars joined by hairlines, the welcome title, the tagline in accent ink, one supporting line, the 40px primary action, a row of secondary actions for features that exist, and kbd hints. Understated, never a marketing hero.

### Tab strip
- **Style:** a strip under the topbar, its height set by the interface spacing (32 to 51px, 38 at normal). Tabs are 190px wide at most and 96px at least, with an 8px top radius, 0.8125rem text, a page icon and a close button.
- **Idle and hover:** muted text; hover fills Night Hover and lifts the text one step.
- **Active:** the tab takes the surface colour, full-strength text, an accent icon and a 2px accent underline inset along its bottom edge. The close button shows only on the active or hovered tab, or on keyboard focus.
- **Drag:** while a page is dragged from the sidebar, a dashed accent strip appears over the tab strip as the drop target and the strip gains a faint accent underline. Tabs reorder by dragging and use roving focus with arrow keys.

### Database toolbar and grid
- **Toolbar:** a wrapping row of text buttons above the table (view, filter, sort, properties), each a 6px-radius button with an icon and a label. Hover fills Night Hover; open or active shows Sapphire Wash. A filter or sort in use adds an accent count badge (white text on the accent fill). The row total sits at the far right in tabular figures.
- **Grid:** full width with 24px gutters, hairline cell borders, a sticky header and sticky first column on the canvas colour, and rows whose height follows the interface spacing (28 to 46px, 34 at normal). The active cell has a 2px accent outline; editing swaps the cell for an input with the same outline. Numbers right-align in tabular figures. Selection uses Ctrl+Space and Ctrl+A with a live-region announcement, and a bulk bar appears as an arrow-key toolbar.

### Dialogs
- **Shape:** native modal dialogs on Night Floating, 14px radius, hairline border, Float shadow, a blur-free scrim, opening with the same 180ms fade and 4px rise as menus. Width is set by purpose (palette 600px, Settings 980, Files 720, workspace and shortcuts 780) and never exceeds the viewport minus 32px.
- **Structure:** a header row with a title and a close icon button, a body that scrolls on its own, and a footer or action row where needed. Padding, row height and gaps all follow the interface spacing.
- **Rows:** settings-style rows are a label and hint on the left and one control on the right, separated by subtle hairlines; they stack at 520px and below.
- **Focus:** opening moves focus into the dialog, Escape closes it (or asks to discard when there are unsaved edits), and focus returns to the control that opened it.

### Side surfaces (0.1.4)
- **Outline:** a floating card (232px, 12px from the right edge, below the topbar) on Night Floating with a hairline and Float shadow. Headings indent 14px per level; the section in view is full-strength and semibold, the rest muted. A hairline-separated footer gives words, characters and reading time in tabular figures. It stays clear of the side peek.
- **Side peek:** a full-height panel from the right (46vw, 340 to 640px) on the canvas colour with a hairline left edge and Float shadow. Its header holds the page glyph, the title, Open in the main view and Close. Below 960px wide it covers the page instead of squeezing it.
- **Explore dialog:** one native dialog for reminders, tags and the link graph, sized like the palette (560px) and widened to 960px for the graph. Rows reuse the palette's row shape; tags are pill chips with a muted count, the chosen one on Sapphire Wash. The graph draws on a bordered canvas in theme colours (hairline links, muted nodes, the current page in accent) and always offers a list view.
- **Storage health:** a definition grid of sizes and counts (auto-fill columns of at least 170px) followed by a wrapping row of actions; destructive or writing actions are disabled when the app is read-only.
- **Safe-mode banner:** a full-width strip at the top of the main area on a 12% warning wash, with the reason in plain words and two actions (Export workspace, Backups). It never hides content.

### Editor

The slash catalog and both block context menus share Toggle list, Toggle headings 1–4, and Tabs. Toggle conversions retain rich summary text and nested content. Tabs use themed selected washes, a keyboard navigable tab strip, editable labels, and one visible content panel. Turning a block into Tabs preserves it in the first panel; exported documents read all panels in order.
No card around the document. Blocks sit on the canvas with spacing from the page-spacing preference; code and callouts use Night-tone surfaces with hairlines; checkboxes are 16px, 6px radius, accent-filled when checked; links are Starlight Ink (Sapphire Deep on light).

## Do's and Don'ts

### Do:
- **Do** express every colour through the semantic tokens (`--background`, `--surface-1`, `--surface-2`, `--text-primary`, `--accent`, `--accent-ui`, `--border`, `--brand-*`) and `light-dark()`; never hardcode a hex in a component.
- **Do** use `--accent-ui` for accent text/icons, `--focus-ring` for focus/active outlines, and `--accent` with `--on-accent` for fills and their text.
- **Do** size spacing from `--density` and the derived tokens (`--row-pad`, `--ctl-h`, `--page-pad`), so every spacing preference reaches the new component.
- **Do** keep chrome type at 0.9375rem or smaller and pick radii from the six-step scale through `--r-*`.
- **Do** reveal secondary actions on hover or focus-within, and keep them keyboard reachable some other way (a menu or shortcut).
- **Do** give every control that needs a hint a `title` (or `data-tooltip`) and let the shared tooltip show it; never build a one-off tooltip or rely on the browser's own.
- **Do** take every duration, distance, scale and blur from the motion tokens in `src/motion.css`, keep exits faster than entrances, animate opacity, transform and small bounded blurs only, and give anything that loops a still state for Reduced.
- **Do** check any new accent or surface colour against the contrast tests in `src/tokens.test.ts` and `src/stores/preferences.test.ts`.

### Don't:
- **Don't** make selection a solid accent block or add a coloured side stripe to rows or cards.
- **Don't** add shadows to layout containers, or glow, blur and glass as decoration.
- **Don't** wrap sidebar sections, settings or paragraphs in cards; use spacing, tone and alignment first.
- **Don't** use gradient text, gradient borders, glowing buttons, animated gradients or drifting stars.
- **Don't** place the editor inside a card or cap its column below about 680px.
- **Don't** put a kicker or uppercase eyebrow above headings; sentence-case section labels only.
- **Don't** repeat the tagline on working screens, or recolour the mark with an accent choice.
- **Don't** invent product features to fill a mock; style the real ones.

### Emoji selection

Page and workspace icon pickers share the offline Unicode Emoji 17.0 catalog: 3,944 fully-qualified sequences in the nine standard categories. Search matches readable names, subgroups and emoji sequences; native category selection narrows results. Eighty buttons render per page, with named, selected and disabled states. The catalog loads only when an emoji picker opens. Filters, selected washes, fields and corners use existing semantic tokens. Multi-codepoint families, skin tones and flags are stored intact. Emoji glyph appearance follows the device's installed emoji fonts. Unicode data attribution and license live beside the bundled catalog.

### Background color opacity

Theme background roles and selection background support optional hex alpha (#RGBA or #RRGGBBAA). Their color picker provides a native 0–100% opacity slider and editable percentage, with a checkerboard preview. RGB/HSV edits preserve alpha; Use color updates the draft, and Apply persists it. Theme profiles and import/export retain alpha. Text, icon, button, hover and pressed colors retain opaque validation. Alpha reveals underlying app surfaces; it does not enable native desktop transparency. Derived colors and contrast estimates composite translucent backgrounds over the app background, with the webview's white canvas as the final backdrop.

### Shortcut settings

The Shortcuts and input panel uses flat action rows grouped by execution context, wrapping binding chips and named Add/Disable/Reset controls. Recording is an inline focusable field with a live input preview, manual input selectors, conflict feedback and explicit Save/Cancel controls. The input detector uses the same field treatment. Settings and the reference sheet support wrapping alternatives; a zero-minimum grid track prevents high-zoom overflow. All surfaces, borders, type and density derive from existing semantic tokens.
