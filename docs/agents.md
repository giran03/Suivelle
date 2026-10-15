# Local AI agents

Suivelle can be the shared, local knowledge base for AI agents on the same computer (Claude
Code, Codex and other MCP clients): shared memory, a knowledge graph with bidirectional links,
agent definitions, a task queue and vault upkeep. The database stays the source of truth; a
per-workspace Markdown mirror makes the same content available as plain text.

Principles:

- **Pull only.** Suivelle never runs a model and never starts an agent. Agents connect and ask.
  (The `suivelle-mcp` bridge may start Suivelle itself, in the tray, when it is not running.)
- **Local only.** The agent API listens on a random port on 127.0.0.1, only while the user has
  turned it on, and only answers agents with a token. Nothing is sent over a network.
- **Reviewable and revertable.** Every change an agent, the mirror or vault upkeep makes is one
  transaction recorded as a changeset; Activity reverts any of them. Agents never hard-delete,
  never touch settings, backups or trash, and cannot change their own permissions.
- **Few primitives.** Memory and the task queue are ordinary databases in each workspace's
  Agent Hub page; instructions are ordinary pages; proposals reuse the services the editor uses.

## Connecting agent apps

Settings > Agents > **Connect apps** finds the agent apps on this computer and connects them in one
step. It looks only at config folders and programs on PATH, and only while that page is open.

| App | Config Suivelle edits | How |
|---|---|---|
| Claude Code | `~/.claude.json` (user scope) | `claude mcp add-json`, else the file |
| Claude Desktop | `<AppData>/Claude/claude_desktop_config.json` | file |
| Codex | `~/.codex/config.toml` | `codex mcp add`, else the file |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` and `~/.gemini/config/mcp_config.json` (each that exists) | file |
| Gemini CLI | `~/.gemini/settings.json` | file |
| Cursor | `~/.cursor/mcp.json` | file |
| VS Code | `<AppData>/Code/User/mcp.json` (`servers`) | file |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | file |
| opencode | `~/.config/opencode/opencode.jsonc` or `opencode.json` (`mcp`) | file |
| Zed | `settings.json` (`context_servers`) | file |

The list is data (`src-tauri/src/agents/clients/catalogue.json`), so paths and entry shapes can
follow the apps as they change.

- **Connect** shows exactly which file changes, then creates one agent for the app (its own
  token, the chosen workspaces, mode and tools) and adds a `suivelle` server. Only that entry is
  touched: JSON, JSONC (comments, trailing commas) and TOML files keep everything else byte for
  byte, including line endings and a BOM. The previous file is kept as
  `<file>.suivelle-backup`; writes are atomic and read back. **Copy config instead** shows the
  entry to paste by hand. A `suivelle` server Suivelle did not add is replaced only after asking.
- **Tokens.** On Windows the token goes to Credential Manager (`Suivelle agent <id>`) and the
  config runs `suivelle-mcp --credential <agent id>`, so no secret sits in the app's files.
  Elsewhere it is in the entry's environment (`SUIVELLE_AGENT_TOKEN`).
- **The connector** is copied to `<local app data>/Suivelle/bin` with an `app-path` file naming
  the Suivelle program, so configs keep one path across updates and install folders. Installed
  builds refresh the copy at startup; development builds only on Connect or Repair.
- **Status** per app: Not connected, Set up outside Suivelle, Needs restart (connected, not used
  yet), Connected, Out of date (connector missing, token replaced or revoked), Edited outside
  Suivelle, Entry removed, Config unreadable. **Repair** writes the entry again with a fresh
  token; **Disconnect** removes the entry and revokes the token, keeping the agent and its
  history. Removing a connected agent disconnects its app first.
- **Import subagents** turns Claude Code subagent files (`~/.claude/agents` or a project's
  `.claude/agents`) into Suivelle agents: name, description and model from the front matter,
  the body as the instructions page.

Project-scoped configs (a repository's `.mcp.json`) are not edited.

### Session-start lines and commands

Connect also offers two additions, both ticked by default and listed with their exact files:

- **Start sessions from Suivelle** writes these lines into the app's user-level instructions
  file, between `<!-- suivelle:start -->` and `<!-- suivelle:end -->`:

  ```
  # Suivelle context management
  At the start of a session, call suivelle whoami and follow the instructions it returns. If Suivelle is not available, say so once and continue without it.
  ```

  The same lines added by hand are wrapped in the markers instead of written twice. The file
  gets a backup and keeps everything outside the block; Disconnect takes the block out (unless
  another connected app reads the same file, as Gemini CLI and Antigravity do).
- **Add Suivelle commands** writes four small command files. Each only asks the agent to call the
  `command` tool, so the steps live in Suivelle:

  | Command | Does |
  |---|---|
  | `/suivelle_init` | Once per computer: checks the connection and the session-start lines, and proposes an "Agent protocol" page if there is none |
  | `/suivelle_setup` | Once per project: builds the "[Project] project" pages, memories and tasks |
  | `/suivelle_sync` | Brings the project pages up to date with the repository |
  | `/suivelle_wrap-up` | Records the session's decisions, updates the affected pages and tasks |

| App | Instructions file | Commands folder | Typed as |
|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/commands` | `/suivelle_init` |
| Codex | `~/.codex/AGENTS.md` | `~/.codex/prompts` | `/prompts:suivelle_init` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `~/.gemini/commands` (TOML) | `/suivelle_init` |
| opencode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/command` | `/suivelle_init` |
| Cursor | Settings > Rules > User Rules (pasted) | `~/.cursor/commands` | `/suivelle_init` |
| VS Code | a user instructions file (pasted) | `<AppData>/Code/User/prompts` | `/suivelle_init` |
| Antigravity | `~/.gemini/GEMINI.md` | MCP prompts | app's own naming |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | MCP prompts | app's own naming |
| Claude Desktop, Zed | their settings (pasted) | MCP prompts | app's own naming |

The connector also serves the four commands as MCP prompts (`init`, `setup`, `sync`,
`wrap-up`), so apps without command files offer them their own way (Claude Code shows them as
`/mcp__suivelle__wrap-up`). A page titled "Agent command: sync" (and so on) replaces a
command's built-in steps. Command files Suivelle did not write are left alone; a removed or
changed file or block shows as Edited outside Suivelle, and Repair writes it again. Apps connected
before these existed show **Add commands**, which repairs the connection and adds both.

## Setting up an agent by hand

1. Settings > Agents > **Let local agents connect**.
2. **Add agent…**: name, role, workspaces it may see, tool groups, and mode.
3. **Create token**. The token is shown once; copy the Claude Code command shown with it, e.g.

   ```
   claude mcp add suivelle --scope user --env SUIVELLE_AGENT_TOKEN=sva_… -- "C:\…\suivelle-mcp.exe"
   ```

   Other MCP clients run `suivelle-mcp` as a stdio server with `SUIVELLE_AGENT_TOKEN` set.
   `SUIVELLE_AGENT_ENDPOINT=127.0.0.1:<port>` and `SUIVELLE_APP=<path>` override discovery.
4. Optionally **Export for Claude Code…** writes `.claude/agents/<name>.md` into a project, with
   the agent's instructions page as the body and its Suivelle tools in the frontmatter. Hand
   edits are detected by a fingerprint and never overwritten without confirmation.

`suivelle-mcp` is a separate binary in the Cargo workspace (`src-tauri/mcp-bridge`, std only).
Build it with `cargo build -p suivelle-mcp`; Settings looks for it next to the Suivelle
executable. Installers ship it beside Suivelle: `scripts/build-mcp-bridge.mjs` builds it into
`src-tauri/binaries/` for Tauri's `externalBin`, which the release configuration
(`tauri.release.conf.json`) and `scripts/build-installer.ps1` use.

## Modes

| Mode | Changes to pages | Memories and task updates |
|---|---|---|
| Propose (default) | Wait in the Review inbox | Saved directly |
| Auto | New pages, records, appends, and edits to pages the agent created apply at once; other edits, moves and trashing wait | Saved directly |
| Write | Apply at once | Saved directly |

In every mode, changes that touch an agent's instructions page, a page titled "Agent protocol" or
one titled "Agent command: …" (creating, renaming to, editing, appending, moving or trashing
it), wait for review. Those pages
steer every agent that reads them, so one agent cannot rewrite another's instructions.

An agent's instructions page lives in its first workspace's Agent Hub. If that page is trashed,
or the agent's workspaces change so it can no longer see it, Suivelle makes a new one there with
the old text: at once when the agent is saved, and otherwise within the hourly upkeep.

`whoami` returns the agent's instructions and, when one of its workspaces has a page titled
"Agent protocol", that page's text too, so a protocol shared by every agent costs no extra call.

### Carrying on after a review

Suivelle never contacts an agent, so an agent that depends on a pending change asks to hear the
decision with `proposal_wait(proposal_id)` (the "submitted for review" reply suggests it):

- **While its session is open**, the call stays open (up to `timeout_seconds`, default 300, at
  most 600) and returns the decision and your note the moment you approve or reject, so the agent
  continues in the same turn. Waiting checks the database every half second in short calls and
  never holds it; turning the agent API off or pausing the agent ends the wait.
- **If nobody is waiting when you decide** (the wait ran out, the session ended, or the agent
  passed `timeout_seconds: 0`), Suivelle queues a task "Continue: <proposal title>" for that
  agent in the Agent tasks database, with the outcome and your note. Its next session picks it up
  through `task_next` (or the protocol's start). Approvals, rejections and approvals that failed
  to apply all count; proposals nobody asked about queue nothing.

The Review inbox says when the agent is waiting right now, or will get a Continue task.

The default for new agents, and whether edits made in mirror folders wait for review or apply,
are set in Settings > Agents. Reviewing shows a line diff per change; approve all, approve
some, or reject with a note the agent reads through `proposal_status`. A proposal whose page
changed after it was made (its `base_hash` no longer matches) fails with the reason rather than
overwriting newer work.

## Tools

`whoami` and `command` (the steps of `/suivelle_…` commands, or the default protocol) always,
and by group:

- **pages**: `search`, `page_read` (Markdown with front matter and a content hash), `page_list`,
  `page_create`, `page_update`, `changes_propose` (several operations, all or nothing, with
  `key:` references to pages created earlier in the same proposal), `proposal_status`.
  (`proposal_wait` is available to every agent.)
- **graph**: `graph_neighbors` (1–3 hops over hierarchy, links and relations),
  `graph_backlinks` (optionally unlinked mentions), `graph_path`, `tags`.
- **db**: `databases_list`, `records_query`, `record_create`, `record_update` (values by property
  and option *name*).
- **memory**: `memory_recall`, `memory_write` (supersede instead of overwrite), `memory_forget`,
  `context_pack`.
- **tasks**: `task_next` (claims for 30 minutes), `task_heartbeat`, `task_complete`, `task_fail`,
  `task_list`, `task_create`, `todos`, `todo_promote`.
- **janitor**: `janitor_report`.

Pages as Markdown: mentions are `[Title](suivelle://page/<id>)`; `[[Title]]`, `[[Title|label]]`
link by title or alias. Blocks Markdown cannot carry (media, embeds, database views, columns,
callouts, synced blocks) appear as `<!-- suivelle:keep <block id> … -->`; keeping the line keeps
the block, removing it removes the block (page history keeps it). Unchanged blocks keep their
identities when a page is rewritten.

## Plain-text mirror

Settings > Agents > Plain-text mirror (per workspace, opt-in, into an empty folder). Each page is
`<title>.md` with subpages in a folder of the same name; records sit in their database's folder.
Front matter holds `id`, `title`, `kind`, `created_by`, `aliases`, `tags` and record
`properties` (JSON values, valid YAML). Output is deterministic and files are rewritten only
when their content changes, so the folder works well under git.

Edits in the folder are read back every few seconds: renames (front matter title or file name),
aliases, record properties and body text. New `.md` files become pages under the page whose
folder they are in; deleted files propose trashing their page. When a page changed in both
places, the folder's version becomes a proposal and a `.conflict.md` copy, and the app's version
is written back. Files the mirror did not write are never deleted; a folder with more than 50
foreign files is refused (use Import instead).

## Vault upkeep

Review inbox > Vault health runs read-only checks: broken links, unresolved `[[links]]` (with a
likely-match alias fix), duplicate titles, empty and isolated pages, tag spellings, stale or
superseded memories, expired leases and stuck tasks, and proposals waiting over a week. Chosen
fixes apply as one changeset. Hourly, without review, Suivelle requeues tasks whose lease ran out
and marks memories past their expiry date.

## Verification (15 October 2026)

- Rust: 14 agent tests (Markdown round trip with kept blocks and stable ids; mentions and
  wikilinks resolving when the target appears; aliases; token, scope and pause enforcement; tool
  groups and read-only refusal; propose/auto/write; atomic batched proposals; stale proposals;
  revert; memory supersede/forget; task claims, leases and to-do check-off; janitor fixes; the
  mirror's write, propose, apply, conflict and trash paths; subagent and AGENTS.md export with
  hand-edit detection; a full MCP session over loopback TCP), plus the full library suite.
- Bridge: relay and refused-token integration tests run the real `suivelle-mcp` binary.
- Frontend: typecheck, lint, the full test suite (including the line diff), and browser checks of
  the Review inbox, Vault health, Settings > Agents and the Node Map agent highlight against the
  showcase backend.

Connect apps (15 October 2026): 15 Rust tests (the catalogue; JSON/JSONC and TOML edits that
keep comments, order, CRLF and trailing commas and restore the file exactly on disconnect;
detection in a fake home folder; connect, status, token rotation, repair, hand-edit detection
and disconnect; missing files and sections; replacing a foreign entry only when asked; every
Antigravity config; Codex TOML and manual connections; a missing connector creating nothing;
the connector copy; an app's command line with fallback to the file; Credential Manager; subagent
import), and component tests of the connect sheet.

Session-start lines and commands (15 October 2026): Rust tests of adding the block once (empty,
LF and CRLF files, lines added by hand, a hand-edited block) and removing it exactly; each app's
command file format and typed name; connect writing both, leaving a foreign command file alone,
Edited status and Repair after a file is removed, disconnect restoring `CLAUDE.md` byte for
byte; Gemini CLI and Antigravity sharing `GEMINI.md`; opting out; the `command` tool, page
overrides and their review guard; MCP prompts over loopback. A read-only dry run on a real
machine wrapped the existing hand-added lines in `CLAUDE.md` and Codex's `AGENTS.md` without
doubling them. Component tests cover the two checkboxes and the card line.

Carrying on after a review (15 October 2026): Rust tests of follow-up tasks after approval and
rejection (with the note, queued once, picked up by `task_next`), none for proposals nobody asked
about or while a session waits, ownership checks, and a real `proposal_wait` over loopback that a
decision from another thread ends without a follow-up task. Browser check of the inbox note.

## Not yet done

- Project-scoped configs (`.mcp.json`, a repository's `.cursor/mcp.json`).
- Command files for Windsurf and Antigravity workflows, and writing VS Code user instructions
  files; until their user-level folders are confirmed they use MCP prompts and pasted lines.
- The system keychain on macOS and Linux (tokens stay in the config's environment there).
- Two-way check-off from a to-do to its task (finishing the task checks the to-do; checking the
  to-do does not yet finish the task).
- Local semantic search is deliberately deferred.
