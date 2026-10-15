/** Local AI agents: mirrors the Rust `agents` module's serialized shapes. */

export type AgentMode = "propose" | "write" | "auto";
export const TOOL_GROUPS = ["pages", "graph", "db", "memory", "tasks", "janitor"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  pages: "Read and change pages",
  graph: "Follow links and tags",
  db: "Databases and records",
  memory: "Shared memory",
  tasks: "Task queue",
  janitor: "Vault health checks",
};

export const MODE_LABELS: Record<AgentMode, { title: string; hint: string }> = {
  propose: { title: "Propose", hint: "Every change to pages waits in the Review inbox." },
  auto: { title: "Auto", hint: "New pages, records and additions apply at once; edits to your pages wait for review." },
  write: { title: "Write", hint: "Changes apply at once. You can still revert them from Activity." },
};

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: "active" | "paused";
  mode: AgentMode;
  workspaceIds: string[];
  tools: ToolGroup[];
  model: string;
  instructionsPageId: string | null;
  tokenHint: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export interface AgentInput {
  name: string;
  role: string;
  status?: "active" | "paused";
  mode?: AgentMode;
  workspaceIds: string[];
  tools: ToolGroup[];
  model: string;
}

export interface AgentSettings {
  apiEnabled: boolean;
  defaultMode: AgentMode;
  mirrorEdits: "propose" | "apply";
}

export interface AgentsOverview {
  settings: AgentSettings;
  agents: Agent[];
  port: number | null;
  bridgePath: string | null;
  pending: number;
}

export interface AuditEntry { agentId: string; tool: string; ok: boolean; durationMs: number; createdAt: string }

/** One change inside a proposal, as the backend stores it. */
export type Op = { op: string } & Record<string, unknown>;

export interface OpPreview {
  op: string;
  summary: string;
  pageId: string | null;
  pageTitle: string | null;
  before: string | null;
  after: string | null;
}

export type ProposalStatus = "pending" | "applied" | "rejected" | "failed";

export interface Proposal {
  id: string;
  actorKind: "agent" | "mirror";
  agentId: string | null;
  agentName: string | null;
  workspaceId: string;
  title: string;
  rationale: string;
  status: ProposalStatus;
  error: string | null;
  decisionNote: string | null;
  changesetId: string | null;
  createdAt: string;
  decidedAt: string | null;
  opCount: number;
  ops: OpPreview[];
  /** The agent asked to hear the decision. */
  resume: boolean;
  /** The agent's session is waiting for the decision right now. */
  agentWaiting: boolean;
}

export interface ChangedPage { pageId: string; title: string | null; op: string }

export interface Changeset {
  id: string;
  actorKind: "agent" | "mirror" | "janitor" | "user";
  actorId: string | null;
  actorName: string | null;
  proposalId: string | null;
  summary: string;
  createdAt: string;
  revertedAt: string | null;
  pages: ChangedPage[];
}

export interface Finding {
  check: string;
  severity: "info" | "warning" | "problem";
  title: string;
  detail: string;
  pageId: string | null;
  fix?: Op;
}

export interface MirrorConfig {
  enabled: boolean;
  path: string;
  lastSync: string | null;
  lastError: string | null;
  files: number;
}

export interface Exported { path: string; status: "created" | "updated" | "unchanged" | "modified" }

/** Payload of the "agent-activity" event. */
export interface AgentActivity {
  agentId?: string;
  agentName?: string;
  tool?: string;
  pageIds?: string[];
  proposalId?: string | null;
  proposalStatus?: "applied" | "pending" | null;
}

/** Agent apps on this computer (Settings > Agents > Connect apps). */
export type ClientState = "not_connected" | "foreign" | "waiting" | "connected" | "paused" | "out_of_date" | "edited" | "removed" | "unreadable";

export interface AgentClient {
  id: string;
  name: string;
  installed: boolean;
  found: string[];
  configPaths: string[];
  /** What Connect uses: the app's own command line, or editing its config file. */
  method: "cli" | "file";
  status: ClientState;
  detail: string | null;
  agentId: string | null;
  agentName: string | null;
  connectedAt: string | null;
  connectedBy: "file" | "cli" | "manual" | null;
  credential: boolean;
  restart: string;
  /** The user-level instructions file the session-start lines go in. */
  instructionsPath: string | null;
  /** For apps without such a file: where to paste the lines. */
  instructionsPlace: string | null;
  instructionsAdded: boolean;
  /** The /suivelle_… commands as typed in this app; empty when it only offers MCP prompts. */
  commands: string[];
  commandsAdded: boolean;
  /** The session-start lines, for pasting by hand. */
  startLines: string;
  /** Connected before start lines and commands existed; Repair adds them. */
  extrasPending: boolean;
}

export interface ClientScan {
  clients: AgentClient[];
  known: string[];
  bundled: string | null;
  devBuild: boolean;
  credentials: boolean;
}

export interface ConnectInput {
  agentId?: string | null;
  agent?: AgentInput | null;
  replace?: boolean;
  manual?: boolean;
  /** Add the session-start lines to the app's instructions file (default true). */
  instructions?: boolean;
  /** Add the /suivelle_… command files (default true). */
  commands?: boolean;
}

export interface ConnectResult {
  client: AgentClient;
  method: "file" | "cli" | "manual";
  changed: string[];
  backups: string[];
  snippet: string | null;
  notes: string[];
}

export interface DisconnectResult { client: AgentClient; notes: string[] }

export interface Subagent { path: string; name: string; description: string; model: string; fromSuivelle: boolean; exists: boolean }
export interface SubagentScan { folder: string; items: Subagent[] }
export interface ImportedSubagent { path: string; name: string; agentId: string | null; error: string | null }
