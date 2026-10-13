import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { BackupInfo, RestorePreview } from "../../types";
import { formatStamp } from "../database/model";
import { syncDialog } from "../../lib/dialog";

import { useBackupsDialog } from "./store";
export { useBackupsDialog } from "./store";


const KIND: Record<BackupInfo["manifest"]["kind"], string> = { auto: "Automatic", manual: "Manual", export: "Exported", safety: "Before a restore", "pre-update": "Before an update" };

import { formatBytes } from "../../lib/formatBytes";
export { formatBytes } from "../../lib/formatBytes";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

interface Pending {
  /** Which backup is being restored: one from the list, or the file the user picked. */
  name: string | null;
  preview: RestorePreview;
}

function Body() {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auto = useWorkspace((s) => s.settings.autoBackup);
  const setAutoBackup = useWorkspace((s) => s.setAutoBackup);
  const savedKeep = useWorkspace((s) => s.settings.backupKeep);
  const setBackupKeep = useWorkspace((s) => s.setBackupKeep);
  const [keep, setKeep] = useState(String(savedKeep));
  useEffect(() => setKeep(String(savedKeep)), [savedKeep]);
  const hide = useBackupsDialog((s) => s.hide);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      setBackups(await ipc.backupList());
    } catch (e) {
      setError(toAppError(e).message);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (pending && !pending.preview.tooNew) confirmRef.current?.focus();
  }, [pending]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const backUpNow = () =>
    run("create", async () => {
      const info = await ipc.backupCreate();
      setMessage(`Backed up ${plural(info.manifest.pages, "page", "pages")} (${formatBytes(info.size)}).`);
      await refresh();
    });

  const exportTo = () =>
    run("export", async () => {
      const info = await ipc.backupExport();
      if (info) setMessage(`Saved a backup of ${formatBytes(info.size)}.`);
    });

  const pickFile = () =>
    run("pick", async () => {
      const preview = await ipc.backupPick();
      if (preview) setPending({ name: null, preview });
    });

  const review = (b: BackupInfo) =>
    run(b.name, async () => {
      setPending({ name: b.name, preview: await ipc.backupPreview(b.name) });
    });

  const remove = (b: BackupInfo) =>
    run(b.name, async () => {
      await ipc.backupDelete(b.name);
      await refresh();
    });

  const restore = () =>
    run("restore", async () => {
      if (!pending) return;
      await ipc.backupRestore(pending.name);
      // Everything on screen came from the data that was just replaced.
      window.location.reload();
    });

  if (pending) {
    const { backup, currentPages, currentAttachments, tooNew } = pending.preview;
    const m = backup.manifest;
    return (
      <div className="bak">
        <header className="tpl-head">
          <h2>Restore this backup?</h2>
        </header>
        <dl className="bak-facts">
          <dt>Made</dt>
          <dd>{formatStamp(m.createdAt)} ({KIND[m.kind].toLowerCase()})</dd>
          <dt>Workspace</dt>
          <dd>{m.workspaceName || "Untitled"}</dd>
          <dt>Contains</dt>
          <dd>
            {plural(m.pages, "page", "pages")}, {plural(m.attachments, "attachment", "attachments")} ({formatBytes(m.attachmentBytes)})
          </dd>
          <dt>Now</dt>
          <dd>
            {plural(currentPages, "page", "pages")}, {plural(currentAttachments, "attachment", "attachments")}
          </dd>
          <dt>File</dt>
          <dd>{formatBytes(backup.size)}, made by version {m.appVersion}. Checked: it is intact.</dd>
        </dl>
        {tooNew ? (
          <p className="field-error" role="alert">
            This backup was made by a newer version of Suivelle and cannot be restored here. Update the app first.
          </p>
        ) : (
          <p className="picker-muted">Your current data is backed up first (as “Before a restore”), then replaced by this backup. If anything goes wrong, nothing is changed.</p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="picker-actions">
          <button type="button" className="btn" disabled={busy === "restore"} onClick={() => setPending(null)}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="btn danger" disabled={tooNew || busy === "restore"} onClick={() => void restore()}>
            {busy === "restore" ? "Restoring…" : "Replace current data"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bak">
      <header className="tpl-head">
        <h2>Backups</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={hide}>
          <Icon name="close" />
        </button>
      </header>
      <p className="picker-muted">A backup is one checked file with your pages and attachments. Everything stays on this computer.</p>
      <div className="bak-actions">
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void backUpNow()}>
          {busy === "create" ? "Backing up…" : "Back up now"}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportTo()}>
          Export a copy…
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void pickFile()}>
          Restore from file…
        </button>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={auto} disabled={busy !== null} onChange={(e) => void setAutoBackup(e.target.checked)} />
        Back up all workspaces once a day
      </label>
      <form className="bak-retention" onSubmit={(e) => {
        e.preventDefault();
        void run("retention", async () => {
          await setBackupKeep(Number(keep));
          setMessage("Backup limit saved.");
        });
      }}>
        <label htmlFor="backup-keep">Automatic backups to keep</label>
        <div className="bak-retention-controls">
          <input id="backup-keep" type="number" inputMode="numeric" min={1} max={1000} step={1} required
            value={keep} onChange={(e) => setKeep(e.target.value)}
            aria-describedby="backup-keep-hint" disabled={busy !== null} />
          <button type="submit" className="btn" disabled={busy !== null || keep === String(savedKeep)}>
            {busy === "retention" ? "Saving…" : "Save"}
          </button>
        </div>
        <p id="backup-keep-hint" className="picker-muted">1–1,000 backups. Older automatic backups are removed after the next successful automatic backup. Manual and safety backups are kept.</p>
      </form>
      {message && (
        <p className="picker-muted" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <h3 className="bak-sub">Saved on this computer</h3>
      <ul className="bak-list" aria-busy={!backups}>
        {backups?.length === 0 && <li className="picker-muted">No backups yet.</li>}
        {backups?.map((b) => (
          <li key={b.name} className="bak-row">
            <span className="bak-text">
              <b>{formatStamp(b.manifest.createdAt)}</b>
              <span className="picker-muted">
                {KIND[b.manifest.kind]} · {plural(b.manifest.pages, "page", "pages")} · {formatBytes(b.size)}
              </span>
            </span>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void review(b)}>
              Restore…
            </button>
            <button type="button" className="icon-btn" aria-label={`Delete the backup from ${formatStamp(b.manifest.createdAt)}`} disabled={busy !== null} onClick={() => void remove(b)}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BackupsDialog() {
  const open = useBackupsDialog((s) => s.open);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="palette tpl-dialog bak-dialog"
      aria-label="Backups"
      onClose={() => useBackupsDialog.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useBackupsDialog.getState().hide();
      }}
    >
      {open && <Body />}
    </dialog>
  );
}
