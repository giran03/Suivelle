# Notion import and export — implementation plan

Status: **implemented** (phases 1–9) on top of `main` @ `b3ef92c` (v0.1.3). See *Implementation
notes* at the end for what differs from this plan and what still needs checking against real
Notion exports.

## Goal

1. **Import** any Notion export — *Markdown & CSV*, *HTML* or *PDF* — as a zip, an unzipped folder or
   single files. Detect it automatically (no "Notion" button) and rebuild it as Suivelle pages,
   databases, records, relations and attachments, either inside the current workspace or as a new
   workspace.
2. **Export** pages, databases and subtrees in a layout that Notion's own importer understands and
   that Suivelle re-imports losslessly enough. The dialog mirrors Notion's dialog: *Export format*
   (PDF — single page only, HTML, Markdown & CSV), *Database views*, *Page content*,
   *Include subpages* and *Create folders for subpages*.

## What already exists (reuse, don't rebuild)

| Piece | Where | Reuse for |
|---|---|---|
| Two-phase import: `stage_*` → `Preview` → `apply` in one transaction, sessions keyed by id | `src-tauri/src/transfer/import.rs`, `commands/mod.rs` (`import_pick`, `import_apply`, `import_cancel`) | Notion staging plugs in as another `stage_*` front end producing the same `Staged` |
| Markdown parser/renderer | `transfer/markdown.rs` | Notion `.md` bodies (with pre-processing for Notion quirks) |
| Generic HTML parser/renderer | `transfer/html.rs` | Base for the Notion HTML dialect |
| CSV reader, type detection, column plan, value parsing | `transfer/csvio.rs` | Notion CSVs (with Notion-specific value parsers added) |
| Block model `Blk` / `Inline` / `Media` → block rows | `transfer/blocks.rs` | Everything converts into this |
| Content-addressed attachment store, `insert_attachment_in` | `files/` | Images and files in exports |
| Exporter (Markdown/HTML, assets folder, subpage folders, CSV per database) | `transfer/export.rs` | Notion-layout export is an extension of it |
| Zip read/write helpers, zip-slip-safe name check (`clean_name`) | `transfer/archive.rs` | Reading Notion zips, writing export zips |
| Transfer dialog (Import / Export tabs, column-type overrides) | `src/features/transfer/TransferDialog.tsx` | New export form, Notion badge and destination choice |
| `pdf` block type | `domain::BLOCK_TYPES` | PDF import |
| Relations (`relations::create_relation`, `targetDatabaseId`) | `databases/relations.rs` | Rebuilding Notion relations |

Gaps in the data model that limit fidelity. These are accepted losses for v1 and become warnings:
no text colour or highlight marks, no bookmark or embed block, no callout emoji (only `tone`), no
"person" or "files" property types. Rollups and formulas are imported as **text snapshots**,
because Notion exports only their values, not their definitions.

## Notion export formats (what we must read)

> These come from Notion's undocumented export behaviour. **Step 0 captures real fixtures and
> every rule below is verified against them** before code relies on it.

Common to all formats:
- Each file and folder name ends with the block id: `Page Title 0123456789abcdef0123456789abcdef.md`.
  This **32-hex id is the stable key**. Use it for hierarchy, links and relations rather than
  relative paths, which Notion sometimes gets wrong.
- Large exports are **nested zips**: `Export-<uuid>.zip` → `Export-<uuid>-Part-1.zip`, `-Part-2.zip`…
- Workspace exports may wrap content in a top folder (e.g. `Private & Shared/`, teamspace names).
- *Create folders for subpages* **on** puts a page's children in `Title <id>/` next to `Title <id>.md`.
  **Off** writes everything flat, so hierarchy can only be recovered from links in the parent.

**Markdown & CSV**
- Page: `# Title` then body. Callouts come out as raw `<aside>💡 text</aside>`, equations as `$$…$$`,
  to-dos as `- [ ]`/`- [x]`. Toggles become plain list items with children, and columns are flattened.
- Subpage and link-to-page: `[Title](Title%20<id>.md)` (percent-encoded relative path).
- Database: `DB <id>.csv` (current view's rows) and `DB <id>_all.csv` (all rows). Each row with a body
  becomes `DB <id>/Row <id>.md`, starting with `# Row` followed by `Property: value` lines.
- CSV values: UTF-8 with BOM. Dates look like `October 12, 2026`, `October 12, 2026 3:00 PM` or a
  range `A → B`. Checkboxes are `Yes`/`No` and multi-select is comma-separated. Relations look like
  `Row A (../Other%20DB%20<id>/Row%20A%20<id>.md), Row B (…)`. People appear as names, and files
  as encoded paths or URLs.

**HTML**
- `<article id="<uuid>" class="page sans">`, `<header>` with `.page-header-icon`, `img.page-cover-image`,
  `h1.page-title` and `table.properties` (rows `tr.property-row-<type>`), then `div.page-body`.
- Block classes include `ul.to-do-list` + `.checkbox-on/off`, `figure.callout` (`.icon` + body),
  `ul.toggle > li > details`, `div.column-list > div.column`, `figure.equation` (TeX in
  `annotation[encoding="application/x-tex"]`), `figure.link-to-page`, `figure.bookmark`,
  `nav.table_of_contents`, `pre.code > code.language-*`, `mark.highlight-*` and `.block-color-*`.
- **No CSV**: a database is `DB <id>.html` holding `table.collection-content`. Each column header
  carries a type icon (`svg.typesSelect`, `typesDate`, `typesRelation`…), and each row links to its
  row page, whose `table.properties` holds the values.

**PDF**: single page only, with no recoverable structure.

## Architecture

### Back end: `src-tauri/src/transfer/notion/`

```
notion/
  mod.rs        entry points: detect(), stage(); shared types
  vfs.rs        virtual file set over a dir OR a (nested) zip; id index
  names.rs      strip/parse " <32hex>" suffixes, percent-decoding, Notion date/bool/list parsers
  tree.rs       hierarchy: folder pairing by id, flat-layout inference from links, wrapper folders
  md.rs         Notion Markdown dialect → Blk (pre-process <aside>, property header, links)
  html.rs       Notion HTML dialect → Blk (class-aware, delegates generic tags to transfer::html)
  database.rs   database model from CSV (_all preferred) or collection-content + row properties
  relations.rs  second pass: resolve row references → record ids
  tests.rs
  fixtures/     sanitized real exports (Step 0)
```

**1. `Vfs`, one input abstraction.** A list of `VEntry { rel_path, size, source: Disk(PathBuf) |
Zip(part, index) }`, built from a folder walk, one zip or nested zips (recursing into inner
`*.zip` entries one level deep). It enforces the existing zip-slip check (`archive::clean_name`)
and limits (`MAX_DOC_BYTES`, `MAX_TOTAL_BYTES`, plus a compression-ratio check against zip bombs).
- Documents are read into memory from the zip. Media files are copied to a session temp dir under
  short names (`<n>.<ext>`). This avoids Windows' 260-char path limit, which Notion's long id-suffixed
  names hit easily.
- `Staged` gains `temp: Option<TempDir>` that deletes itself on drop, so cancel, apply and session
  eviction all clean up.
- An `id → VEntry` index is built once (`names::notion_id(rel_path)`).

**2. Detection (`notion::detect`).** Returns a `Dialect::{Notion, Generic}` and a confidence:
- Notion when ≥ 50% of document and CSV names carry a 32-hex suffix, or any HTML has
  `<article … class="page` with `page-body`.
- A `.zip` with `manifest.json` is still a **Suivelle archive**. Today every `.zip` goes to
  `stage_archive`, so routing changes to: manifest present → archive; otherwise → `Vfs` → detect.
  This also gives **generic zips of Markdown and HTML** import support for free.
- Generic dialect falls back to the existing `collect()` path, so behaviour for non-Notion files
  is unchanged.

**3. Staging model changes (`import.rs`).**
- `Node` gains `icon: Option<String>`, `cover: Option<CoverSrc>` and `notion_id: Option<String>`.
- New `Source::Database(DbModel)` alongside `Source::Csv` (which stays for generic CSVs):
  ```rust
  struct DbModel {
      columns: Vec<ColumnPlan>,            // reuses the preview/override UI
      kinds: Vec<NotionKind>,              // richer: Relation{target_id}, Snapshot, Person, Files…
      rows: Vec<RowModel>,                 // values as raw strings + row notion_id
  }
  struct RowModel { notion_id: Option<String>, title: String, cells: Vec<String>,
                    body: Vec<Blk>, icon: Option<String> }
  ```
- `Source::Pdf { asset_key }` creates a page containing one `pdf` block.
- `ctx.pages` stays keyed by path for generic imports. The Notion path also keeps
  `ids: HashMap<notion_id, new_page_id>`, so links resolve by id **before** falling back to paths.

**4. Hierarchy (`tree.rs`).**
- Pair `Title <id>.md|html` with folder `Title <id>/` **by id**, not by title. Today's
  `merge_same_names` matches titles and would merge two different pages both named "Notes".
- Pair `DB <id>.csv` + `DB <id>_all.csv` + folder `DB <id>/` into one database. `_all` wins for
  rows, and the folder's `.md` files become row bodies (matched by id, then by title).
- Flat layout (folders off): a page's parent is the first page whose body links to it as a
  link-to-page or a standalone link line. Unclaimed pages become top-level.
- Wrapper folders (`Private & Shared`, single-child export roots) are flattened when the import
  creates a new workspace, and kept as pages otherwise.
- Titles: strip the id suffix and percent-encoding. Use the first `# H1` (md) or `h1.page-title`
  (html) when present, because file names are truncated.

**5. Markdown dialect (`md.rs`).** Pre-processes text, then calls `markdown::parse`, then
post-processes the `Blk` tree:
- `<aside>EMOJI text</aside>` → `callout`. The emoji becomes the tone (💡/ℹ️→note, ⚠️/❗→warning,
  ✅/🔥→tip, default note); the text and nested lines become children or inline content.
- Row pages: strip the `Property: value` lines after the title (they duplicate the CSV and are
  used only as a fallback when the CSV lacks the row).
- `[x](… <id>.md)` → internal page link by id. A paragraph that is *only* such a link to a child
  becomes an `Inline::Mention`. `[x](… <id>.csv)` → `database_view` block targeting that database.
- `$$…$$` block → `equation`. Images and files resolve through the `Vfs` as existing `resolve()`
  does, but are keyed by `Vfs` entry.
- Page icon: Notion Markdown has none. Covers are not exported in Markdown.

**6. HTML dialect (`html.rs`).** Add a `Dialect` hook to `transfer::html::blocks_of`, so it takes
`&dyn Fn(tag, attrs, kids) -> Option<Vec<Blk>>` and Notion classes are intercepted before the
generic match. This keeps one DOM parser and avoids duplicating ~400 lines.
- `to-do-list` → `todo` (checked from `.checkbox-on`). `figure.callout` → `callout` (icon → tone,
  body → content and children). `ul.toggle details` → `toggle`. `column-list/column` →
  `columns/column`. `figure.equation` → `equation` (from the TeX annotation). `link-to-page` →
  mention paragraph. `bookmark` → link paragraph (title + URL). `table_of_contents` →
  `table_of_contents`. `pre.code > code.language-X` → `code` with lower-cased language (Notion uses
  "JavaScript", "Plain Text"→none).
- `mark.highlight-*` and `.block-color-*` are dropped (no colour marks) with a single warning.
- Header: `.page-header-icon` emoji → `page.icon`. An image icon or `page-cover-image` becomes an
  attachment, set as the icon or cover if `Page.cover` accepts an attachment reference (verify the
  cover format in the editor; otherwise skip with a warning).
- Database page: `table.collection-content` gives the column order and types from `svg.types*`,
  and row links give the row ids. Each row page's `table.properties` gives the values, and its
  `page-body` gives the record body.

**7. Database building (`database.rs`).**
- Type mapping (Notion → Suivelle). HTML type icons are authoritative. For CSV, inference runs on
  the values using the Notion parsers before `csvio::detect`:

  | Notion | Suivelle | Notes |
  |---|---|---|
  | Title | title | |
  | Text | text | |
  | Number | number | strip `%`, currency, thousands separators |
  | Select / Status | select / `status` | Status when the header is "Status" or HTML says `typesStatus` |
  | Multi-select | multi_select | split on `, ` |
  | Date | date | `Month D, YYYY [h:mm AM]`; ranges keep the start, warn once |
  | Checkbox | checkbox | `Yes`/`No` |
  | URL / Email / Phone | url / email / phone | |
  | Relation | relation | second pass, see below |
  | Person, Created by, Last edited by | text (or multi_select if ≤ 50 names) | warn |
  | Files & media | text (file names); attach files to the row body when they're in the export | |
  | Formula, Rollup | text snapshot | warn: "imported as values" |
  | Created time / Last edited time | date | real system timestamps can't be back-dated |
  | ID (unique_id) | text | Suivelle assigns its own |
- Rows are created with `create_record_in`, and their bodies go through `apply_batch_in` on the
  record's `page_id` (records are pages, so this works today).
- The existing per-column override UI keeps working: the database `Entry` exposes `columns` and
  `apply` honours `overrides`.

**8. Relations (`relations.rs`).** After **all** databases exist, in the same transaction:
- For each relation column, parse `Title (path <id>.md)` items into ids. The target database is
  the database owning those row ids (the majority vote across cells). Create the property via
  `relations::create_relation` with `{targetDatabaseId, twoWay: false}`, then set values to the
  mapped record ids.
- Reciprocal columns (A→B and B→A whose pairs mirror each other) are collapsed into **one two-way
  relation**, so the target doesn't get a duplicate column.
- Unresolvable targets (database not in the export) fall back to a text column with the titles,
  plus a warning.
- Cap at `MAX_RELATION_LINKS` per cell.

**9. PDF import.** Store the file as an attachment and create a page titled from the file name
(id suffix stripped) containing one `pdf` block. No text extraction in v1 (see Later).

**10. Destination.** `ImportApply` gains `target: "container" | "page" | "workspace"`:
- `container` (default, today's behaviour): under a new `Imported <stamp>` page.
- `page`: under the currently selected page.
- `workspace`: create a new workspace named after the export's root (reuse the new-workspace
  path that Suivelle archives use in `archive::import_workspace`, minus the archive specifics).
  Top-level Notion pages become root pages.

**11. Limits and progress.**
- Notion workspace exports routinely exceed `MAX_FILES = 2000`, because every row with a body is a
  file. For the Notion path, raise it to 25,000 entries, keep the 500 MB and 50 MB caps, and make
  them a single `Limits` struct.
- Emit `transfer://progress` events (`{phase, done, total}`) from staging and apply. The dialog
  shows a determinate bar instead of "Saving…".
- `apply` already runs in one transaction. Chunk block inserts as today.

### Export side

**Options model** (`export.rs`), replacing the `format: String` parameter:
```rust
pub struct ExportOptions {
    format: Format,              // Markdown (md+csv) | Html | Pdf
    include_subpages: bool,
    folders_for_subpages: bool,  // false → flat, links still work
    content: Content,            // Everything | NoFiles (drop media blocks → "[file name]" text)
    database_rows: Rows,         // All | DefaultView (apply the database's first view filter/sort via databases::query)
    zip: bool,                   // true whenever more than one file is produced
}
```

**Sink.** Introduce `trait Sink { write(rel, bytes); copy(rel, src_path) }` with `DirSink` and
`ZipSink` (using `archive::put`). Swap the four `std::fs::write`/`copy` calls in `Exporter`. Any
export that yields more than one file becomes a single `.zip`, as Notion does. This removes the
"pick a folder" step.

**Notion-compatible layout.** Make it the only Markdown & CSV layout (see decision D1):
- Pages are `Title.md` and children go in `Title/`. This matches what Notion's Markdown importer
  nests correctly. Notion ids aren't added, since they're Notion's own.
- Databases are `Title.csv` (rows formatted Notion-style: `Month D, YYYY`, `Yes/No`, comma
  multi-select, relation titles) plus `Title/` with one `Row.md` per record that has a body. Each
  row file starts with `# Row` and `Property: value` lines, so Notion attaches bodies to rows and
  our importer reads them back.
- Today a database inside an exported subtree exports only a CSV, so **record bodies are lost**.
  This fixes that.
- An embedded `database_view` block renders as a link to the database's CSV, as Notion does.
- Callouts render as `<aside>EMOJI text</aside>` with the tone mapped to an emoji, so Notion
  re-imports them as callouts.

**HTML.** Keep `html::render_document`, but emit Notion's class names (`page sans`, `page-title`,
`to-do-list`, `checkbox-on`, `callout`, `toggle`, `column-list`, `properties`, `collection-content`).
Our Notion HTML importer then round-trips our own exports, and the output looks familiar. A
database becomes `Title.html` with a `collection-content` table plus row pages.

**PDF (single page only).** Render the page through `render_document` with print CSS and the
assets inlined as `data:` URIs, then print it to a file. See decision D2 for the mechanism.
- PDF is offered only for a page or record. It is disabled, with a hint, when *Include subpages*
  is on or the page is a database, as in Notion.

**Database CSV export from the database's own menu** stays a single CSV, but uses the shared
Notion-style value formatter.

### Front end

- **Export tab** becomes the form in the screenshots, using the existing `select.css` dropdowns
  and toggles:
  - *Export format*: PDF (only for a single page), HTML, Markdown & CSV.
  - *Database views*: All rows / Default view (only shown when the subtree contains a database).
  - *Page content*: Everything / No files or images.
  - *Include subpages* toggle.
  - *Create folders for subpages* toggle (disabled when subpages are off).
  - *Cancel* / *Export*.
  - The existing `ExportPreview` stays as an optional "Preview" button for single-page MD/HTML.
- **Import tab**:
  - The file filter adds `pdf`, and `.zip` is no longer documented as "Suivelle archive only".
  - The preview header shows a **"Notion export"** badge plus detected format and layout ("Markdown
    & CSV, folders").
  - A destination selector offers: Inside a new "Imported" page / Under the current page / As a
    new workspace.
  - Database entries keep the column-type table, which gains read-only rows such as
    "Relation → Tasks" and "Values from formula".
  - A progress bar shows during staging and apply. Warnings are grouped and collapsible
    (large exports produce many).
- `ipc.ts`: `exportPage(pageId, options)`, `exportPagePreview(pageId, options)` and
  `importApply(..., target)`. Types go in `src/types`.
- The palette `import` command already lists "notion" in its keywords. Add a "Notion" keyword to
  `export` too.

## Phases

| # | Deliverable | Done when |
|---|---|---|
| 0 | **Fixtures**: export one test Notion workspace in every mode (MD&CSV ± folders, HTML ± folders, PDF, one large enough to split into Parts). Sanitize and commit trimmed copies under `notion/fixtures/`. Write down every observed rule that differs from this plan. | Fixtures committed; plan's format section corrected |
| 1 | `Vfs` (dir/zip/nested zip, temp-dir cleanup, limits, zip-bomb check); `.zip` routing by manifest; generic zip import | Generic zip of md/html imports; Suivelle archives unaffected; tests for zip-slip, nesting, long paths |
| 2 | Notion detection, names/ids, hierarchy (folders, flat, wrappers), Notion Markdown pages and links | MD fixtures import with correct tree, titles, internal links and images |
| 3 | Notion databases from CSV (`_all`, row bodies, type inference, overrides) | Rows, types and bodies match fixtures |
| 4 | Relations second pass (reciprocal → two-way) | Cross-database links resolve; unresolved targets fall back to text |
| 5 | Notion HTML dialect (blocks, header icon and cover, databases from `collection-content`) | HTML fixtures produce the same result as MD fixtures, plus columns, callouts and toggles |
| 6 | PDF import; destination choice incl. new workspace; progress events; Import UI | End-to-end in the app on all fixtures |
| 7 | Export options + `Sink`/zip + Notion-layout MD&CSV (record bodies, row properties) + Notion-class HTML | Re-importing our export reproduces the tree; a manual import into Notion succeeds (checklist) |
| 8 | PDF export | Single page saves a paginated PDF with images, code and tables |
| 9 | Export UI form; release notes entry; README "bring your notes in" line | Matches screenshots; `npm run typecheck`, `vitest`, `cargo test` green |

Phases 1–6 ship value on their own (import), so Notion import can ship before export is finished.

## Testing

- **Rust unit tests** (`notion/tests.rs`, existing `transfer/tests.rs` style): name and id parsing,
  date, bool and list parsers, the callout `<aside>` transform, flat-layout parent inference,
  reciprocal relation pairing, zip-slip and zip-bomb rejection, and long-path extraction.
- **Fixture tests**: stage each fixture, then assert on the `Preview`. Apply into an in-memory DB
  and assert on pages, blocks, records, values and relations.
- **Round trip**: export a seeded workspace (`sample-workspace/`) → import → compare page tree, block
  kinds, record values and relation targets. This catches export regressions automatically.
- **Manual checklist (Notion)**: import our MD&CSV and HTML zips into a scratch Notion workspace,
  then check hierarchy, database types, row bodies and callouts. Record the results in this doc.
- **Front end**: vitest for the option-dependency rules (PDF disabled with subpages, the folders
  toggle disabled without subpages) and for `summarize` with relation counts.

## Risks

- **Undocumented, drifting format.** Detection is tolerant: an unknown Notion construct degrades
  to the generic parser plus a warning, never a failed import. Fixtures pin down current behaviour.
- **Windows long paths.** Handled by the `Vfs` (no tree extraction).
- **Zip bombs and huge exports.** The ratio check, entry and byte caps, and streaming media to the
  temp dir handle these. Memory holds parsed `Blk` trees, not raw media.
- **Title collisions.** Ids are the key everywhere, never titles.
- **Partial losses** (colours, people, formulas, bookmarks) are surfaced as grouped warnings in
  the preview *before* applying.
- **PDF export portability.** It depends on D2.

## Decisions (settled 2026-10-12)

- **D1: Export layout.** The Notion-compatible layout **replaces** today's Markdown & CSV and HTML
  export. There is no separate "For Notion" option.
- **D2: PDF export.** **Native silent print-to-file**: WebView2 `PrintToPdf` on Windows via
  `webview2-com` (save dialog → file). macOS WKWebView `createPDF` follows later.
- **D3: PDF import.** **Attachment page only**: one `pdf` block. Text extraction is deferred.
- **D4: Default destination.** A full Notion workspace export defaults to a **new workspace**.
  Single pages and subtrees default to the current workspace. Both can be switched in the preview.

## Later

PDF text extraction; mapping Notion people to a future "person" property; colour marks (after the
editor gains them); bookmark and embed blocks; incremental re-import (update pages already imported
by Notion id instead of duplicating).

## Implementation notes

Where the build differs from the plan above, and why:

- **Fixtures are synthetic.** No real Notion exports were available, so `transfer/notion/tests.rs`
  builds exports in Notion's documented layout: ids in names, `_all` CSVs, row pages with property
  lines, `<aside>` callouts, HTML classes and `collection-content` tables, split "Part" zips, and
  exports without subpage folders. **Still to do:** export a real workspace from Notion in each
  mode, import it, and correct any rule that differs. Detection is tolerant: an unrecognised file
  falls back to the generic importer rather than failing.
- **Exports keep ids in their names** (`Title <32-hex id>.md`), as Notion's own exports do. This
  replaces the plan's "no ids" line. Suivelle's importer treats its own exports as Notion exports,
  so pages, record bodies and relations come back by id. **Still to check:** that Notion's
  importer strips the id from a database's name, which it takes from the CSV file name. Page
  titles come from the `# Title` and `page-title` lines, so they are unaffected.
- **Every zip that is not a Suivelle archive is unpacked** (to a temporary folder removed with the
  import session). Both Notion zips and plain zips of notes now import. Rust's standard library
  handles Windows long paths, so files are unpacked to disk instead of read through a virtual file
  set.
- **The generic Markdown and HTML parsers understand Notion's markup.** That covers `<aside>`
  callouts, and Notion classes whenever an HTML file has Notion's `<article class="page">`. Exports
  Suivelle makes re-import as the same blocks through either path.
- **Progress is shown as busy labels, not a progress bar.** Staging and applying each run as one
  backend call. Streaming `transfer://progress` events was left out.
- **PDF export is Windows-only** (WebView2 `PrintToPdf` in `transfer/pdf.rs`). Other platforms get
  an error that suggests HTML instead.
- **Things Notion's export carries that Suivelle cannot store,** each reported as a warning or a
  column note in the preview:
  - Text colours and highlights.
  - People, files, formula and rollup values, which are imported as text.
  - Date ranges with a time zone suffix, where the zone is dropped.
  - Page icons and option colours from Markdown exports, which do not contain them.
