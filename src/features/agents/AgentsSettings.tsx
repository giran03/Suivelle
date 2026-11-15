import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
import { AgentUsageView, formatAgentUsageLine } from "./AgentUsageView";
import { ConnectApps } from "./ConnectApps";
import { ReaWorkflowSettings } from "./ReaWorkflowSettings";
import { Copy, ModePicker, ToolChecks, WorkspaceChecks } from "./parts";
import { useAgents } from "./store";
import { SubagentImport } from "./SubagentImport";
import { MODE_LABELS, TOOL_GROUP_LABELS, type Agent, type AgentClient, type AgentInput, type AgentMode, type AgentUsage, type AgentsOverview, type ClientScan, type MirrorConfig, type UsageReport } from "./types";
import "./agents.css";

type SettingsTab = "general" | "agents" | "usage" | "memory" | "files";
const TABS: readonly (readonly [SettingsTab, string])[] = [["general", "General"], ["agents", "Agents"], ["usage", "Usage"], ["memory", "Memory"], ["files", "Files"]];

function ago(iso: string | null): string {
  if (!iso) return "never connected";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return iso;
  if (s < 90) return "active just now";
  if (s < 3600) return `active ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `active ${Math.round(s / 3600)} h ago`;
  return `active ${new Date(iso).toLocaleDateString()}`;
}

function AgentForm({ initial, defaultMode, onSaved, onCancel }: { initial: Agent | null; defaultMode: AgentMode; onSaved: () => void; onCancel: () => void }) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const current = useWorkspace((s) => s.workspace);
  const [form, setForm] = useState<AgentInput>(() => initial
    ? { name: initial.name, role: initial.role, model: initial.model, mode: initial.mode, status: initial.status, workspaceIds: initial.workspaceIds, tools: initial.tools }
    : { name: "", role: "", model: "", mode: defaultMode, status: "active", workspaceIds: current ? [current.id] : [], tools: ["pages", "graph", "memory", "tasks"] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (initial) await ipc.agentUpdate(initial.id, form);
      else await ipc.agentCreate(form);
      onSaved();
    } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); }
  };
  return (
    <form className="agx-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="agx-field">Name<input type="text" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Claude, Librarian, Release bot…" /></label>
      <label className="agx-field">Role<input type="text" maxLength={300} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="What it is for, in one line" /></label>
      <label className="agx-field">Model (for your reference)<input type="text" maxLength={120} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="sonnet, opus, gpt-5…" /></label>
      <fieldset>
        <legend>How its changes apply</legend>
        <ModePicker label="How its changes apply" value={form.mode ?? defaultMode} onChange={(mode) => setForm({ ...form, mode })} />
        <p className="picker-muted">{MODE_LABELS[form.mode ?? defaultMode].hint} Memories and task updates are always saved directly.</p>
      </fieldset>
      <fieldset>
        <legend>Workspaces it can see</legend>
        <WorkspaceChecks workspaces={workspaces} value={form.workspaceIds} onChange={(workspaceIds) => setForm({ ...form, workspaceIds })} />
      </fieldset>
      <fieldset>
        <legend>What it can use</legend>
        <ToolChecks value={form.tools} onChange={(tools) => setForm({ ...form, tools })} />
      </fieldset>
      {initial && <label className="check-row"><input type="checkbox" checked={form.status === "paused"} onChange={(e) => setForm({ ...form, status: e.target.checked ? "paused" : "active" })} /> Paused (cannot connect)</label>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="agx-actions">
        <button type="submit" className="btn primary" disabled={busy || !form.name.trim()}>{busy ? "Saving…" : initial ? "Save" : "Add agent"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function connectCommand(bridge: string | null, token: string) {
  return `claude mcp add suivelle --scope user --env SUIVELLE_AGENT_TOKEN=${token} -- "${bridge ?? "suivelle-mcp"}"`;
}

function AgentCard({ agent, overview, client, usage, onChanged }: { agent: Agent; overview: AgentsOverview; client: AgentClient | undefined; usage: AgentUsage | undefined; onChanged: () => void }) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try { await fn(); } catch (e) { setError(toAppError(e).message); }
  };
  if (editing) return <li><AgentForm initial={agent} defaultMode={overview.settings.defaultMode} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} /></li>;
  const names = agent.workspaceIds.map((id) => workspaces.find((w) => w.id === id)?.name).filter(Boolean);
  const usageLine = formatAgentUsageLine(usage);
  const exportSubagent = (force: boolean) => run(async () => {
    const r = await ipc.agentExportSubagent(agent.id, force);
    if (!r) return;
    if (r.status === "modified") {
      if (window.confirm(`${r.path} was edited by hand since Suivelle wrote it. Overwrite those edits?`)) await exportSubagent(true);
      return;
    }
    setMessage(`${r.status === "unchanged" ? "Already up to date" : r.status === "created" ? "Written" : "Updated"}: ${r.path}`);
  });
  return (
    <li className="agx-card">
      <div className="agx-card-head">
        <strong>{agent.name}</strong>
        <span className={`agx-status${agent.status === "active" ? " on" : ""}`}>{agent.status === "paused" ? "Paused" : MODE_LABELS[agent.mode].title} · {ago(agent.lastSeenAt)}</span>
      </div>
      {agent.role && <p className="agx-meta">{agent.role}</p>}
      {client && <p className="agx-meta">Connected through {client.name} · its token is managed in Connect apps above</p>}
      <p className="agx-meta">{names.length ? names.join(", ") : "No workspaces"} · {agent.tools.map((t) => TOOL_GROUP_LABELS[t]).join(", ") || "No tools"}{agent.tokenHint ? ` · token …${agent.tokenHint}` : " · no token"}</p>
      {usageLine && <p className="agx-meta agx-usage-line">{usageLine}</p>}
      {token && (
        <div className="agx-token" role="status">
          <strong>Copy this token now. It is shown only once.</strong>
          <Copy text={token} label="Copy token" />
          <span className="picker-muted">To connect Claude Code, run:</span>
          <Copy text={connectCommand(overview.bridgePath, token)} label="Copy Claude Code command" />
          <span className="picker-muted">Other MCP clients: run <code>suivelle-mcp</code> as a stdio server with <code>SUIVELLE_AGENT_TOKEN</code> set.</span>
        </div>
      )}
      {message && <p className="picker-muted" role="status">{message}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {!READ_ONLY && (
        <div className="agx-actions">
          <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="btn" onClick={() => void run(async () => { if (agent.tokenHint && !window.confirm(`Replace ${agent.name}'s token? Clients using the old one stop working.`)) return; setToken(await ipc.agentTokenRotate(agent.id)); onChanged(); })}>{agent.tokenHint ? "New token" : "Create token"}</button>
          {agent.tokenHint && <button type="button" className="btn" onClick={() => void run(async () => { await ipc.agentTokenRevoke(agent.id); setToken(null); onChanged(); })}>Revoke token</button>}
          {agent.instructionsPageId && <button type="button" className="btn" onClick={() => { const id = agent.instructionsPageId!; void import("../settings/store").then((m) => m.useSettingsDialog.getState().hide()); void useWorkspace.getState().selectPage(id); }}>Edit instructions</button>}
          <button type="button" className="btn" onClick={() => void exportSubagent(false)} title="Writes .claude/agents/<name>.md into a project folder">Export for Claude Code…</button>
          <button type="button" className="btn ghost" onClick={() => void run(async () => { if (!window.confirm(`Remove ${agent.name}? ${client ? `It is disconnected from ${client.name} first. ` : ""}Its token stops working and pending proposals are rejected. Its pages, memories and history stay.`)) return; await ipc.agentDelete(agent.id); onChanged(); })}>Remove</button>
        </div>
      )}
    </li>
  );
}

function MirrorSection() {
  const workspace = useWorkspace((s) => s.workspace);
  const [cfg, setCfg] = useState<MirrorConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!workspace) return;
    try { setCfg(await ipc.mirrorGet(workspace.id)); } catch (e) { setError(toAppError(e).message); }
  }, [workspace]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);
  if (!workspace || !cfg) return null;
  const run = async (fn: () => Promise<MirrorConfig | null>) => {
    setError(null);
    try { const c = await fn(); if (c) setCfg(c); } catch (e) { setError(toAppError(e).message); }
  };
  return (
    <>
      <h4>Plain-text mirror</h4>
      <p className="picker-muted">Keeps a folder of Markdown files in step with “{workspace.name}”, so agents, editors, search tools and git can use it as plain text. Pages link with [[wikilinks]]. Edits made in the folder come back according to the setting below.</p>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{cfg.path ? cfg.path : "No folder chosen"}</div>
          <div className="set-hint">{cfg.enabled ? `${cfg.files} files${cfg.lastSync ? ` · synced ${new Date(cfg.lastSync).toLocaleTimeString()}` : ""}` : "Off"}</div>
          {cfg.lastError && <p className="field-error" role="alert">{cfg.lastError}</p>}
        </div>
        {!READ_ONLY && (
          <div className="set-control agx-actions">
            <button type="button" className="btn" onClick={() => void run(() => ipc.mirrorChoose(workspace.id))}>{cfg.path ? "Change folder…" : "Choose folder…"}</button>
            {cfg.path && <label className="switch"><input type="checkbox" checked={cfg.enabled} aria-label="Mirror this workspace" onChange={(e) => void run(() => ipc.mirrorSetEnabled(workspace.id, e.target.checked))} /><span className="switch-track" aria-hidden="true" /></label>}
          </div>
        )}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </>
  );
}

function AgentsMdExport() {
  const page = useWorkspace((s) => s.selectedPage);
  const [include, setInclude] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = async (force: boolean): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      const r = await ipc.agentsExportAgentsMd(include && page ? [page.id] : [], force);
      if (!r) return;
      if (r.status === "modified") {
        if (window.confirm("The Suivelle section of that AGENTS.md was edited by hand. Overwrite it?")) await write(true);
        return;
      }
      setMessage(`${r.status === "unchanged" ? "Already up to date" : r.status === "created" ? "Written" : "Updated"}: ${r.path}`);
    } catch (e) { setError(toAppError(e).message); }
  };
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">AGENTS.md</div>
        <div className="set-hint">Writes a section into a project's AGENTS.md (read by Codex, Claude Code and others): your agents, how to reach Suivelle, and optionally the open page as shared instructions. The rest of the file is left alone.</div>
        {page && <label className="check-row"><input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Include “{page.title || "Untitled"}”</label>}
        {message && <p className="picker-muted" role="status">{message}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="set-control"><button type="button" className="btn" onClick={() => void write(false)}>Write section…</button></div>
    </div>
  );
}

function JevRow({ settings: s, onSave }: { settings: AgentsOverview["settings"]; onSave: (next: AgentsOverview["settings"]) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; message: string } | null>(null);
  const hasKey = Boolean(s.jevKeyHint);
  const showInput = !hasKey || editing;
  const submitKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setHealth(null);
    try {
      await onSave({ ...s, jevEnabled: true, jevApiKey: trimmed });
      setKey("");
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  const checkHealth = async () => {
    setChecking(true);
    setHealth(null);
    try {
      const candidate = showInput && key.trim() ? key.trim() : null;
      const res = await ipc.agentsJevHealth(candidate);
      setHealth({ ok: res.ok, message: res.message });
    } catch (e) {
      setHealth({ ok: false, message: toAppError(e).message });
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">Jev memory filter (optional)</div>
        <div className="set-hint">
          Uses TypeSafe AI’s Jev decision model (api.typesafe.ai) to rank memories by meaning, leave irrelevant ones out of context packs so agents spend fewer tokens, and catch duplicate or conflicting memories. When off or unreachable, Suivelle uses local search.
          {hasKey && ` (${s.jevEnabled ? "On" : "Off"} · key …${s.jevKeyHint})`}
        </div>
        {!READ_ONLY && showInput && (
          <form className="agx-key-row" onSubmit={(e) => void submitKey(e)}>
            <input
              type="password"
              className="agx-key-input"
              aria-label="Jev API key"
              placeholder="TypeSafe AI key (ts_…)"
              autoComplete="off"
              maxLength={256}
              value={key}
              onChange={(e) => { setKey(e.target.value); if (health) setHealth(null); }}
            />
            <button type="submit" className="btn primary" disabled={busy || checking || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
            {!hasKey && (
              <button type="button" className="btn" disabled={busy || checking || !key.trim()} onClick={() => void checkHealth()}>
                {checking ? "Checking…" : "Health check"}
              </button>
            )}
            {hasKey && <button type="button" className="btn ghost" onClick={() => { setEditing(false); setKey(""); setHealth(null); }}>Cancel</button>}
          </form>
        )}
        {health && (
          health.ok
            ? <p className="picker-muted" role="status">{health.message}</p>
            : <p className="field-error" role="alert">{health.message}</p>
        )}
      </div>
      {!READ_ONLY && hasKey && (
        <div className="set-control agx-actions agx-jev-actions">
          <button type="button" className="btn" disabled={busy || checking} onClick={() => void checkHealth()}>
            {checking ? "Checking…" : "Health check"}
          </button>
          {!editing && <button type="button" className="btn" onClick={() => { setEditing(true); setHealth(null); }}>Replace key…</button>}
          <button type="button" className="btn ghost" onClick={() => { setEditing(false); setKey(""); setHealth(null); void onSave({ ...s, jevEnabled: false, jevApiKey: "" }); }}>Remove key</button>
          <label className="switch">
            <input type="checkbox" checked={Boolean(s.jevEnabled)} aria-label="Use Jev memory filter" onChange={(e) => void onSave({ ...s, jevEnabled: e.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>
      )}
    </div>
  );
}

/** Settings > Agents: the agent API switch, agents and their tokens, the mirror and exports. */
export function AgentsSettings({ active }: { active: boolean }) {
  const [overview, setOverview] = useState<AgentsOverview | null>(null);
  const [clients, setClients] = useState<ClientScan | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await ipc.agentsOverview();
      setOverview(next);
      useAgents.setState({ pending: next.pending, hasActiveAgents: next.agents.some((agent) => agent.status === "active") });
    } catch (e) { setError(toAppError(e).message); }
  }, []);
  // Looks for agent apps only while this page is open (reads config folders and PATH, nothing else).
  const scan = useCallback(async () => {
    try { setClients(await ipc.clientsScan()); } catch (e) { setError(toAppError(e).message); }
  }, []);
  useEffect(() => { if (active) { void load(); void scan(); } }, [active, load, scan]);
  const usageByAgent = useMemo(() => {
    const map: Record<string, AgentUsage> = {};
    for (const a of usage?.agents ?? []) map[a.agentId] = a;
    return map;
  }, [usage]);
  if (!overview) return error ? <p className="field-error" role="alert">{error}</p> : null;
  const s = overview.settings;
  const save = async (next: typeof s) => {
    setError(null);
    try { await ipc.agentsSaveSettings(next); await load(); } catch (e) { setError(toAppError(e).message); }
  };
  const mirrorEdits = (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">Edits made in mirror folders</div>
        <div className="set-hint">{s.mirrorEdits === "apply" ? "Applied as soon as they are saved. A page changed in both places always waits for review." : "Each edit waits in the Review inbox."}</div>
      </div>
      <div className="set-control">
        <div className="seg" role="radiogroup" aria-label="Edits made in mirror folders">
          {(["propose", "apply"] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={s.mirrorEdits === m} className={s.mirrorEdits === m ? "on" : ""} onClick={() => void save({ ...s, mirrorEdits: m })}>{m === "propose" ? "Wait for review" : "Apply"}</button>)}
        </div>
      </div>
    </div>
  );
  const badges: Partial<Record<SettingsTab, number>> = { general: overview.pending, agents: overview.agents.length };
  const onTabKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : 0;
    if (!step) return;
    e.preventDefault();
    const i = TABS.findIndex(([id]) => id === tab);
    const next = step === "first" ? 0 : step === "last" ? TABS.length - 1 : (i + step + TABS.length) % TABS.length;
    setTab(TABS[next][0]);
    window.requestAnimationFrame(() => document.getElementById(`agx-tab-${TABS[next][0]}`)?.focus());
  };
  return (
    <div className="agx-settings">
      <p className="set-hint">AI agents on this computer (Claude Code, Codex and other MCP clients) can use your workspaces as shared memory, a knowledge graph and a task queue. Suivelle never runs a model or starts an agent; agents connect and ask. Everything they change is recorded and can be reverted.</p>
      <div role="tablist" aria-label="Agent settings" className="agx-tabs agx-settings-tabs" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button key={id} id={`agx-tab-${id}`} role="tab" type="button" aria-selected={tab === id} aria-controls="agx-tabpanel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
            {label}{Boolean(badges[id]) && <span className={`agx-badge${id === "general" ? " attention" : ""}`} aria-label={id === "general" ? `${badges[id]} waiting` : `${badges[id]} agents`}>{badges[id]}</span>}
          </button>
        ))}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div role="tabpanel" id="agx-tabpanel" aria-labelledby={`agx-tab-${tab}`} className="agx-tabpanel">
        {tab === "general" && <>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">Let local agents connect</div>
              <div className="set-hint">Listens on this computer only (127.0.0.1), and only for agents with a token.{overview.port ? ` Listening on port ${overview.port}.` : s.apiEnabled ? " Starts with the next agent connection or restart." : ""}</div>
            </div>
            <div className="set-control"><label className="switch"><input type="checkbox" checked={s.apiEnabled} disabled={READ_ONLY} aria-label="Let local agents connect" onChange={(e) => void save({ ...s, apiEnabled: e.target.checked })} /><span className="switch-track" aria-hidden="true" /></label></div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">New agents start in</div>
              <div className="set-hint">{MODE_LABELS[s.defaultMode].hint} Each agent can be changed in the Agents tab.</div>
            </div>
            <div className="set-control"><ModePicker label="New agents start in" value={s.defaultMode} onChange={(m) => void save({ ...s, defaultMode: m })} /></div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">Review inbox</div>
              <div className="set-hint">{overview.pending ? `${overview.pending} proposal${overview.pending === 1 ? "" : "s"} waiting.` : "Nothing waiting."} Activity lists every change agents made, with Revert.</div>
            </div>
            <div className="set-control"><button type="button" className={`btn${overview.pending ? " primary" : ""}`} onClick={() => { void import("../settings/store").then((m) => m.useSettingsDialog.getState().hide()); useAgents.getState().show("review"); }}>Open inbox…</button></div>
          </div>
        </>}

        {tab === "agents" && <>
          <h4>Connect apps</h4>
          <ConnectApps scan={clients} agents={overview.agents} settings={s} usageByAgent={usageByAgent} onScan={scan} onChanged={() => { void load(); void scan(); }} />

          <h4>Agents</h4>
          <ul className="agx-cards">
            {overview.agents.map((a) => <AgentCard key={a.id} agent={a} overview={overview} client={clients?.clients.find((c) => c.agentId === a.id && c.connectedAt)} usage={usageByAgent[a.id]} onChanged={() => { void load(); void scan(); }} />)}
          </ul>
          {overview.agents.length === 0 && !adding && <p className="picker-muted">No agents yet.</p>}
          {adding
            ? <AgentForm initial={null} defaultMode={s.defaultMode} onSaved={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} />
            : !READ_ONLY && <div className="agx-actions"><button type="button" className="btn" onClick={() => setAdding(true)}>Add agent…</button></div>}
          {!READ_ONLY && <SubagentImport defaultMode={s.defaultMode} onImported={() => void load()} />}
        </>}

        {tab === "usage" && <>
          <h4>Token usage</h4>
          <AgentUsageView mode="compact" jevConfigured={Boolean(s.jevKeyHint && s.jevEnabled)} onChanged={setUsage} />
        </>}

        {tab === "memory" && <>
          <JevRow settings={s} onSave={save} />
          <ReaWorkflowSettings jevAvailable={Boolean(s.jevEnabled && s.jevKeyHint)} />
        </>}

        {tab === "files" && <>
          <MirrorSection />
          {mirrorEdits}
          <h4>Project files</h4>
          <AgentsMdExport />
        </>}
      </div>
    </div>
  );
}
