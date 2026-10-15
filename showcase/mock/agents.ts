/** Read-only sample data for the agents views (Settings > Agents, the Review inbox, Activity and Vault health). */
const AGENT_ID = "0198f0aa-0000-7000-8000-00000000a6e1";
const STAMP = "2026-10-14T09:30:00.000Z";

// biome-ignore lint/suspicious/noExplicitAny: the showcase store is untyped sample data.
export function agentsDispatch(db: any, cmd: string, a: any): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: sample pages.
  const pages = db.pages.filter((p: any) => !p.deletedAt && p.kind === "page");
  const [first, second] = pages;
  const agent = { id: AGENT_ID, name: "Librarian", role: "Keeps the wiki linked, tidy and up to date", status: "active", mode: "propose", workspaceIds: [db.workspaces[0].id], tools: ["pages", "graph", "memory", "tasks", "janitor"], model: "sonnet", instructionsPageId: null, tokenHint: "9f2c", createdAt: STAMP, updatedAt: STAMP, lastSeenAt: STAMP };
  const proposal = {
    id: "0198f0aa-0000-7000-8000-00000000a6e2", actorKind: "agent", agentId: AGENT_ID, agentName: "Librarian", workspaceId: db.workspaces[0].id,
    title: `Link “${second?.title ?? "Notes"}” from “${first?.title ?? "Home"}”`, rationale: "Both pages describe the same milestone; a link makes the connection visible in the node map.",
    status: "pending", error: null, decisionNote: null, changesetId: null, createdAt: STAMP, decidedAt: null, opCount: 1, resume: true, agentWaiting: true,
    ops: [{ op: "update_content", summary: "Add to the page", pageId: first?.id ?? null, pageTitle: first?.title ?? null, before: "Plans for the release.\n\nOpen questions are listed below.", after: `Plans for the release.\n\nOpen questions are listed below.\n\nSee also [[${second?.title ?? "Notes"}]].` }],
  };
  switch (cmd) {
    case "agents_overview": return { settings: { apiEnabled: true, defaultMode: "propose", mirrorEdits: "propose" }, agents: [agent], port: null, bridgePath: null, pending: 1 };
    case "agent_audit": return [];
    case "proposal_list": return a.status === "pending" || a.status === "all" ? [proposal] : [];
    case "proposal_detail": return proposal;
    case "changeset_list": return [{ id: "0198f0aa-0000-7000-8000-00000000a6e3", actorKind: "agent", actorId: AGENT_ID, actorName: "Librarian", proposalId: null, summary: "Memory: Releases ship on Tuesdays", createdAt: STAMP, revertedAt: null, pages: [] }];
    case "janitor_report": return [
      { check: "unresolved_links", severity: "info", title: "[[Roadmap 2027]] has no page", detail: "2 mention(s). Creating a page called “Roadmap 2027” links them.", pageId: first?.id ?? null, fix: { op: "create_page", title: "Roadmap 2027" } },
      { check: "tag_variants", severity: "info", title: "2 spellings of #todo", detail: "#todo (6), #to-do (2). Pick one spelling so tag pages collect everything.", pageId: null },
    ];
    case "mirror_get": return { enabled: false, path: "", lastSync: null, lastError: null, files: 0 };
    case "clients_scan": {
      const app = (id: string, name: string, path: string, status: string, extra: object = {}) => ({ id, name, installed: true, found: [path], configPaths: [path], method: "file", status, detail: null, agentId: null, agentName: null, connectedAt: null, connectedBy: null, credential: true, restart: `Restart ${name} to use Suivelle.`, instructionsPath: null, instructionsPlace: null, instructionsAdded: false, commands: ["init", "setup", "sync", "wrap-up"].map((c) => `/suivelle_${c}`), commandsAdded: false, extrasPending: false, startLines: "<!-- suivelle:start -->\n# Suivelle context management\nAt the start of a session, call suivelle whoami and follow the instructions it returns. If Suivelle is not available, say so once and continue without it.\n<!-- suivelle:end -->", ...extra });
      return {
        clients: [
          app("claude-code", "Claude Code", "C:/Users/you/.claude.json", "connected", { method: "cli", agentId: AGENT_ID, agentName: "Librarian", connectedAt: STAMP, connectedBy: "cli", instructionsPath: "C:/Users/you/.claude/CLAUDE.md", instructionsAdded: true, commandsAdded: true }),
          app("codex", "Codex", "C:/Users/you/.codex/config.toml", "not_connected", { method: "cli", instructionsPath: "C:/Users/you/.codex/AGENTS.md", commands: ["init", "setup", "sync", "wrap-up"].map((c) => `/prompts:suivelle_${c}`) }),
          app("cursor", "Cursor", "C:/Users/you/.cursor/mcp.json", "not_connected", { instructionsPlace: "Cursor Settings > Rules > User Rules" }),
          app("antigravity", "Antigravity", "C:/Users/you/.gemini/antigravity/mcp_config.json", "foreign", { detail: "A server named “suivelle” is already set up there, but not by this copy of Suivelle.", instructionsPath: "C:/Users/you/.gemini/GEMINI.md", commands: [] }),
        ],
        known: ["Claude Code", "Claude Desktop", "Codex", "Antigravity", "Gemini CLI", "Cursor", "VS Code", "Windsurf", "opencode", "Zed"],
        bundled: "C:/Program Files/Suivelle/suivelle-mcp.exe",
        devBuild: false,
        credentials: true,
      };
    }
    default: return undefined;
  }
}

export const AGENT_READ_COMMANDS = ["agents_overview", "agent_audit", "proposal_list", "proposal_detail", "changeset_list", "janitor_report", "mirror_get", "clients_scan"];
