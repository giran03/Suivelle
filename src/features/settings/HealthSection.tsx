import { useCallback, useEffect, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { READ_ONLY, SAFE_MODE } from "../../lib/access";
import { formatBytes } from "../../lib/formatBytes";
import { formatStamp } from "../database/model";
import { useWorkspace } from "../../stores/workspace";
import type { Health } from "../../types";

const count = (n: number) => n.toLocaleString();

/** Storage health for the whole installation, with the tools to reclaim space and check the data. */
export function HealthSection({ active }: { active: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => ipc.maintenanceHealth().then(setHealth, (e) => setError(toAppError(e).message)), []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  const run = async (label: string, work: () => Promise<string>) => {
    setBusy(label); setError(null); setMessage(null);
    try { setMessage(await work()); await refresh(); }
    catch (e) { setError(toAppError(e).message); }
    finally { setBusy(null); }
  };
  const workspaceId = useWorkspace((s) => s.workspace?.id);

  if (!health) return <p className="set-hint" role="status">{error ?? "Measuring storage…"}</p>;
  const leftovers = health.leftovers;
  return <div className="health">
    <dl className="health-stats">
      <div><dt>Database</dt><dd>{formatBytes(health.databaseBytes + health.walBytes)}</dd></div>
      <div><dt>Files</dt><dd>{formatBytes(health.attachmentBytes)} <small>({count(health.attachments)})</small></dd></div>
      <div><dt>Thumbnails</dt><dd>{formatBytes(health.thumbnailBytes)}</dd></div>
      <div><dt>Backups</dt><dd>{formatBytes(health.backupBytes)} <small>({count(health.backups)})</small></dd></div>
      <div><dt>Pages</dt><dd>{count(health.pages)}{health.trashedPages > 0 && <small> + {count(health.trashedPages)} in trash</small>}</dd></div>
      <div><dt>Blocks and records</dt><dd>{count(health.blocks)} · {count(health.records)}</dd></div>
      <div><dt>Search index</dt><dd>{count(health.searchDocuments)} entries</dd></div>
      <div><dt>Last backup</dt><dd>{health.lastBackup ? formatStamp(health.lastBackup) : "None yet"}</dd></div>
    </dl>
    <div className="health-actions">
      <button type="button" className="btn" disabled={READ_ONLY || !!busy || leftovers.files === 0}
        title={leftovers.files ? `${count(leftovers.files)} files nothing uses` : "Nothing to clean up"}
        onClick={() => void run("sweep", async () => { const r = await ipc.maintenanceSweep(); return `Removed ${count(r.files)} unused files (${formatBytes(r.bytes)}).`; })}>
        {busy === "sweep" ? "Cleaning up…" : leftovers.files ? `Clean up ${formatBytes(leftovers.bytes)}` : "No leftovers"}
      </button>
      <button type="button" className="btn" disabled={READ_ONLY || !!busy} title="Rewrite the database without free space"
        onClick={() => void run("compact", async () => { const [before, after] = await ipc.maintenanceCompact(); return `Compacted the database from ${formatBytes(before)} to ${formatBytes(after)}.`; })}>
        {busy === "compact" ? "Compacting…" : health.reclaimableBytes > 0 ? `Compact (${formatBytes(health.reclaimableBytes)} free)` : "Compact database"}
      </button>
      <button type="button" className="btn" disabled={!!busy}
        onClick={() => void run("check", async () => { const r = await ipc.maintenanceCheck(); return r === "ok" ? "The database passed its integrity check." : `The integrity check found a problem: ${r}. Restore a recent backup from Backups.`; })}>
        {busy === "check" ? "Checking…" : "Check integrity"}
      </button>
      <button type="button" className="btn" disabled={READ_ONLY || !!busy || !workspaceId}
        onClick={() => void run("index", async () => { const n = await ipc.searchRebuild(workspaceId!); return `Rebuilt the search index (${count(n)} entries).`; })}>
        {busy === "index" ? "Rebuilding…" : "Rebuild search index"}
      </button>
    </div>
    {message && <p className="set-hint" role="status">{message}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}

/** The second folder (an external drive, a NAS share) that also receives each automatic backup. */
export function BackupMirror() {
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void ipc.backupMirrorGet().then((m) => setFolder(m.folder), () => undefined); }, []);
  const act = (work: () => Promise<{ folder: string | null } | null>) => {
    setError(null);
    void work().then((m) => { if (m) setFolder(m.folder); }, (e) => setError(toAppError(e).message));
  };
  return <div className="backup-mirror">
    <div className="backup-mirror-actions">
      <button type="button" className="btn" disabled={READ_ONLY && !SAFE_MODE} onClick={() => act(ipc.backupMirrorChoose)}>{folder ? "Change folder…" : "Choose folder…"}</button>
      {folder && <button type="button" className="btn ghost" disabled={READ_ONLY && !SAFE_MODE} onClick={() => act(ipc.backupMirrorClear)}>Stop copying</button>}
    </div>
    {folder && <p className="set-hint backup-mirror-path" title={folder}>{folder}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
