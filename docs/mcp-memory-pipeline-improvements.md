# Suivelle MCP: Agent Memory & Context Pipeline Improvements

A plan for making Suivelle's agent memory and context subsystem (`src-tauri/src/agents/`,
`src-tauri/src/search/`) faster, cheaper in tokens, and more reliable at recall. It is ordered
by phase: correctness first, then measurement, then token work, then recall quality, then
memory hygiene. Line numbers are as of 16 October 2026.

**Status (16 October 2026).** Done, with tests in `src-tauri/src/agents/tests.rs`: Phase 0
(the size-budget test and recall cases; a separate fixture module was not needed), all of
Phase 1, 2.1 (`whoami` lists project pages and takes `project`/`topic`; `context_pack` takes
`project`/`scope`), 2.4, 2.5 for `context_pack`, 2.6, 2.8, 4.1, 4.2 (refuses with the newer
memory's id instead of using `Disputed`), and from Phase 5 filtering before decorating,
relation-free values for memories and cheap first lines. Later the same day: 2.2 as a Vault
health check (`protocol`, comparing the page with `commands::PROTOCOL` and the shipped
`PAST_PROTOCOLS`; add the outgoing text there whenever the protocol changes), 4.3's
near-duplicate check (`memory_duplicates`, a separate check so hourly upkeep never applies
it), and 3.1's recency signal (an aged BM25 rank, never stronger than word coverage). 2.3 and
2.7 are on branch `claude/gallant-chatelet-f2dad8`, not yet merged. Dropped after review:
confidence in ranking (nearly every memory is Stated or Verified), 3.2, 3.3, and 4.3's stale
"Inferred" and missing-scope checks; links to trashed pages were already covered by
`broken_links`, which includes memory pages. Open: 2.5 for `page_read`, caching the hub lookup.

**Principles for every change below**

- **Measure before and after.** Every token claim gets a number from the fixture in Phase 0, not
  an estimate.
- **Never lose recall to save tokens.** Compact output must still let an agent find and cite a
  memory (title + addressable id).
- **No silent writes.** Dedup and conflict handling suggest; they do not supersede on the
  agent's behalf.
- **Keep output deterministic.** Same database, same arguments → byte-identical tool output, so
  prompt caching on the client side keeps working and tests can snapshot it.

---

## Phase 0 — Baseline and regression harness (do first)

Add a seeded fixture workspace and a test module (`src-tauri/src/agents/eval_tests.rs`) that
builds a hub plus ~1,000 memories across 3 scopes and ~300 ordinary pages, then asserts on:

| Metric | How |
| :--- | :--- |
| Bytes of `tools/list` for a full-tool agent | serialize `tools::definitions` |
| Bytes of `whoami` with a typical instructions page + protocol | call the tool |
| Bytes of `context_pack(hub, topic, 2000)` and section split | call the tool, parse `##` sections |
| Recall@5 on ~30 labelled queries (cross-field, plural, old memory, other-scope noise) | `memory::recall` |
| `memory_recall` / `context_pack` wall time | `std::time::Instant`, reported, not asserted |

Snapshot the byte counts (chars ÷ 4 ≈ tokens, same as `context::pack`) so a change that
inflates output fails review. The recall queries become the acceptance test for Phases 1 and 3.

---

## Phase 1 — Correctness bugs (recall misses today)

### 1.1 Memories older than the 500 newest can never be recalled
`memory::recall` (`memory.rs:96-104`) builds `record_of` from the **500 newest** records only,
then keeps FTS hits only if they are in `record_of` (`memory.rs:110-113`). A memory that is the
best FTS hit but the 501st newest is dropped. The plan's original 1A treated the 500-row load as
a speed problem; it is a correctness bug first.
- **Fix:** scope FTS to the Memory database in SQL (see 1.2), and resolve hits to records with
  a join, not with an in-memory map of the newest 500. Keep "newest N" only for the no-query
  path.

### 1.2 Workspace-wide FTS starves memory hits
`memory::recall` calls `search::search` over the whole workspace with `MAX_LIMIT = 50`
(`memory.rs:77-88`), then filters to memory pages. Ordinary pages crowd memories out.
- **Fix:** add `database_id: Option<String>` to `SearchInput` (`search/mod.rs:415`) and filter with
  `EXISTS (SELECT 1 FROM db_record r WHERE r.page_id = d.page_id AND r.database_id = ?)`.
  Better still, give recall its own query (1.3) instead of reusing the UI search, whose ranking
  and snippet work recall does not need.

### 1.3 Implicit `AND` across split documents
`fts_query` (`search/text.rs:240-259`) joins terms with spaces, which FTS5 reads as `AND` within
one `search_doc` row. A memory's title (`p:`), each body paragraph (`b:`) and each text property
(`v:`) are separate rows, so `"sqlite wal checkpoint"` with "sqlite" in the title and the rest in
the body matches nothing.
- **Fix — a dedicated recall query:** build `OR` of quoted prefix terms, group by page, and rank
  by aggregated score:
  ```sql
  SELECT d.page_id,
         SUM(bm25(search_fts, 10.0, 1.0)) AS score,      -- lower is better
         COUNT(DISTINCT <matched term>) AS coverage       -- see note
  FROM search_fts JOIN search_doc d ON d.id = search_fts.rowid
  JOIN db_record r ON r.page_id = d.page_id AND r.database_id = ?db
  WHERE search_fts MATCH ?or_expr AND d.workspace_id = ?ws
  GROUP BY d.page_id ORDER BY coverage DESC, score LIMIT ?k
  ```
  Term coverage is what makes `OR` safe: a memory matching 3 of 3 terms must beat one that
  matches "project" 40 times. Compute it with one `MATCH` per term (≤ 8 terms, already capped)
  unioned and counted, or in Rust over the top ~100 grouped candidates.
- **Guard the `OR` expansion:** drop terms shorter than 3 characters from the `OR` form (a
  `"a"*` prefix matches nearly everything), drop a small stopword list (English and French,
  since workspaces may be either), and keep the existing 8-term cap.
- **Keep `AND` first when it is enough:** run the strict query; fall back to the `OR` query only
  when it returns fewer than `limit` hits. This keeps exact searches exact and costs one extra
  query only on misses.

### 1.4 The title fallback is a whole-query substring
`memory.rs:114-123` keeps a record when `title.contains(whole_query)`. For multi-word queries this
almost never matches. With 1.3 in place, delete this fallback (and its N+1 `SELECT title`)
instead of optimizing it.

### 1.5 `context_pack` uses the hub title as the topic and ignores scope
When `context_pack(page_id=hub)` is called without `query`, `topic = page.title`
(`context.rs:205-207`), i.e. `"Suivelle project"`. Under `AND` that requires "project" in the
memory row. And both recall calls in `pack` pass `scope: None` (`context.rs:250-268`), so a
multi-project workspace leaks Project B's memories into Project A's pack.
- **Fix:** when the page is a `"<X> project"` hub or a descendant of one, infer `scope = X` and
  strip the ` project` suffix from a title-derived topic. Accept an explicit `scope` argument
  that overrides the inference.

### 1.6 Unscoped memories match every scope
`memory.rs:145-150` lets any memory with an empty `Scope` pass every scope filter, and matches
scope by substring (`"ui"` matches `"suivelle"`).
- **Fix:** match scope by exact value or `/`-segment prefix (`suivelle` matches `suivelle/mcp`),
  case-insensitively. Keep unscoped memories as candidates but rank them after scoped ones
  (Phase 3). Normalize `Scope` on write (trim, collapse whitespace) so `"Suivelle "` and
  `"suivelle"` are the same.

---

## Phase 2 — Token efficiency

A note on cost: MCP clients that cache prompts (Claude Code, Claude Desktop) bill repeated tool
definitions and earlier turns at the cached-read rate, and Claude Code defers MCP tool schemas
until they are searched for. So per-turn savings in `tools/list` matter most for clients without
caching or deferral (Cursor, Zed, opencode, local models). **Tool results and round trips are
the costs that hit every client**: results are new, uncached input, and each call adds latency
plus a model turn. Prioritize those.

### 2.1 One-call session start
Today the protocol costs `whoami` → `search(titles_only)` → `context_pack` (→ `memory_recall`).
- **Fix:** `whoami` lists each workspace's `"* project"` hubs (title + id), so the search call
  goes away. Then add optional `project` and `topic` arguments to `whoami`: when given, it
  appends the context pack for that hub. The agent resolves `[Project]` from the repo before
  its first call (it is a manifest read, no Suivelle call), so a session start becomes one
  call. Calls without arguments behave as today, so older protocol pages keep working.
- Also accept `project`/`scope` on `context_pack` (resolving `"<scope> project"` when `page_id`
  is omitted), for agents that call it mid-session.
- Update `commands::PROTOCOL` (`commands.rs:71-85`) to the one-call form.

### 2.2 Stale protocol and instruction text cost every session
`whoami` returns the agent's instructions page and the workspace's "Agent protocol" page in
full. Two problems found in a real workspace:
- The stored "Agent protocol" page predates the current `commands::PROTOCOL`: it inlines the
  whole setup procedure (~2× the text) that now lives in `/suivelle_setup`. Users never see that
  the built-in text changed.
- The default instructions page says *"Read the Suivelle page 'Agent protocol' with page_read"*,
  while `whoami` already includes it with "no need to page_read it". The contradiction invites a
  wasted call.
- **Fix:** keep a fingerprint of the built-in protocol on the page it was created from; when the
  page is unedited and the built-in text changes, propose the update (it already needs review).
  When it was edited, Vault health reports "Agent protocol is older than the built-in one". Remove
  the `page_read` line from the default instructions template and from existing unedited pages.

### 2.3 Short ids in agent-facing output
Page ids are 36-character UUIDv7 strings (~20–25 tokens each), and they appear in every memory
bullet, every connected page, every task, and inside every rendered mention
(`[Title](suivelle://page/<uuid>)`, `content.rs:111`). A 40-line connected-pages section spends
roughly 1,000 tokens on ids alone. UUIDv7 prefixes are timestamps and shared across a workspace
(`01a13b…`), so prefixes are useless; suffixes are random.
- **Fix:** render ids as the shortest unique **suffix** of at least 8 hex characters within the
  agent's workspaces, and let every tool that takes a page id accept a full id or a unique
  suffix. An ambiguous suffix is a validation error listing the candidates, never a guess.
  Writes (`page_update`, `memory_write supersedes`, `changes_propose`) resolve to the full id
  before anything is recorded, so changesets and history keep full ids.
- In compact mode, render mentions inside memory bodies and context packs as `[[Title]]` when the
  title is unique in the workspace (this is already a supported input form) and keep the full
  `suivelle://` link only for `page_read`, where the text may be written back.

### 2.4 Item-level budget packing in `context_pack`
`context::pack` (`context.rs:216-316`) slices the budget 45% / 20% / 25%, clips each section at
a line break (cutting a memory in half), leaves tasks unbudgeted, and finally hard-truncates the
whole document, which can cut off the "Left out" notes that tell the agent what is missing.
- **Fix:** build the pack as a list of items (page body chunks, one per connected page, one per
  memory, one per task), each with a priority and a size, and fill greedily:
  1. Reserve a small fixed amount for headers and the "Left out" list.
  2. Give each section a **floor** (so memories always get some room) instead of a fixed share.
  3. Fill by priority; when an item does not fit, skip it and record it in "Left out" with the
     cheapest way to get it (`page_read <id>`, `memory_recall query=…`).
  4. Hand any budget a section does not use to the next section.
  Items are never split, so nothing arrives half-cut; only the page body is chunked, at block
  boundaries.
- Rank connected pages before cutting: children and outgoing links before backlinks; skip Memory
  and Agent task records (they come through their own sections) and the agent's instructions
  page.

### 2.5 `known_hash`: don't resend an unchanged page
Agents re-pack after context compaction or in the next session and receive the same hub body
again.
- **Fix:** `context_pack(…, known_hash)` and `page_read(…, known_hash)`: when the page's
  `content_hash` equals it, return `"Page unchanged (hash …)"` instead of the body. The hash is
  already in the pack header, so the agent has it.

### 2.6 Compact memory rendering
`memory::render` (`memory.rs:301-334`) prints every property, including the defaults, and bounds
bodies by 12 *lines*, not characters.
- Omit `Status: Active` when inactive memories were not requested, `Confidence: Stated`, `Source`
  when it is the calling agent, and `Scope` when it equals the queried scope:
  `- [Decision · Verified] **Title** (id 9f3c21ab · 2026-10-16)`
- Cap each body by characters (≈ 400 in `context_pack`, ≈ 1,200 in `memory_recall`), cut at a
  sentence or line, ending with `… (memory_recall id=… for the rest)`.
- Add `include_body` (default `true`) to `memory_recall` for a cheap title scan.
- Call `content::body_markdown` only for memories that will be rendered with a body, after
  filtering (today it runs for every returned memory, `memory.rs:156`).

### 2.7 Outline and section reads; section edits
Large pages ("Architecture", "Decisions") are read and rewritten whole.
- `page_read(outline=true)`: headings with their block counts and a short first line each.
- `page_read(section="Heading")`: just that heading's subtree.
- `page_update(section="Heading")`: replace or append within that subtree, still checked by
  `base_hash`. Resolve by exact heading text; if two headings match, refuse and list their paths
  (`Decisions > Storage`). This also makes review diffs smaller in Propose mode.

### 2.8 Deduplicate the untrusted-content sentence
The 103-character warning (`tools.rs:54`) is appended to 16 tool descriptions (`tools.rs:405`),
about 350 tokens of `tools/list`, and is already in `server::INSTRUCTIONS` and `whoami`.
- **Fix:** keep it in `INSTRUCTIONS`, `whoami`, and the description of `page_read` and `search`
  only (the two tools that return arbitrary page text). Cheap, low-risk, and worth doing even
  though cached clients barely feel it.
- While there, measure the whole `tools/list` with the Phase 0 harness and trim descriptions
  that restate the schema.

---

## Phase 3 — Recall quality

### 3.1 Multi-signal ranking
After Phase 1 gives a candidate set (≤ 100), rank in Rust with a small, documented score:

| Signal | Effect |
| :--- | :--- |
| Term coverage (from 1.3) | primary key |
| Aggregated BM25 (title 10, body 1) | secondary |
| Scope: exact > segment prefix > unscoped | boost |
| Recency | mild decay (e.g. half-life 180 days), never enough to beat coverage |
| Confidence: Verified > Stated > Inferred | tie-breaker only |

Do **not** rank by Kind (the original plan boosted Feedback/Decision over Reference). A query
about a reference should find the reference; Kind is better offered as a filter, which it
already is. Keep the weights in one function with a unit test per signal so tuning is visible.

### 3.2 Graph-linked memories
Memories rarely link to the hub page by hand, so a `page_reference`-only boost will seldom fire.
- When `context_pack` has a `page_id`, include active memories that link to that page or to its
  ancestors (cheap, already indexed), labelled "Linked to this page".
- Make links happen: when `memory_write` has a scope with a matching `"<scope> project"` hub,
  return the hub id in the result so the agent can cite subpages, and mention `[[Page]]` links
  in the tool description as the way to tie a memory to a page.

### 3.3 Optional: stemming
The index uses `unicode61 remove_diacritics 2` (`migrations/0003_search.sql:25`) with no stemmer,
so prefix matching catches `checkpoint` → `checkpoints` but not the reverse. Porter is
English-only and changes UI search too; only consider it if the Phase 0 recall set shows misses
that prefixes do not cover. Semantic search remains deliberately deferred.

---

## Phase 4 — Memory hygiene

### 4.1 Write-time duplicate handling (suggest, never auto-supersede)
The original plan auto-superseded an active memory with the same normalized title. That can
silently retire a different claim that happens to share a title ("Build command" for two
packages). Instead:
- **Exact duplicate** (same normalized title, body and scope, still active): return the existing
  id and write nothing (`"Already recorded as 9f3c21ab"`). Idempotent retries cost zero.
- **Likely duplicate** (same scope, title Jaccard ≥ 0.6 or normalized-title Levenshtein ≤ 3,
  using `janitor.rs:88-102`): save, and append one line:
  `Similar active memory: 9f3c21ab "Title" — pass supersedes=9f3c21ab if this replaces it.`
- Cap memory bodies on write (e.g. 2,000 characters) with a validation message suggesting a page
  plus a short memory that links to it. Long memories are what blow context budgets later.

### 4.2 Superseding a memory that is already superseded
If `supersedes` points at a memory whose Status is already `Superseded`, follow `Superseded by`
to the current head and refuse with its id and title, so the agent decides whether to supersede
the head instead. Use `Disputed` (defined in `templates.rs:946-951`, never set today) only when an
agent explicitly passes `status: "Disputed"` / a `disputes` argument; janitor lists disputed
memories for the user to resolve.

### 4.3 More janitor checks
Extend the `"memory"` check in `janitor.rs:326-374`:
- Near-duplicate active memories in the same scope (same measure as 4.1).
- `Inferred` memories with no `Expires`, unchanged for 60+ days.
- Memories whose links point at trashed pages or are unresolved.
- Memories with no scope in a workspace that has project hubs (likely missing `scope`).
- "Agent protocol" older than the built-in protocol (from 2.2).

---

## Phase 5 — Performance

These are worth doing but are second to recall correctness; most disappear once Phase 1 replaces
the 500-row scan.

- **Filter before decorating.** Push `Status = Active` (option id from `load_properties`),
  `Kind` and scope into SQL, then call `load_rows` and `hub::readable` only for survivors, in
  chunks until `limit` is reached (as `records_query` does, `tools.rs:1192-1218`). Today
  `context_pack` runs `recall` twice (topic and generic), so each pack loads up to 1,000 rows.
- **Skip relation resolution for rendering.** `hub::readable` (`hub.rs:215-231`) runs one query
  per relation target, but `memory::render` never prints relations. Add a variant that leaves
  relations unresolved, or batch them with one `IN (…)` query.
- **Cheap first lines.** `context::first_line` (`context.rs:146-156`) renders whole pages to
  Markdown to keep 160 characters. Read the first few top-level non-heading blocks and use
  `search::text::plain_text_with` with a cached title lookup (so mentions keep their text), as
  `search::page_preview` does (`search/mod.rs:658-689`).
- **Cache the hub lookup** per call: `hub::get` runs per workspace in `recall`, `write` and the
  janitor.

---

## Priority matrix

| # | Change | Recall | Tokens | Speed | Effort | Risk |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| 0 | Baseline harness + recall set | — | — | — | S | none |
| 1.1–1.4 | Memory-scoped recall query, `OR` fallback with coverage, drop 500-row map | **Critical** | Medium | High | M | low |
| 1.5–1.6 | Scope inference and exact scope matching | **High** | Medium | — | S | low |
| 2.1 | One-call session start (`whoami(project, topic)`) | — | **High** | High (latency) | S | low |
| 2.2 | Fresh protocol, no `page_read` contradiction | — | Medium | — | S | low |
| 2.3 | Short id suffixes, `[[Title]]` mentions in packs | — | **High** | — | M | medium (id resolution) |
| 2.4–2.5 | Item-level packing, `known_hash` | Medium | **High** | — | M | low |
| 2.6 | Compact memory rendering, body caps | — | High | Low | S | low |
| 2.7 | Outline/section read, section update | — | High (output tokens) | — | M | medium |
| 2.8 | De-duplicated untrusted sentence | — | Low–Medium | — | XS | none |
| 3.1–3.2 | Ranking and linked memories | High | — | — | M | low |
| 4.1–4.3 | Dedup hints, supersede head check, janitor checks | Medium | Medium | — | M | low |
| 5 | Filter before decorating, cheap first lines | — | — | High | S | low |

**Suggested order:** 0 → 1 → 2.1/2.2/2.8 (small, independent) → 2.6 → 2.4/2.5 → 3 → 2.3 → 2.7
→ 4 → 5. Each phase lands with its own tests and a `docs/changelog/0.1.6.md` entry written for
readers of the app (e.g. "Memories are found when a search's words are spread across a memory's
title and text").

## Changes from the first draft

- Added the 500-newest correctness bug (1.1), the whole-query title fallback (1.4), the hub title
  used as topic (1.5), stale protocol text (2.2), id size (2.3), the hard truncation in packs
  (2.4) and `known_hash` (2.5).
- `OR` fallback now ranks by term coverage before BM25 and guards short terms and stopwords, so it
  cannot swamp results.
- Write-time dedup no longer auto-supersedes; exact duplicates become no-ops.
- Kind no longer affects rank.
- Token claims distinguish cached tool definitions from uncached tool results and round trips.
- Performance items moved after correctness, since Phase 1 removes most of them.
