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
