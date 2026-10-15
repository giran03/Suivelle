# Node Map

Implementation order: scoped graph metadata and renderer validation; global navigation;
focused exploration; explicit, undoable relationship editing.

The map derives its content from workspaces, live pages, page references and database relations.
Workspace summaries load first. Records are opt-in, and page searches query all matching
metadata rather than only the clusters currently expanded. Query results explicitly report
truncation, with a maximum of 5,000 page nodes and bounded reference/relation edges.

Workspace anchors do not participate in page-neighborhood traversal. Tags group pages without
inventing links, and a relation becomes a dependency only when the user chooses that property.

Nodes use stable identifiers. Layout positions and camera bookmarks are navigation preferences,
separate from page content. New rendering dependencies load only when opening the map.

Validation uses bounded scope/search tests, deterministic layout tests, frontend typechecking,
Rust tests, and interactive rendering checks. Performance claims require hardware measurements;
the UI must remain usable through a list when WebGL is unavailable.

## Using the map

Open **Node Map** from the sidebar or command palette. Start with workspace summaries, then
expand a workspace or add another alongside it. Search covers every workspace, including pages
outside the current render limit. Select a node for its preview and connections. **Open beside**
keeps the map visible; **Open in main view** returns to the regular editor. Page neighborhoods
follow actual references across workspaces and offer one, two or three hops.

Layouts include workspace clusters, hierarchy, organic links, a chosen record property, and a
chosen date (creation date by default). Property groups show their values and counts. Undated
items occupy a separate region beyond the latest dated item. Node identity keeps deterministic
layouts stable; organic layouts do not rerun merely because a title or paragraph changed.

**Move and pin** drags in the camera plane. Use **Unpin position** to release a node. **Box select**
selects visible nodes; Ctrl/Cmd+click toggles individual selection. Named views preserve scope,
layout, record visibility, search and camera. Following the active page is optional.

For content changes, open **Edit connections and selected pages**, or use the **Connect** tool
to choose the source and target. Pick the relationship and press **Apply connection**. References
append a mention paragraph to the source; nesting changes the parent; relations use an existing
database property. Choosing **Source blocks target** explicitly classifies that property as a
dependency in the map and rejects dependency cycles. Tags append hashtag paragraphs, while bulk
property edits operate on 1–100 records from the same database. These controls are absent in
read-only mode; browsing and device preferences remain available.

Map content edits use one transaction, save pending editors first, and maintain the existing
search/reference index and database automations. Undo and redo remain available during the
session, including after leaving the map. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z act on map edits when
focus is inside the map and outside text fields. Undo checks the affected paragraph, nesting
or cell value, and refuses to overwrite a newer change. Pin and camera preferences are separate
from content undo.

## Verification (14 October 2026)

- Frontend: typecheck, lint, production build, bundle budgets, and the full test suite.
- Rust: full library tests, plus transaction rollback, guarded undo/redo, hierarchy/dependency
  cycles, cross-workspace reference navigation, and 10,002-page scope/search coverage.
- The 10,002-page in-memory fixture returned its bounded 5,000-page snapshot and found an item
  outside that snapshot in approximately 64 ms on this development machine. This is a synthetic
  SQLite measurement, not a native interaction-latency guarantee.
- Chromium with software WebGL rendered 200, 1,000 and 5,000 page nodes without runtime errors.
  Once settled, each case produced zero animation-frame callbacks during a 500 ms idle sample.
- Interactive browser checks covered organic layout, saved views, opening the active page beside
  the map, dark/light themes and narrow split-pane layout. The fallback list virtualizes rows and
  supports arrow keys, Home and End.

Native WebView2 hardware FPS and battery measurements remain a release-validation task. The
rendering check used Chromium/SwiftShader; it does not establish 60 FPS on integrated laptops.

## Continuous auto-orbit

The orbit icon beside Fit remembers whether orbit is enabled. In 3D, the camera makes one slow revolution in about two minutes around the current target, preserving zoom and tilt. It starts immediately and keeps running through hover, mouse interaction, editing and menus until the icon is toggled off. 2D/list view, hidden windows and reduced motion suspend rendering; returning to eligible 3D resumes it immediately. Rendering is capped at 30 frames per second, and camera state is saved when orbit stops rather than on every frame.
