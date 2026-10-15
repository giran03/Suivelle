import { useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { ModePicker, toggle, WorkspaceChecks } from "./parts";
import type { AgentMode, SubagentScan } from "./types";

/** Brings Claude Code subagents (`.claude/agents/*.md`) in as Suivelle agents. */
export function SubagentImport({ defaultMode, onImported }: { defaultMode: AgentMode; onImported: () => void }) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const current = useWorkspace((s) => s.workspace);
  const [found, setFound] = useState<SubagentScan | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(current ? [current.id] : []);
  const [mode, setMode] = useState<AgentMode>(defaultMode);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const look = async (project: boolean) => {
    setError(null);
    setMessage(null);
    try {
      const r = await ipc.subagentsScan(project);
      if (!r) return;
      setFound(r);
      setChosen(r.items.filter((s) => !s.exists).map((s) => s.path));
    } catch (e) { setError(toAppError(e).message); }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await ipc.subagentsImport(chosen, workspaceIds, mode);
      const ok = out.filter((o) => o.agentId).map((o) => o.name);
      const failed = out.filter((o) => o.error).map((o) => `${o.name}: ${o.error}`);
      setMessage([ok.length ? `Imported ${ok.join(", ")}. Their instructions pages are in the Agent Hub.` : "", ...failed].filter(Boolean).join(" "));
      setFound(null);
      onImported();
    } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); }
  };
  return (
    <div className="set-row agx-import">
      <div className="set-text">
        <div className="set-title">Claude Code subagents</div>
        <div className="set-hint">Turns subagent files into Suivelle agents: the file's name, description and model become the agent, and its text becomes the agent's instructions page.</div>
        {found && (
          <div className="agx-form">
            <span className="picker-muted">{found.items.length ? found.folder : `No subagents in ${found.folder}.`}</span>
            {found.items.length > 0 && (
              <>
                <div className="agx-sublist">
                  {found.items.map((s) => (
                    <label key={s.path} className="check-row" title={s.description}>
                      <input type="checkbox" disabled={s.exists} checked={chosen.includes(s.path)} onChange={(e) => setChosen(toggle(chosen, s.path, e.target.checked))} />
                      <span><strong>{s.name}</strong>{s.exists ? " (already an agent)" : s.fromSuivelle ? " (exported from Suivelle)" : ""}{s.description ? ` · ${s.description.split("\n")[0]}` : ""}</span>
                    </label>
                  ))}
                </div>
                <fieldset><legend>Workspaces they can see</legend><WorkspaceChecks workspaces={workspaces} value={workspaceIds} onChange={setWorkspaceIds} /></fieldset>
                <fieldset><legend>How their changes apply</legend><ModePicker label="How their changes apply" value={mode} onChange={setMode} /></fieldset>
                <div className="agx-actions">
                  <button type="button" className="btn primary" disabled={busy || !chosen.length || !workspaceIds.length} onClick={() => void run()}>{busy ? "Importing…" : `Import ${chosen.length}`}</button>
                  <button type="button" className="btn ghost" onClick={() => setFound(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
        {message && <p className="picker-muted" role="status">{message}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="set-control agx-actions">
        <button type="button" className="btn" onClick={() => void look(false)}>Your subagents…</button>
        <button type="button" className="btn" onClick={() => void look(true)}>From a project…</button>
      </div>
    </div>
  );
}
