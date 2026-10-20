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
    case "rea_workflow_status": return { bundledVersion: "1.0.0", installedVersion: null, installed: false, current: false, path: "C:/Users/me/.agents/skills/rea-workflow", backups: [] };
    case "agents_overview": return { settings: { apiEnabled: true, defaultMode: "propose", mirrorEdits: "propose", jevEnabled: false, jevKeyHint: null }, agents: [agent], port: null, bridgePath: null, pending: 1 };
    case "agents_jev_health": return { ok: true, status: 200, latencyMs: 42, model: "jev-latest", message: "Healthy · connected to TypeSafe AI (jev-latest) in 42 ms." };
    case "agent_audit": return [];
    case "agents_usage": return {
      range: a?.range ?? "7d",
      totals: { calls: 18, errors: 0, avgDurationMs: 21, inputTokens: 640, outputTokens: 8420, totalTokens: 9060, savedTokens: 3180, savingsPct: 27.4, jevCalls: 6, jevCacheHits: 4, jevErrors: 0, jevTokens: 1420, jevQuestions: 48, jevAvgMs: 44, jevPruned: 19 },
      agents: [{ agentId: AGENT_ID, agentName: "Librarian", role: agent.role, model: "sonnet", status: "active", lastSeenAt: STAMP, clientId: "claude-code", clientName: "Claude Code", calls: 18, errors: 0, avgDurationMs: 21, inputTokens: 640, outputTokens: 8420, totalTokens: 9060, savedTokens: 3180, savingsPct: 27.4, jevCalls: 6, jevCacheHits: 4, jevTokens: 1420, jevPruned: 19, topTools: ["context_pack", "memory_recall", "memory_write"] }],
      tools: [
        { tool: "context_pack", calls: 7, errors: 0, avgDurationMs: 28, inputTokens: 210, outputTokens: 5400, totalTokens: 5610, savedTokens: 2420, jevCalls: 4, jevCacheHits: 3, jevTokens: 980, jevPruned: 14 },
        { tool: "memory_recall", calls: 6, errors: 0, avgDurationMs: 18, inputTokens: 180, outputTokens: 2210, totalTokens: 2390, savedTokens: 580, jevCalls: 1, jevCacheHits: 1, jevTokens: 260, jevPruned: 4 },
        { tool: "memory_write", calls: 5, errors: 0, avgDurationMs: 14, inputTokens: 250, outputTokens: 810, totalTokens: 1060, savedTokens: 180, jevCalls: 1, jevCacheHits: 0, jevTokens: 180, jevPruned: 1 },
      ],
      series: [
        { key: "2026-10-12", label: "Oct 12", calls: 4, inputTokens: 140, outputTokens: 1820, savedTokens: 620, jevTokens: 310 },
        { key: "2026-10-13", label: "Oct 13", calls: 6, inputTokens: 210, outputTokens: 2940, savedTokens: 1120, jevTokens: 520 },
        { key: "2026-10-14", label: "Oct 14", calls: 8, inputTokens: 290, outputTokens: 3660, savedTokens: 1440, jevTokens: 590 },
      ],
      recent: [
        { agentId: AGENT_ID, agentName: "Librarian", tool: "context_pack", ok: true, durationMs: 26, createdAt: STAMP, inputTokens: 32, outputTokens: 780, savedTokens: 340, jevCalls: 1, jevCacheHits: 0, jevErrors: 0, jevTokens: 190, jevQuestions: 8, jevMs: 42, jevPruned: 3 },
      ],
    };
    case "proposal_list": return a.status === "pending" || a.status === "all" ? [proposal] : [];
    case "proposal_detail": return proposal;
    case "changeset_list": return [{ id: "0198f0aa-0000-7000-8000-00000000a6e3", actorKind: "agent", actorId: AGENT_ID, actorName: "Librarian", proposalId: null, summary: "Memory: Releases ship on Tuesdays", createdAt: STAMP, revertedAt: null, pages: [] }];
    case "janitor_report": return [
      { check: "unresolved_links", severity: "info", title: "[[Roadmap 2027]] has no page", detail: "2 mention(s). Creating a page called “Roadmap 2027” links them.", pageId: first?.id ?? null, fix: { op: "create_page", title: "Roadmap 2027" } },
      { check: "tag_variants", severity: "info", title: "2 spellings of #todo", detail: "#todo (6), #to-do (2). Pick one spelling so tag pages collect everything.", pageId: null },
    ];
    case "mirror_get": return { enabled: false, path: "", lastSync: null, lastError: null, files: 0 };
    case "clients_scan": {
      const app = (id: string, name: string, path: string, status: string, extra: object = {}) => ({ id, name, installed: true, found: [path], configPaths: [path], method: "file", status, detail: null, agentId: null, agentName: null, connectedAt: null, connectedBy: null, credential: true, restart: `Restart ${name} to use Suivelle.`, instructionsPath: null, instructionsPlace: null, instructionsAdded: false, commands: ["init", "setup", "sync", "wrap-up"].map((c) => `/suivelle_${c}`), commandsAdded: false, extrasPending: false, connectionConfigured: status === "connected", instructionsRequested: true, commandsRequested: true, commandPaths: [], whoamiAt: status === "connected" ? STAMP : null, startLines: "<!-- suivelle:start -->\n# Suivelle context management\nAt the start of a session, call suivelle whoami and follow the instructions it returns. If Suivelle is not available, say so once and continue without it.\n<!-- suivelle:end -->", ...extra });
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

export const AGENT_READ_COMMANDS = ["agents_overview", "agents_jev_health", "rea_workflow_status", "agent_audit", "agents_usage", "proposal_list", "proposal_detail", "changeset_list", "janitor_report", "mirror_get", "clients_scan"];
