// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentClient, AgentSettings, ClientScan } from "./types";

const ipc = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientRepair: vi.fn(),
  clientSetupFiles: vi.fn(),
  reaWorkflowStatus: vi.fn(),
  reaWorkflowInstall: vi.fn(),
  clientDisconnect: vi.fn(),
  agentsSaveSettings: vi.fn(),
  agentsUsage: vi.fn(),
  agentsUsageClear: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ ipc, toAppError: (e: unknown) => ({ code: "x", message: String(e) }) }));
vi.mock("../../stores/workspace", () => {
  const state = { workspaces: [{ id: "ws1", name: "Lab" }, { id: "ws2", name: "Home" }], workspace: { id: "ws1", name: "Lab" } };
  return { useWorkspace: (pick: (s: typeof state) => unknown) => pick(state) };
});

import { ConnectApps } from "./ConnectApps";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.reaWorkflowStatus.mockResolvedValue({ bundledVersion: "1.0.0", installedVersion: null, installed: false, current: false, path: "C:/Users/me/.agents/skills/rea-workflow", backups: [] });
  ipc.agentsUsage.mockResolvedValue({
    range: "7d",
    totals: {
      calls: 0, errors: 0, avgDurationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, savedTokens: 0,
      savingsPct: 0, jevCalls: 0, jevCacheHits: 0,
      jevErrors: 0, jevTokens: 0, jevQuestions: 0, jevAvgMs: 0, jevPruned: 0,
    },
    agents: [],
    tools: [],
    series: [],
    recent: [],
  });
});
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });

const settings: AgentSettings = { apiEnabled: false, defaultMode: "propose", mirrorEdits: "propose" };
function app(id: string, name: string, extra: Partial<AgentClient> = {}): AgentClient {
  return {
    id, name, installed: true, found: [], configPaths: [`C:/Users/me/.${id}/config`], method: "file", status: "not_connected", detail: null, agentId: null, agentName: null, connectedAt: null, connectedBy: null, credential: true, restart: `Restart ${name}.`,
    instructionsPath: `C:/Users/me/.${id}/AGENTS.md`, instructionsPlace: null, instructionsAdded: false, commands: [`/suivelle_init`, `/suivelle_wrap-up`], commandsAdded: false, extrasPending: false, startLines: "<!-- suivelle:start -->\nlines\n<!-- suivelle:end -->",
    connectionConfigured: false, instructionsRequested: null, commandsRequested: null, whoamiAt: null, commandPaths: [],
    ...extra,
  };
}
const scan = (clients: AgentClient[]): ClientScan => ({ clients, known: clients.map((c) => c.name), bundled: "C:/bin/suivelle-mcp.exe", devBuild: false, credentials: true });

async function mount(s: ClientScan, onChanged = vi.fn(), onScan = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ConnectApps scan={s} agents={[]} settings={settings} onScan={onScan} onChanged={onChanged} />));
  return onChanged;
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

it("shows what will change and connects with a new agent per app", async () => {
  ipc.clientConnect.mockImplementation(async (id: string) => ({
    client: app(id, "Codex", { status: "waiting", agentName: "Codex", connectedAt: "2026-10-15T00:00:00Z" }),
    method: "file", changed: ["C:/Users/me/.codex/config"], backups: [], snippet: null, notes: [],
  }));
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const changed = await mount(scan([app("codex", "Codex")]));
  await act(async () => button("Connect…").click());
  expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
  expect(document.activeElement?.tagName).toBe("SELECT");
  expect(host.textContent).toContain("Adds a “suivelle” server to C:/Users/me/.codex/config");
  expect(host.textContent).toContain("Windows Credential Manager");
  // Start lines and commands are ticked by default and say what they change.
  const extras = [...host.querySelectorAll<HTMLInputElement>(".agx-extra input")];
  expect(extras.map((i) => i.checked)).toEqual([true, true]);
  expect(host.textContent).toContain("Adds 3 lines to C:/Users/me/.codex/AGENTS.md");
  expect(host.textContent).toContain("/suivelle_init  /suivelle_wrap-up");
  await act(async () => extras[1].click());
  await act(async () => button("Connect").click());
  expect(ipc.agentsSaveSettings).toHaveBeenCalledWith({ ...settings, apiEnabled: true });
  expect(ipc.clientConnect).toHaveBeenCalledWith("codex", {
    agentId: null,
    agent: { name: "Codex", role: "", model: "", mode: "propose", workspaceIds: ["ws1"], tools: ["pages", "graph", "memory", "tasks"] },
    replace: false,
    manual: false,
    instructions: true,
    commands: false,
  });
  expect(host.textContent).toContain("Connected Codex (in config) as agent “Codex”. Restart Codex.");
  expect(changed).toHaveBeenCalled();
});

it("connects every app at once and reports each one", async () => {
  ipc.clientConnect.mockImplementation(async (id: string) => {
    if (id === "cursor") throw "Cursor's config is not valid JSON";
    return { client: app(id, "Codex", { status: "waiting", agentName: "Codex" }), method: "cli", changed: [], backups: [], snippet: null, notes: [] };
  });
  await mount(scan([app("codex", "Codex", { method: "cli" }), app("cursor", "Cursor", { instructionsPath: null, instructionsPlace: "Cursor Settings > Rules", commands: [] })]));
  await act(async () => button("Connect all…").click());
  expect(host.textContent).toContain("Connect 2 apps");
  expect(host.textContent).toContain("Cursor: lines to paste in its settings.");
  expect(host.textContent).toContain("Cursor offers them as MCP prompts instead.");
  expect(host.textContent).toContain("Runs Codex's own command");
  await act(async () => button("Connect").click());
  expect(ipc.clientConnect).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("with its own command");
  expect(host.textContent).toContain("Cursor's config is not valid JSON");
});

it("offers commands to apps connected before they existed", async () => {
  ipc.clientSetupFiles.mockResolvedValue({ client: app("codex", "Codex", { commandsAdded: true }), backups: [], notes: [] });
  await mount(scan([app("codex", "Codex", { status: "connected", agentId: "a1", agentName: "Codex", connectedAt: "2026-10-14T00:00:00Z", extrasPending: true })]));
  await act(async () => button("Set up commands").click());
  expect(ipc.clientSetupFiles).toHaveBeenCalledWith("codex", false, true);
  expect(ipc.clientRepair).not.toHaveBeenCalled();
});

it("keeps session verification pending after authentication and completes only on whoami evidence", async () => {
  const c = app("codex", "Codex", { status: "connected", connectedAt: "2026-10-18T00:00:00Z", connectionConfigured: true, instructionsAdded: true, commandsAdded: true });
  await mount(scan([c]));
  expect(host.textContent).toContain("2 of 3 complete");
  expect(host.querySelector('button[aria-label="Copy Codex session check"]')).toBeTruthy();
  await act(async () => root.render(<ConnectApps scan={scan([{ ...c, whoamiAt: "2026-10-18T00:01:00Z" }])} agents={[]} settings={settings} onScan={vi.fn()} onChanged={vi.fn()} />));
  expect(host.textContent).toContain("3 of 3 complete");
  expect(host.textContent).toContain("A successful whoami call was received");
  expect(host.querySelector('button[aria-label="Copy Codex session check"]')).toBeNull();
});

it("repairs only instructions and leaves an otherwise valid connection alone", async () => {
  const c = app("codex", "Codex", { status: "edited", connectedAt: "2026-10-18T00:00:00Z", connectionConfigured: true, instructionsRequested: true, commandsAdded: true });
  ipc.clientSetupFiles.mockResolvedValue({ client: { ...c, instructionsAdded: true }, backups: ["AGENTS.md.suivelle-backup"], notes: [] });
  const changed = await mount(scan([c]));
  expect(button("Repair connection")).toBeUndefined();
  await act(async () => button("Repair instructions").click());
  expect(ipc.clientSetupFiles).toHaveBeenCalledWith("codex", true, false);
  expect(ipc.clientRepair).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalled();
});

it("reports incomplete setup and retries without reconnecting", async () => {
  const c = app("codex", "Codex", { connectedAt: "2026-10-18T00:00:00Z", instructionsRequested: true });
  ipc.clientSetupFiles.mockResolvedValueOnce({ client: c, backups: [], notes: ["Could not add the session-start lines (access denied)."] });
  await mount(scan([c]));
  await act(async () => button("Repair instructions").click());
  expect(host.textContent).toContain("Setup is still incomplete.");
  expect(host.textContent).toContain("access denied");
  ipc.clientSetupFiles.mockRejectedValueOnce(new Error("read failed"));
  await act(async () => button("Repair instructions").click());
  expect(host.textContent).toContain("read failed");
  expect(button("Repair instructions").disabled).toBe(false);
  expect(ipc.clientRepair).not.toHaveBeenCalled();
});

it("makes manual instructions explicit and rechecks the actual scan", async () => {
  const c = app("cursor", "Cursor", { connectedAt: "2026-10-18T00:00:00Z", connectionConfigured: true, instructionsPath: null, instructionsPlace: "Cursor User Rules", commands: [] });
  const check = vi.fn().mockResolvedValue(undefined);
  await mount(scan([c]), vi.fn(), check);
  expect(host.textContent).toContain("Suivelle cannot verify that setting");
  expect(host.textContent).toContain("Commands are available as MCP prompts");
  expect(button("Set up instructions")).toBeUndefined();
  expect(host.querySelector('button[aria-label="Copy Cursor start lines"]')).toBeTruthy();
  await act(async () => button("Check again").click());
  expect(check).toHaveBeenCalledTimes(1);
});

it("respects skipped extras and does not start project setup or optional workflows", async () => {
  await mount(scan([app("codex", "Codex", { connectedAt: "2026-10-18T00:00:00Z", connectionConfigured: true, instructionsRequested: false, commandsRequested: false })]));
  expect(host.textContent).toContain("2 of 3 complete");
  expect(host.textContent).toContain("Session-start instructions were skipped");
  expect(host.textContent).toContain("Command files were skipped");
  expect([...host.querySelectorAll("pre")].some((p) => p.textContent?.includes("Do not run project setup or any optional workflow"))).toBe(true);
  expect(ipc.clientSetupFiles).not.toHaveBeenCalled();
  expect(ipc.clientConnect).not.toHaveBeenCalled();
});

it("offers the entry to paste, and repair or disconnect for connected apps", async () => {
  ipc.clientConnect.mockResolvedValue({ client: app("cursor", "Cursor", { status: "removed" }), method: "manual", changed: [], backups: [], snippet: "{\n  \"mcpServers\": {}\n}\n", notes: [] });
  ipc.clientDisconnect.mockResolvedValue({ client: app("zed", "Zed"), notes: [] });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await mount(scan([app("cursor", "Cursor"), app("zed", "Zed", { status: "out_of_date", agentId: "a1", agentName: "Zed", connectedAt: "2026-10-15T00:00:00Z", instructionsAdded: true, commandsAdded: true })]));
  expect(host.textContent).toContain("Starts from Suivelle (AGENTS.md) · /suivelle_init  /suivelle_wrap-up");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Add commands")).toBe(false);
  await act(async () => button("Connect…").click());
  await act(async () => button("Copy config instead").click());
  expect(ipc.clientConnect.mock.calls[0][1].manual).toBe(true);
  expect([...host.querySelectorAll("pre")].some((p) => p.textContent?.includes("mcpServers"))).toBe(true);
  expect(button("Repair connection")).toBeTruthy();
  await act(async () => button("Disconnect").click());
  expect(ipc.clientDisconnect).toHaveBeenCalledWith("zed");
  expect(host.textContent).toContain("Disconnected Zed.");
});

it("saves, toggles, checks health, and removes the optional Jev API key in AgentsSettings", async () => {
  const { AgentsSettings } = await import("./AgentsSettings");
  let savedSettings: AgentSettings = { apiEnabled: true, defaultMode: "propose", mirrorEdits: "propose", jevEnabled: false, jevKeyHint: null };
  (ipc as Record<string, unknown>).agentsOverview = vi.fn(async () => ({
    settings: savedSettings,
    agents: [],
    port: 51234,
    bridgePath: null,
    pending: 0,
  }));
  (ipc as Record<string, unknown>).clientsScan = vi.fn(async () => scan([]));
  (ipc as Record<string, unknown>).mirrorGet = vi.fn(async () => ({ enabled: false, path: "", lastSync: null, lastError: null, files: 0 }));
  (ipc as Record<string, unknown>).agentsJevHealth = vi.fn(async () => ({
    ok: true,
    status: 200,
    latencyMs: 38,
    model: "jev-latest",
    message: "Healthy · connected to TypeSafe AI (jev-latest) in 38 ms.",
  }));
  ipc.agentsSaveSettings.mockImplementation(async (next: AgentSettings) => {
    savedSettings = {
      apiEnabled: next.apiEnabled,
      defaultMode: next.defaultMode,
      mirrorEdits: next.mirrorEdits,
      jevEnabled: Boolean(next.jevEnabled && (next.jevApiKey !== "" && (next.jevApiKey || savedSettings.jevKeyHint))),
      jevKeyHint: next.jevApiKey === "" ? null : next.jevApiKey ? next.jevApiKey.slice(-4) : savedSettings.jevKeyHint,
    };
    return savedSettings;
  });

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentsSettings active={true} />));

  const input = host.querySelector<HTMLInputElement>('input[aria-label="Jev API key"]')!;
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "ts_live_9a4f");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save key").click());
  expect(ipc.agentsSaveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ jevEnabled: true, jevApiKey: "ts_live_9a4f" }));
  expect(host.textContent).toContain("On · key …9a4f");

  await act(async () => button("Health check").click());
  expect((ipc as Record<string, unknown>).agentsJevHealth).toHaveBeenCalledWith(null);
  expect(host.textContent).toContain("Healthy · connected to TypeSafe AI (jev-latest) in 38 ms.");

  await act(async () => button("Remove key").click());
  expect(ipc.agentsSaveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ jevEnabled: false, jevApiKey: "" }));
});

it("displays token and Jev usage analytics across connected agents and clears history", async () => {
  const { AgentsSettings } = await import("./AgentsSettings");
  (ipc as Record<string, unknown>).agentsOverview = vi.fn(async () => ({
    settings: { apiEnabled: true, defaultMode: "propose", mirrorEdits: "propose", jevEnabled: true, jevKeyHint: "9a4f" },
    agents: [{
      id: "a1", name: "Claude Code", role: "", model: "", tokenPrefix: "sv_1", mode: "propose",
      workspaceIds: ["ws1"], tools: ["pages", "memory"], enabled: true, createdAt: "2026-10-15T00:00:00Z", lastSeenAt: "2026-10-18T00:00:00Z",
    }],
    port: 51234,
    bridgePath: null,
    pending: 0,
  }));
  (ipc as Record<string, unknown>).clientsScan = vi.fn(async () =>
    scan([app("claude-code", "Claude Code", { status: "connected", agentId: "a1", agentName: "Claude Code", connectedAt: "2026-10-15T00:00:00Z" })]),
  );
  (ipc as Record<string, unknown>).mirrorGet = vi.fn(async () => ({ enabled: false, path: "", lastSync: null, lastError: null, files: 0 }));
  ipc.agentsUsage.mockResolvedValue({
    range: "7d",
    totals: {
      calls: 42, errors: 1, avgDurationMs: 28, inputTokens: 2100, outputTokens: 12400, totalTokens: 14500, savedTokens: 6500,
      savingsPct: 31, jevCalls: 9, jevCacheHits: 5,
      jevErrors: 0, jevTokens: 1320, jevQuestions: 48, jevAvgMs: 41, jevPruned: 17,
    },
    agents: [{
      agentId: "a1", agentName: "Claude Code", role: "", model: "", status: "active",
      lastSeenAt: "2026-10-18T00:00:00Z", clientId: "claude-code", clientName: "Claude Code",
      calls: 42, errors: 1, avgDurationMs: 28, inputTokens: 2100, outputTokens: 12400,
      totalTokens: 14500, savedTokens: 6500, savingsPct: 31, jevCalls: 9,
      jevCacheHits: 5, jevTokens: 1320, jevPruned: 17, topTools: ["context_pack"],
    }],
    tools: [{
      tool: "context_pack", calls: 15, errors: 0, avgDurationMs: 35, inputTokens: 900, outputTokens: 8200,
      totalTokens: 9100, savedTokens: 4800, jevCalls: 6, jevCacheHits: 2, jevTokens: 900, jevPruned: 12,
    }],
    series: [{ key: "2026-10-18", label: "10-18", calls: 42, inputTokens: 2100, outputTokens: 12400, savedTokens: 6500, jevTokens: 1320 }],
    recent: [],
  });
  ipc.agentsUsageClear.mockResolvedValue(42);
  vi.spyOn(window, "confirm").mockReturnValue(true);

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentsSettings active={true} />));

  expect(host.textContent).toContain("Token usage");
  expect(host.textContent).toContain("15k (12k out · 2.1k in)");
  expect(host.textContent).toContain("6.5k (31% smaller)");
  expect(host.textContent).toContain("1.3k tokens (9 API · 5 cached · 41 ms)");
  expect(host.textContent).toContain("17 pruned (48 questions)");
  expect(host.textContent).toContain("15k tokens (12k out, 2.1k in) · 6.5k saved (31%) · Jev: 9 API, 5 cached · 42 calls · avg 28 ms");

  await act(async () => button("24h").click());
  expect(ipc.agentsUsage).toHaveBeenCalledWith("24h", null);

  await act(async () => button("Clear history").click());
  expect(ipc.agentsUsageClear).toHaveBeenCalledWith(null);
});
