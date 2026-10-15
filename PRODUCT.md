# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Tauri 2 desktop shell + Rust backend + React/TypeScript/Vite frontend (TipTap/ProseMirror planned for the editor, Zustand for state), SQLite with FTS5. Platform is recorded as `web` because the UI is a webview with a custom (non-native-widget) design language; it ships as a Windows-first desktop app.

## Users
Solo knowledge workers and developers organizing notes, tasks, wikis and project data privately on their own machine, including game developers and creative-project makers (game-dev wiki, bug tracker, content calendar templates). Single-user today; self-hosted multi-device sync is a later possibility, not a current audience.

## Product Purpose
A local-first, offline workspace built on a few primitives: pages made of blocks, and databases with records, properties, views, relations and formulas. Tasks, projects, wikis, CRM, forms, dashboards and automation are templates over those primitives. Success: the user's whole workspace opens fast, works with zero network, and can always be exported, backed up and restored.

## Positioning
Local-first and private, and native-fast: data lives in a folder the user owns, no account is needed, core features work fully offline, and it should feel like a native desktop app rather than a hosted web app wrapped in Tauri.

## Operating Context
Used daily on a desktop, in long editing sessions, with large workspaces (design target 10,000+ pages, 100,000+ blocks, 50,000+ records). Keyboard-driven use (Ctrl/Cmd+K command palette, slash menu, markdown shortcuts). Data in SQLite (WAL) plus content-addressed attachments on disk.

## Capabilities and Constraints
- Windows x64 NSIS installations support signed stable GitHub updates: automatic checks and background downloads, explicit installation after strict saving and a verified installation-data backup, and an offline changelog with one-time presentation after an upgrade. Device-level update choices are separate from workspace preferences. Development, standalone, MSIX, and showcase copies do not invoke the NSIS updater. Publishing requires the matching updater signing secret; existing releases without updater support need a manual bootstrap install.
- Phases 0-11 implemented (measured optimization results and remaining budgets in `.plans/phase_11_performance.md`): import (Markdown, text, HTML, CSV, folders of notes, Suivelle archives, with a preview first) and export (page to Markdown or HTML, database to CSV, whole workspace to a readable zip), plus: local automation (per-database triggers, conditions and actions with loop protection, button properties, schedules and date triggers while the app is open, desktop notifications, a run log), plus: charts (bar, line, area, pie, donut, number), forms, a feed view, per-database record templates and dashboards of live widgets with shared filters, plus: page version history with preview and restore, verified local backups with automatic daily rotation and safe restore, image thumbnails, plus: project-management templates (Project Manager, Task Tracker, Software Project: tasks, subtasks, dependencies, projects, milestones, sprints, backlog and live progress, from a "New from template" gallery), plus: advanced databases (multiple named views per database: table, board, list, gallery, calendar and timeline; grouping with one subgroup level; two-way relations and rollups; a formula language with live preview), plus: databases (17 property types, sorts and AND/OR filters, keyboard-editable virtualized grid, records as pages), plus: Ctrl/Cmd+K palette (page and text search with snippets, recents, core commands, date and title filters), @ page mentions, internal page links, backlinks and jump-to-block, plus: block editor (slash menu, selection toolbar, gutter handle, drag/drop, markdown shortcuts, undo/redo, block transforms, toggles, callouts, code, equations, simple tables, media blocks via a minimal attachment core), plus: multiple local workspaces (create, switch, rename, custom icons/colors/descriptions, workspace-specific appearance, remembered last-opened page, protected deletion with a verified safety backup), nested pages with drag/drop and menu-based reordering, favorites, trash with restore and permanent delete, breadcrumbs, back/forward history, plain-text blocks with autosave, light/dark/system theme. Roadmap in `.plans/notion_tauri_rust_ai_agent_plan.md` (editor, search, databases and views, files/history, automation, import/export).
- Rust owns persistence and domain logic; frontend has no SQL, filesystem or shell access.
- Portable workspace transfer creates a separate workspace by default, with preview, collision-safe naming and optional appearance restoration. ZIP archives include content, files, page/workspace metadata, templates, views, dashboards and automation definitions; automations import paused. Version 1 archives remain readable. Workspace export saves pending edits first and refuses missing/corrupt files; incomplete imports roll back. Trash, page history, backup archives and automation run logs are excluded; full installation recovery remains in Backups.
- Excluded: any third-party service integration, cloud accounts, public hosting. Deferred: sync, collaboration, in-app AI models, mobile.
- Local AI agents (Claude Code, Codex and other MCP clients) may connect over an opt-in loopback agent API with per-agent tokens, scopes and modes (propose, auto, write); the app hosts no models and never starts agents. Agent changes are changesets the user can review and revert, and an opt-in per-workspace Markdown mirror exposes the workspace as plain text (see `docs/agents.md`). Settings > Agents can connect detected agent apps by adding one `suivelle` entry to the app's own MCP config, only after the user confirms the exact file, keeping a backup and touching nothing else in it.
- Virtualize and paginate large lists; typing and scrolling target 60 FPS.

## Brand Commitments
Name: Suivelle. Tagline: "A universe for your thoughts." Used on welcome, onboarding and About surfaces, not on every screen. Must not copy Notion branding, assets, or visual identity, and stays independent of the artist that inspired the name. Direction: celestial and restrained (stars, comets, constellations) in midnight navy, cosmic blue and muted sapphire with starlight blue, pale cyan and silver accents; warm off-white light theme. No glow, glass or decorative gradients. Logo: an S made of two half circles with a four-point star where it begins, centred as a whole. Masters and every raster size are generated by `brand/suivelle/build_icons.py` (dark, light and one-colour variants; the old Nested Mantle masters stay in `brand/logo/`). The app swaps its window icon (and with it the taskbar button) to the dark or light variant to match the theme; the installed file icon is fixed at build. Internal identifiers use Suivelle: app.suivelle.desktop, `suivelle.*` storage keys, `suivelle://page/` links and the suivelle-archive format tag. Compatibility helpers reuse existing installation data, migrate older storage keys, and continue reading older links and archives. Trademark clearance not checked. Voice is undecided.

## Evidence on Hand
No testimonials or customer claims exist; none should be fabricated. Synthetic performance measurements and their limits are recorded in `.plans/phase_11_performance.md`; they are not guarantees of native interaction latency. The Nested Mantle logo kit in `brand/logo/kit/` (symbol variants, favicon and web icon set); it replaced the earlier placeholder "T" icon.

## Product Principles
1. Local-first: the user's data is theirs, recoverable, and never needs the network.
2. Few primitives, many features: reuse pages/blocks/databases rather than special-case engines.
3. Native-fast over decorative: speed and responsiveness are part of the product feel.
4. Never lose user data: soft delete, history, backups, safe-mode before refusing to open.
5. Distinct from Notion in identity, not just in implementation.

## Accessibility & Inclusion
Target: WCAG 2.1 AA for contrast and keyboard operability; keyboard use is a core mode, not a fallback.
- Contrast is enforced by `src/tokens.test.ts`, which reads the real tokens in both themes: text at 4.5:1 on every surface, the focus ring at 3:1, white text on the primary button (and its hover) at 4.5:1.
- Every interactive control has a name, and icon-only buttons carry `aria-label`. Dialogs are native `<dialog>` elements (focus trap, Esc, focus return).
- Composite widgets follow their ARIA patterns: tabs (roving tab stop, arrows, Home/End), toolbars (arrow keys), the database grid (keyboard row selection with Ctrl+Space and Ctrl+A, announced through a live region).
- `prefers-reduced-motion` turns off all transitions and animations.


## Shortcut customization

Settings > Shortcuts and input supports per-device keyboard and delivered mouse-button bindings across workspaces, modifier combinations, physical/logical keys and numpad identity, alternative bindings, conflicts, disable/reset, and input diagnostics. Commands retain their editor/tree/grid/tab/capture contexts and read-only restrictions. Intrinsic typing, focus navigation, cancellation, and drag/resize behavior remain built-in. Wheel, modifier-only and advanced gesture bindings are deferred; hardware buttons hidden by a driver are not advertised as supported.
