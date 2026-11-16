// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, AgentClient, AgentsOverview, ClientScan } from "./types";

const ipc = vi.hoisted(() => ({
  agentsOverview: vi.fn(),
  clientsScan: vi.fn(),
  agentsUsage: vi.fn(),
  agentsUsageClear: vi.fn(),
  reaWorkflowStatus: vi.fn(),
  agentsSaveSettings: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ ipc, toAppError: (e: unknown) => ({ code: "x", message: String(e) }) }));
vi.mock("../../stores/workspace", () => {
  const state = { workspaces: [{ id: "ws1", name: "Lab" }], workspace: { id: "ws1", name: "Lab" }, selectedPage: null };
  return { useWorkspace: Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state }) };
});

import { AgentsSettings } from "./AgentsSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

const client = (id: string, name: string, agentId: string | null, status: AgentClient["status"]): AgentClient => ({
  id,
  name,
  installed: true,
  found: [],
  configPaths: [`C:/Users/me/.${id}/config`],
  method: "file",
  status,
  detail: null,
  agentId,
  agentName: agentId ? name : null,
  connectedAt: agentId ? "2026-10-15T00:00:00Z" : null,
  connectedBy: null,
  credential: true,
  restart: `Restart ${name}.`,
  instructionsPath: null,
  instructionsPlace: null,
  instructionsAdded: false,
  commands: [],
  commandsAdded: false,
  extrasPending: false,
  startLines: "",
  connectionConfigured: Boolean(agentId),
  instructionsRequested: null,
  commandsRequested: null,
  whoamiAt: null,
  commandPaths: [],
});

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  role: `${name} role`,
  model: "",
  mode: "propose",
  status: "active",
  workspaceIds: ["ws1"],
  tools: ["pages"],
  tokenHint: "abcd",
  instructionsPageId: null,
  lastSeenAt: null,
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
});

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset();
  const overview: AgentsOverview = {
    settings: { apiEnabled: true, defaultMode: "propose", mirrorEdits: "propose" },
    agents: [agent("a1", "Claude Code"), agent("a2", "Codex")],
    pending: 0,
    port: 4123,
    bridgePath: null,
  };
  const scan: ClientScan = {
    clients: [client("claude-code", "Claude Code", "a1", "connected"), client("codex", "Codex", "a2", "connected"), client("zed", "Zed", null, "not_connected")],
    known: ["Claude Code", "Codex", "Zed"],
    bundled: "C:/bin/suivelle-mcp.exe",
    devBuild: false,
    credentials: true,
  };
  ipc.agentsOverview.mockResolvedValue(overview);
  ipc.clientsScan.mockResolvedValue(scan);
  ipc.agentsUsage.mockResolvedValue({
    range: "7d",
    totals: { calls: 0, errors: 0, avgDurationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, savedTokens: 0, savingsPct: 0, jevCalls: 0, jevCacheHits: 0, jevErrors: 0, jevTokens: 0, jevQuestions: 0, jevAvgMs: 0, jevPruned: 0 },
    agents: [],
    tools: [],
    series: [],
    recent: [],
  });
  ipc.reaWorkflowStatus.mockResolvedValue({ bundledVersion: "1.0.0", installedVersion: null, installed: false, current: false, path: "", backups: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

it("renders per-agent sub-tabs and switches between individual agents and All", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentsSettings active />));

  const agentsTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes("Agents"))!;
  await act(async () => agentsTab.click());

  const subtabs = [...host.querySelectorAll<HTMLButtonElement>(".agx-subtabs [role='tab']")];
  expect(subtabs.map((b) => b.textContent)).toEqual(["Claude Code", "Codex", "Zed", "All (3)"]);
  expect(subtabs[0].getAttribute("aria-selected")).toBe("true");
  expect(host.textContent).toContain("Claude Code role");
  expect(host.textContent).not.toContain("Codex role");

  await act(async () => subtabs[1].click());
  expect(host.textContent).toContain("Codex role");
  expect(host.textContent).not.toContain("Claude Code role");

  await act(async () => subtabs[3].click());
  expect(host.textContent).toContain("Claude Code role");
  expect(host.textContent).toContain("Codex role");
});
