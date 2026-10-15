//! The `/suivelle_…` commands agent apps offer. Their text lives here (with a page per command to
//! override it) and reaches agents two ways: the `command` tool, which the small command files
//! Connect writes into each app call, and MCP prompts for apps without command files.

use super::Agent;
use crate::errors::{AppError, AppResult};
use rusqlite::Connection;

pub struct Command {
    pub name: &'static str,
    pub description: &'static str,
    text: &'static str,
}

/// Title prefix of a page that replaces a command's built-in text, e.g. "Agent command: sync".
pub const OVERRIDE_PREFIX: &str = "Agent command:";

/// The lines that make an app start every session from Suivelle.
pub const START_LINES: &str = "# Suivelle context management\nAt the start of a session, call suivelle whoami and follow the instructions it returns. If Suivelle is not available, say so once and continue without it.";

pub const COMMANDS: &[Command] = &[
    Command {
        name: "init",
        description: "Set up Suivelle for this app (once per computer)",
        text: "# /suivelle_init: set up Suivelle for this app\n\n\
1. Call whoami. Report your agent name, mode and workspaces in one line.\n\
2. Session-start lines. {instructions} The block, exactly:\n\n\
```\n<!-- suivelle:start -->\n{start_lines}\n<!-- suivelle:end -->\n```\n\n\
   If these lines are already there (with or without the markers), leave them. Otherwise show the user the block and where it goes, and add it at the end only if they agree. Change nothing else.\n\
3. Agent protocol. If whoami had no \"## Agent protocol\" section, get the default with command(name=\"protocol\") and create it with page_create(title=\"Agent protocol\"); it waits for the user's review.\n\
4. Finish with one line: what was in place, what you added, what awaits review. Suggest /suivelle_setup in a project next.",
    },
    Command {
        name: "setup",
        description: "Set up the current project in Suivelle",
        text: "# /suivelle_setup: set up this project in Suivelle\n\n\
1. Resolve [Project]: manifest name (package.json, Cargo.toml, pyproject.toml, …), else git remote repo name, else folder name. Search Suivelle for \"[Project] project\" (titles_only).\n\
2. If it exists, give its page id, suggest /suivelle_sync and stop. If proposal_status shows a pending proposal creating it, say it awaits review and stop.\n\
3. Otherwise, without asking again:\n\
   - Read README, AGENTS.md, CLAUDE.md, PRODUCT.md, CONTRIBUTING, the top level of docs/, manifests and the top-level folder list. Skip files over about 50 KB; never read .env, secrets or gitignored files.\n\
   - In ONE changes_propose, create \"[Project] project\" with subpages Overview, Stack and layout, Architecture, Conventions, Decisions, and Releasing (only if there is a release process), linked from the hub with `[[Title]]` links. Factual, concise, cite file paths.\n\
   - One memory_recall(scope=\"[Project]\"), then memory_write(scope=\"[Project]\", kind Fact or Decision, the why in the body) for each lasting rule or decision not yet recorded.\n\
   - task_create for documented TODOs and roadmap items.\n\
   - janitor_report, and fix what it finds.\n\
4. Finish with one line: pages, memories and tasks created, and whether the pages await review.",
    },
    Command {
        name: "sync",
        description: "Bring the project's Suivelle pages up to date with the repo",
        text: "# /suivelle_sync: bring the project pages up to date\n\n\
1. Resolve [Project] and find \"[Project] project\" (titles_only). If it is missing, suggest /suivelle_setup and stop.\n\
2. context_pack(page_id=<hub>, budget_tokens=4000), and page_list for its subpages.\n\
3. Compare with the repo: the files the pages cite, the manifests, and what changed since the pages were updated (git log --since=<date> --name-only when git is available). Skip files over about 50 KB; never read secrets.\n\
4. In ONE changes_propose: update_content (page_read first, pass base_hash) for pages that are out of date, create_page for major areas that have none. Keep text that is still right.\n\
5. For facts that changed, memory_write with supersedes; memory_forget facts that no longer hold.\n\
6. Finish with a short list of what changed and why.",
    },
    Command {
        name: "wrap-up",
        description: "Save this session's decisions, page updates and tasks to Suivelle",
        text: "# /suivelle_wrap-up: save what this session decided\n\n\
1. Resolve [Project]. From this conversation, list decisions made, lasting facts learned, work finished and work left open. Skip the trivial; one memory_recall(scope=\"[Project]\") shows what is already recorded.\n\
2. memory_write(scope=\"[Project]\") for each new decision or fact, with the why; use supersedes when it replaces a memory.\n\
3. If architecture or conventions changed, update the affected \"[Project] project\" subpage (page_read, then page_update with base_hash).\n\
4. task_complete for tasks finished here; task_create for work left open.\n\
5. Finish with one short list: memories, pages and tasks touched.",
    },
];

/// The default "Agent protocol" page, which `/suivelle_init` creates when there is none.
pub const PROTOCOL: &str = "# Suivelle MCP Protocol\n\n\
This page is included in whoami; there is no need to page_read it.\n\n\
## 1. Session start (in a code repository only)\n\n\
Skip this section for questions that don't need project context. Run it before the first task that does.\n\n\
1. **Resolve [Project]:** package manifest name (package.json, Cargo.toml, pyproject.toml, …) → git remote repo name → folder name.\n\
2. **Find the hub:** search Suivelle for \"[Project] project\" (titles_only).\n\
3. **Hub found:** context_pack(page_id=<hub id>, query=\"<task topic>\", budget_tokens=2000) before reading repo files. It already includes matching memories; call memory_recall(scope=\"[Project]\", limit=5) only for a fact the pack did not cover.\n\
4. **Hub not found:** if proposal_status shows a pending proposal creating it, say it awaits review and continue. Otherwise ask the user once whether to set up [Project]; if yes, follow /suivelle_setup (command(name=\"setup\")).\n\n\
## 2. During the session\n\n\
- **Record:** new lasting facts or decisions via memory_write(scope=\"[Project]\").\n\
- **Correct:** to change a memory, write a new one with supersedes; never duplicate.\n\
- **Sync pages:** when architecture or conventions change, page_read the subpage, then page_update with base_hash.\n\
- **Isolation:** scope every query and write to [Project].\n\
- **Pending changes:** when a change waits for review and the task depends on it, call proposal_wait(proposal_id); if the wait runs out, finish what you can and stop: a \"Continue: …\" task brings the decision to your next session.\n\
- **End:** before the user leaves, offer /suivelle_wrap-up when decisions were made.";

pub fn find(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name)
}

/// A live page with exactly this title (ignoring case) in the agent's first workspace that has one.
pub fn page_titled(conn: &Connection, agent: &Agent, title: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM page WHERE workspace_id = ?1 AND deleted_at IS NULL AND title = ?2 COLLATE NOCASE ORDER BY created_at LIMIT 1",
    )?;
    for ws in &agent.workspace_ids {
        if let Some(id) = stmt.query_map(rusqlite::params![ws, title], |r| r.get::<_, String>(0))?.next() {
            return Ok(Some(id?));
        }
    }
    Ok(None)
}

/// Where the session-start lines go for the app this agent is connected through.
fn instructions_hint(conn: &Connection, agent: &Agent) -> String {
    let generic = "Find your app's user-level instructions file (Claude Code: ~/.claude/CLAUDE.md, Codex: ~/.codex/AGENTS.md, Gemini CLI: ~/.gemini/GEMINI.md, opencode: ~/.config/opencode/AGENTS.md).".to_string();
    let Ok(Some(client)) = super::clients::client_of(conn, &agent.id) else { return generic };
    match super::clients::instructions_target(&client) {
        Some(super::clients::Instructions::File(path)) => format!("Your app reads user-level instructions from `{}`.", path.display()),
        Some(super::clients::Instructions::Place(place)) => {
            format!("Your app keeps user-level instructions in {place}; you cannot edit that, so show the user the block and ask them to paste it there.")
        }
        None => generic,
    }
}

/// The text of a command for this agent: an "Agent command: <name>" page when there is one,
/// otherwise the built-in text. `protocol` gives the default Agent protocol.
pub fn text(conn: &Connection, agent: &Agent, name: &str, arguments: Option<&str>) -> AppResult<String> {
    if name == "protocol" {
        return Ok(PROTOCOL.to_string());
    }
    let cmd = find(name).ok_or_else(|| AppError::Validation(format!("Unknown command '{name}'. Use init, setup, sync, wrap-up or protocol.")))?;
    let body = match page_titled(conn, agent, &format!("{OVERRIDE_PREFIX} {name}"))? {
        Some(id) => super::content::body_markdown(conn, &id)?,
        None => cmd.text.to_string(),
    };
    let mut out = body.replace("{start_lines}", START_LINES);
    if out.contains("{instructions}") {
        out = out.replace("{instructions}", &instructions_hint(conn, agent));
    }
    if let Some(a) = arguments.map(str::trim).filter(|a| !a.is_empty() && *a != "$ARGUMENTS" && *a != "{{args}}") {
        out.push_str(&format!("\n\nThe user added: {a}"));
    }
    Ok(out)
}
