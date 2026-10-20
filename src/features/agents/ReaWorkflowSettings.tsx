import { useCallback, useEffect, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { ipc, toAppError } from "../../lib/ipc";
import type { ReaWorkflowStatus } from "./types";

export function ReaWorkflowSettings({ jevAvailable }: { jevAvailable: boolean }) {
  const [status, setStatus] = useState<ReaWorkflowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setStatus(await ipc.reaWorkflowStatus()); }
    catch (e) { setError(toAppError(e).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const install = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await ipc.reaWorkflowInstall();
      setStatus(next);
      setMessage(`Installed workflow v${next.bundledVersion}. ${next.backups.length ? `${next.backups.length} previous ${next.backups.length === 1 ? "file" : "files"} backed up beside the originals. ` : ""}Reload your agent app to discover it. Nothing has been started.`);
    } catch (e) { setError(`${toAppError(e).message} Install again to repair any files already written.`); }
    finally { setBusy(false); }
  };
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">REA workflow (optional)</div>
        <div className="set-hint">Install a shared workflow for agents across all projects. Runs only when you explicitly request REA. No Jev key is needed; human or independent agent review keeps the evidence and approval checks.</div>
        <p className="set-hint">{jevAvailable ? "Jev is configured. Assisted review still needs a separately connected review integration and your approval before evidence is sent." : "Jev-assisted review is off. You can install and use the complete workflow without it. Turning Jev off keeps installed files."}</p>
        {status && <>
          <p className="set-hint">{status.current ? `Up to date · v${status.installedVersion}` : status.installed ? `Installed${status.installedVersion ? ` · v${status.installedVersion}` : " · unversioned"}. Update or repair to bundled v${status.bundledVersion}.` : `Not installed · bundled v${status.bundledVersion}`}</p>
          <details>
            <summary>Installation details</summary>
            <p className="set-hint agx-workflow-path">{status.path}</p>
            <p className="set-hint">Includes the procedure and templates, plus discovery instructions for Codex, Claude Code, Cursor, Gemini, Antigravity and opencode. Updates replace these workflow files with backups and preserve surrounding instructions. REA tools are set up separately.</p>
          </details>
        </>}
        {message && <p className="picker-muted" role="status">{message}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="set-control">
        {status ? !READ_ONLY && <button type="button" className="btn" disabled={busy || status.current} onClick={() => void install()}>{busy ? "Installing…" : status.current ? "Workflow up to date" : status.installed ? "Update REA workflow" : "Install REA workflow"}</button>
          : error ? <button type="button" className="btn" onClick={() => void load()}>Check again</button> : <span className="picker-muted" role="status">Checking workflow…</span>}
      </div>
    </div>
  );
}
