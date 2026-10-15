import { useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
import { Copy, ModePicker, ToolChecks, WorkspaceChecks } from "./parts";
import { MODE_LABELS, type Agent, type AgentClient, type AgentMode, type AgentSettings, type ClientScan, type ClientState, type ConnectResult, type ToolGroup } from "./types";

const STATE: Record<ClientState, { label: string; tone: "on" | "warn" | "off" }> = {
  not_connected: { label: "Not connected", tone: "off" },
  foreign: { label: "Set up outside Suivelle", tone: "warn" },
  waiting: { label: "Needs restart", tone: "warn" },
  connected: { label: "Connected", tone: "on" },
  paused: { label: "Agent paused", tone: "off" },
  out_of_date: { label: "Out of date", tone: "warn" },
  edited: { label: "Edited outside Suivelle", tone: "warn" },
  removed: { label: "Entry removed", tone: "warn" },
  unreadable: { label: "Config unreadable", tone: "warn" },
};

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/** One line per app saying exactly what Connect changes. */
function plan(c: AgentClient): string {
  if (c.method === "cli") return `Runs ${c.name}'s own command to add a “suivelle” server (${c.configPaths.join(", ") || "its user config"}).`;
  const files = c.configPaths.map((p) => `${p} (the current file is kept as ${fileName(p)}.suivelle-backup)`).join("; ");
  return `Adds a “suivelle” server to ${files || "its config"}. Nothing else in the file changes.`;
}

/** What "Start sessions from Suivelle" changes for these apps. */
function startLinesPlan(clients: AgentClient[]): string {
  if (clients.length === 1) {
    const c = clients[0];
    if (c.instructionsPath) return `Adds 3 lines to ${c.instructionsPath} so every session begins with Suivelle (the current file is kept as a backup).`;
    if (c.instructionsPlace) return `${c.name} keeps these in ${c.instructionsPlace}; you get the lines to paste there.`;
    return `${c.name} has no user-level instructions to add them to.`;
  }
  const files = clients.filter((c) => c.instructionsPath).map((c) => fileName(c.instructionsPath!));
  const paste = clients.filter((c) => !c.instructionsPath && c.instructionsPlace).map((c) => c.name);
  return [files.length ? `Adds 3 lines to each app's instructions file (${[...new Set(files)].join(", ")}).` : "", paste.length ? `${paste.join(", ")}: lines to paste in its settings.` : ""].filter(Boolean).join(" ");
}

/** What "Add Suivelle commands" adds for these apps. */
function commandsPlan(clients: AgentClient[]): string {
  const files = clients.filter((c) => c.commands.length > 0);
  const prompts = clients.filter((c) => c.commands.length === 0).map((c) => c.name);
  const typed = files.length ? [...new Set(files.flatMap((c) => c.commands))].join("  ") : "";
  return [
    typed ? `${typed}: set up, sync and wrap up with Suivelle.` : "",
    prompts.length ? `${prompts.join(", ")} ${prompts.length === 1 ? "offers" : "offer"} them as MCP prompts instead.` : "",
  ].filter(Boolean).join(" ");
}

interface Outcome { ok: boolean; text: string; snippet?: { text: string; path: string } }

function describe(r: ConnectResult): Outcome {
  if (r.method === "manual" && r.snippet) {
    return { ok: true, text: `Paste this into ${r.client.configPaths[0] ?? "the app's config"}, merged with what is there. It is shown only once.`, snippet: { text: r.snippet, path: r.client.configPaths[0] ?? "" } };
  }
  const how = r.method === "cli" ? "with its own command" : `in ${r.changed.map(fileName).join(", ")}`;
  const text = [`Connected ${r.client.name} (${how}) as agent “${r.client.agentName}”. ${r.client.restart}`, ...r.notes].join(" ");
  // Apps that keep instructions in their settings get the lines to paste.
  const paste = r.notes.some((n) => n.includes("paste the session-start lines")) && r.client.instructionsPlace;
  return { ok: true, text, ...(paste ? { snippet: { text: r.client.startLines, path: "" } } : {}) };
}

/** The connected app's start lines and commands, in one line. */
function extrasLine(c: AgentClient): string | null {
  const parts: string[] = [];
  if (c.instructionsAdded && c.instructionsPath) parts.push(`Starts from Suivelle (${fileName(c.instructionsPath)})`);
  if (c.commandsAdded) parts.push(c.commands.join("  "));
  else if (c.commands.length === 0) parts.push("Commands as MCP prompts");
  return parts.length ? parts.join(" · ") : null;
}

function ConnectSheet({ clients, agents, linked, settings, onDone, onCancel }: {
  clients: AgentClient[];
  agents: Agent[];
  /** Agents already connected to an app. */
  linked: string[];
  settings: AgentSettings;
  onDone: (outcomes: Record<string, Outcome>) => void;
  onCancel: () => void;
}) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const current = useWorkspace((s) => s.workspace);
  const single = clients.length === 1 ? clients[0] : null;
  const free = agents.filter((a) => !linked.includes(a.id));
  const [agentId, setAgentId] = useState<string>("");
  const [name, setName] = useState(single?.name ?? "");
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(current ? [current.id] : []);
  const [mode, setMode] = useState<AgentMode>(settings.defaultMode);
  const [tools, setTools] = useState<ToolGroup[]>(["pages", "graph", "memory", "tasks"]);
  const [enableApi, setEnableApi] = useState(!settings.apiEnabled);
  const [startLines, setStartLines] = useState(true);
  const [commands, setCommands] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacing = clients.filter((c) => c.status === "foreign");
  const credential = clients.every((c) => c.credential);
  const form = useRef<HTMLFormElement>(null);

  // The sheet opens below the app list; bring it into view and put the keyboard in it.
  useEffect(() => {
    const el = form.current;
    if (!el) return;
    const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
    el.querySelector<HTMLElement>("select, input")?.focus({ preventScroll: true });
  }, []);

  const go = async (manual: boolean) => {
    setBusy(true);
    setError(null);
    const out: Record<string, Outcome> = {};
    try {
      if (enableApi) await ipc.agentsSaveSettings({ ...settings, apiEnabled: true });
      for (const c of clients) {
        try {
          const r = await ipc.clientConnect(c.id, {
            agentId: single && agentId ? agentId : null,
            agent: single && agentId ? null : { name: single ? name.trim() || c.name : c.name, role: "", model: "", mode, workspaceIds, tools },
            replace: c.status === "foreign",
            manual,
            instructions: startLines,
            commands,
          });
          out[c.id] = describe(r);
        } catch (e) {
          out[c.id] = { ok: false, text: `${c.name}: ${toAppError(e).message}` };
        }
      }
      onDone(out);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const needsWorkspace = !(single && agentId) && workspaceIds.length === 0;
  return (
    <form ref={form} className="agx-form agx-sheet" onSubmit={(e) => { e.preventDefault(); void go(false); }}>
      <strong>{single ? `Connect ${single.name}` : `Connect ${clients.length} apps`}</strong>
      <ul className="agx-plan">
        {clients.map((c) => <li key={c.id}>{plan(c)}{c.status === "foreign" && <strong> Replaces the “suivelle” server already there.</strong>}</li>)}
      </ul>
      {single ? (
        <label className="agx-field">Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">A new agent for {single.name}</option>
            {free.map((a) => <option key={a.id} value={a.id}>{a.name} (existing)</option>)}
          </select>
        </label>
      ) : <p className="picker-muted">Each app gets its own agent and token, so you can see and revoke them separately.</p>}
      {single && !agentId && <label className="agx-field">Agent name<input type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>}
      {!(single && agentId) && (
        <>
          <fieldset><legend>Workspaces it can see</legend><WorkspaceChecks workspaces={workspaces} value={workspaceIds} onChange={setWorkspaceIds} /></fieldset>
          <fieldset>
            <legend>How its changes apply</legend>
            <ModePicker label="How its changes apply" value={mode} onChange={setMode} />
            <p className="picker-muted">{MODE_LABELS[mode].hint}</p>
          </fieldset>
          <fieldset><legend>What it can use</legend><ToolChecks value={tools} onChange={setTools} /></fieldset>
        </>
      )}
      <fieldset>
        <legend>Also add</legend>
        <label className="check-row agx-extra">
          <input type="checkbox" checked={startLines} onChange={(e) => setStartLines(e.target.checked)} />
          <span>
            Start sessions from Suivelle
            <span className="agx-meta">{startLinesPlan(clients)}</span>
          </span>
        </label>
        <label className="check-row agx-extra">
          <input type="checkbox" checked={commands} onChange={(e) => setCommands(e.target.checked)} />
          <span>
            Add Suivelle commands
            <span className="agx-meta">{commandsPlan(clients)}</span>
          </span>
        </label>
      </fieldset>
      <p className="picker-muted">{credential
        ? "The token is kept in Windows Credential Manager; the app's config only names the agent."
        : "The token is written into the app's config file, where programs running as you can read it. Each app gets its own token, which you can revoke here."}</p>
      {!settings.apiEnabled && <label className="check-row"><input type="checkbox" checked={enableApi} onChange={(e) => setEnableApi(e.target.checked)} /> Also turn on “Let local agents connect”</label>}
      {replacing.length > 0 && <p className="picker-muted">Suivelle did not add the existing “suivelle” server in {replacing.map((c) => c.name).join(", ")}; connecting replaces it.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="agx-actions">
        <button type="submit" className="btn primary" disabled={busy || needsWorkspace}>{busy ? "Connecting…" : "Connect"}</button>
        {single && <button type="button" className="btn" disabled={busy || needsWorkspace} onClick={() => void go(true)} title="Shows the entry to paste yourself; Suivelle does not edit the file">Copy config instead</button>}
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Settings > Agents > Connect apps: finds agent apps on this computer and connects them in one step. */
export function ConnectApps({ scan, agents, settings, onScan, onChanged }: {
  scan: ClientScan | null;
  agents: Agent[];
  settings: AgentSettings;
  onScan: () => Promise<void>;
  onChanged: () => void;
}) {
  const [sheet, setSheet] = useState<string[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const rescan = async () => { setScanning(true); try { await onScan(); } finally { setScanning(false); } };
  const act = async (c: AgentClient, kind: "repair" | "disconnect") => {
    const ask = kind === "disconnect"
      ? `Disconnect ${c.name}? Suivelle removes its “suivelle” entry from ${c.configPaths.join(", ") || "the config"} and revokes the token. The agent “${c.agentName ?? c.name}” and its history stay.`
      : c.status === "edited" ? `Repair ${c.name}? Its “suivelle” entry was edited by hand; repairing writes it again with a new token.` : null;
    if (ask && !window.confirm(ask)) return;
    setBusy(c.id);
    try {
      const text = kind === "repair"
        ? describe(await ipc.clientRepair(c.id))
        : await ipc.clientDisconnect(c.id).then((r) => ({ ok: true, text: [`Disconnected ${c.name}.`, ...r.notes].join(" ") }));
      setOutcomes((o) => ({ ...o, [c.id]: text }));
    } catch (e) {
      setOutcomes((o) => ({ ...o, [c.id]: { ok: false, text: toAppError(e).message } }));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  if (!scan) return <p className="picker-muted">{scanning ? "Looking for agent apps…" : ""}</p>;
  const connectable = scan.clients.filter((c) => c.status === "not_connected");
  const open = sheet ? scan.clients.filter((c) => sheet.includes(c.id)) : [];
  return (
    <div className="agx-apps">
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Agent apps on this computer</div>
          <div className="set-hint">Suivelle looks for {scan.known.join(", ")} by their config folders and programs. Connecting creates an agent for the app and adds Suivelle to the app's MCP servers; the app starts Suivelle's connector itself when it runs.</div>
        </div>
        <div className="set-control agx-actions">
          <button type="button" className="btn" disabled={scanning} onClick={() => void rescan()}>{scanning ? "Looking…" : "Find agent apps"}</button>
          {!READ_ONLY && connectable.length > 1 && <button type="button" className="btn" onClick={() => setSheet(connectable.map((c) => c.id))}>Connect all…</button>}
        </div>
      </div>
      {!scan.bundled && <p className="field-error" role="alert">The suivelle-mcp connector is missing from this copy of Suivelle, so apps cannot be connected. Reinstall Suivelle, or build it with <code>cargo build -p suivelle-mcp</code>.</p>}
      {scan.devBuild && scan.bundled && <p className="picker-muted">Development build: connected apps use this build's connector. After installing a release, choose Repair if an app shows Out of date.</p>}
      {scan.clients.length === 0 && <p className="picker-muted">No agent apps found.</p>}
      <ul className="agx-cards">
        {scan.clients.map((c) => {
          const s = STATE[c.status];
          const linked = c.connectedAt !== null;
          return (
            <li key={c.id} className="agx-card">
              <div className="agx-card-head">
                <strong>{c.name}</strong>
                <span className={`agx-chip ${s.tone}`}>{s.label}</span>
              </div>
              <p className="agx-meta">
                {linked && c.agentName ? `Agent “${c.agentName}” · ` : ""}
                {c.configPaths[0] ?? c.found[0] ?? ""}
                {c.configPaths.length > 1 ? ` and ${c.configPaths.length - 1} more` : ""}
                {c.method === "cli" && !linked ? " · uses its own command" : ""}
              </p>
              {linked && extrasLine(c) && <p className="agx-meta">{extrasLine(c)}</p>}
              {c.detail && <p className="agx-meta">{c.detail}</p>}
              {outcomes[c.id] && (
                <div role="status" className={outcomes[c.id].ok ? "agx-note" : "field-error"}>
                  <p>{outcomes[c.id].text}</p>
                  {outcomes[c.id].snippet && <Copy text={outcomes[c.id].snippet!.text} label={outcomes[c.id].snippet!.path ? `Copy ${c.name} config` : `Copy ${c.name} start lines`} block />}
                </div>
              )}
              {!READ_ONLY && scan.bundled && (
                <div className="agx-actions">
                  {(c.status === "not_connected" || c.status === "foreign") && <button type="button" className="btn" onClick={() => setSheet([c.id])}>{c.status === "foreign" ? "Replace…" : "Connect…"}</button>}
                  {linked && ["out_of_date", "edited", "removed"].includes(c.status) && <button type="button" className="btn" disabled={busy === c.id} onClick={() => void act(c, "repair")}>Repair</button>}
                  {linked && c.extrasPending && !["out_of_date", "edited", "removed"].includes(c.status) && (
                    <button type="button" className="btn" disabled={busy === c.id} title={`Adds the session-start lines and the /suivelle_… commands, and gives ${c.name} a fresh token (restart it afterwards)`} onClick={() => void act(c, "repair")}>Add commands</button>
                  )}
                  {linked && <button type="button" className="btn ghost" disabled={busy === c.id} onClick={() => void act(c, "disconnect")}>Disconnect</button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {open.length > 0 && (
        <ConnectSheet
          key={open.map((c) => c.id).join(",")}
          clients={open}
          agents={agents}
          linked={scan.clients.flatMap((c) => (c.agentId ? [c.agentId] : []))}
          settings={settings}
          onCancel={() => setSheet(null)}
          onDone={(o) => { setOutcomes((prev) => ({ ...prev, ...o })); setSheet(null); onChanged(); }}
        />
      )}
    </div>
  );
}
