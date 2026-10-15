// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentClient, AgentSettings, ClientScan } from "./types";

const ipc = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientRepair: vi.fn(),
  clientDisconnect: vi.fn(),
  agentsSaveSettings: vi.fn(),
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
beforeEach(() => { for (const f of Object.values(ipc)) f.mockReset(); });
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });

const settings: AgentSettings = { apiEnabled: false, defaultMode: "propose", mirrorEdits: "propose" };
function app(id: string, name: string, extra: Partial<AgentClient> = {}): AgentClient {
  return {
    id, name, installed: true, found: [], configPaths: [`C:/Users/me/.${id}/config`], method: "file", status: "not_connected", detail: null, agentId: null, agentName: null, connectedAt: null, connectedBy: null, credential: true, restart: `Restart ${name}.`,
    instructionsPath: `C:/Users/me/.${id}/AGENTS.md`, instructionsPlace: null, instructionsAdded: false, commands: [`/suivelle_init`, `/suivelle_wrap-up`], commandsAdded: false, extrasPending: false, startLines: "<!-- suivelle:start -->\nlines\n<!-- suivelle:end -->",
    ...extra,
  };
}
const scan = (clients: AgentClient[]): ClientScan => ({ clients, known: clients.map((c) => c.name), bundled: "C:/bin/suivelle-mcp.exe", devBuild: false, credentials: true });

async function mount(s: ClientScan, onChanged = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ConnectApps scan={s} agents={[]} settings={settings} onScan={async () => {}} onChanged={onChanged} />));
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
  ipc.clientRepair.mockResolvedValue({ client: app("codex", "Codex", { status: "waiting", agentName: "Codex", connectedAt: "2026-10-15T00:00:00Z" }), method: "file", changed: ["C:/Users/me/.codex/config"], backups: [], snippet: null, notes: [] });
  await mount(scan([app("codex", "Codex", { status: "connected", agentId: "a1", agentName: "Codex", connectedAt: "2026-10-14T00:00:00Z", extrasPending: true })]));
  await act(async () => button("Add commands").click());
  expect(ipc.clientRepair).toHaveBeenCalledWith("codex");
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
  expect(host.querySelector("pre")?.textContent).toContain("mcpServers");
  expect(button("Repair")).toBeTruthy();
  await act(async () => button("Disconnect").click());
  expect(ipc.clientDisconnect).toHaveBeenCalledWith("zed");
  expect(host.textContent).toContain("Disconnected Zed.");
});
