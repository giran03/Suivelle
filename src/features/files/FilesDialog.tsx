import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { thumbUrl } from "../../lib/attachments";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { AttachmentInfo } from "../../types";
import { syncDialog } from "../../lib/dialog";
import { Loading } from "../../components/Loading";
import "./files.css";

import { useFilesDialog } from "./store";
export { useFilesDialog } from "./store";


export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

type Filter = "all" | "unused" | "images";
type Sort = "newest" | "largest" | "name";

const isImage = (a: AttachmentInfo) => a.mimeType.startsWith("image/");
const iconFor = (a: AttachmentInfo): IconName =>
  a.mimeType.startsWith("audio/") ? "audio" : a.mimeType.startsWith("video/") ? "video" : a.mimeType.startsWith("image/") ? "image" : "page";

function Thumb({ file }: { file: AttachmentInfo }) {
  const [broken, setBroken] = useState(false);
  if (isImage(file) && !broken) {
    return <img className="file-thumb" src={thumbUrl(file.hash, 320)} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  return (
    <span className="file-thumb file-thumb-icon" aria-hidden="true">
      <Icon name={iconFor(file)} size={18} />
    </span>
  );
}

function usageText(a: AttachmentInfo): string {
  if (a.uses.length === 0) return a.inHistory ? "Only in old versions" : "Not used";
  const first = a.uses[0];
  const where = `${first.title || "Untitled"}${first.workspace ? " (workspace icon)" : first.cover ? " (cover)" : first.icon ? " (icon)" : ""}${first.trashed ? " (in trash)" : ""}`;
  return a.uses.length > 1 ? `${where} and ${a.uses.length - 1} more` : where;
}

function FilesBody() {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const [files, setFiles] = useState<AttachmentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeHistory, setIncludeHistory] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => useFilesDialog.getState().hide();

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setFiles(await ipc.attachmentList(workspaceId));
      setError(null);
    } catch (e) {
      setError(toAppError(e).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const deletable = useCallback((a: AttachmentInfo) => a.uses.length === 0 && (!a.inHistory || includeHistory), [includeHistory]);

  // A file that stops being deletable (history box unticked) leaves the selection.
  useEffect(() => {
    if (!files) return;
    setSelected((s) => new Set([...s].filter((id) => files.some((f) => f.id === id && deletable(f)))));
  }, [files, deletable]);

  const shown = useMemo(() => {
    const list = (files ?? []).filter((f) => (filter === "unused" ? f.uses.length === 0 : filter === "images" ? isImage(f) : true));
    return [...list].sort((a, b) =>
      sort === "largest" ? b.size - a.size : sort === "name" ? a.originalName.localeCompare(b.originalName) : b.createdAt.localeCompare(a.createdAt),
    );
  }, [files, filter, sort]);

  const total = (files ?? []).reduce((n, f) => n + f.size, 0);
  const unused = (files ?? []).filter((f) => f.uses.length === 0);
  const unusedSize = unused.reduce((n, f) => n + f.size, 0);
  const picked = (files ?? []).filter((f) => selected.has(f.id));
  const pickedSize = picked.reduce((n, f) => n + f.size, 0);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async () => {
    if (!workspaceId || !picked.length) return;
    setBusy(true);
    try {
      const res = await ipc.attachmentDeleteUnused(workspaceId, picked.map((f) => f.id), includeHistory);
      useWorkspace.getState().notify(`Deleted ${res.deleted} ${res.deleted === 1 ? "file" : "files"}, freed ${formatBytes(res.freedBytes)}`);
      setSelected(new Set());
      setConfirming(false);
      await load();
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="files-head">
        <div>
          <h2>Files</h2>
          {files && (
            <p className="files-sub">
              {files.length} {files.length === 1 ? "file" : "files"}, {formatBytes(total)}
              {unused.length > 0 && ` · ${unused.length} not used (${formatBytes(unusedSize)})`}
            </p>
          )}
        </div>
        <button className="icon-btn" aria-label="Close files" onClick={close}>
          <Icon name="close" />
        </button>
      </div>

      <div className="files-bar">
        <div className="seg" role="radiogroup" aria-label="Show">
          {([["all", "All"], ["unused", "Not used"], ["images", "Images"]] as [Filter, string][]).map(([id, text]) => (
            <button key={id} role="radio" aria-checked={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
              {text}
            </button>
          ))}
        </div>
        <label className="files-sort">
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="newest">Newest first</option>
            <option value="largest">Largest first</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      {error && (
        <p className="error-text files-error" role="alert">
          {error}
        </p>
      )}

      <div className="files-list" role="list">
        {files === null && !error && <p className="files-note"><Loading /></p>}
        {files && shown.length === 0 && (
          <p className="files-note">{files.length === 0 ? "No files yet. Paste or drop one into a page to add it." : "No files match this filter."}</p>
        )}
        {shown.map((f) => (
          <div className="file-row" role="listitem" key={f.id}>
            <input
              type="checkbox"
              aria-label={`Select ${f.originalName}`}
              disabled={!deletable(f)}
              checked={selected.has(f.id)}
              title={deletable(f) ? "Select to delete" : f.uses.length ? "In use, so it cannot be deleted here" : "An old version of a page still shows it"}
              onChange={() => toggle(f.id)}
            />
            <Thumb file={f} />
            <div className="file-text">
              <div className="file-name" title={f.originalName}>
                {f.originalName}
              </div>
              <div className="file-meta">
                {formatBytes(f.size)} · <span className={f.uses.length ? "" : "file-unused"}>{usageText(f)}</span>
              </div>
            </div>
            <div className="file-actions">
              {f.uses.length > 0 && !f.uses[0].workspace && (
                <button
                  className="icon-btn"
                  aria-label={`Open ${f.uses[0].title || "Untitled"}`}
                  title="Open the page that uses it"
                  onClick={() => {
                    close();
                    void useWorkspace.getState().openPage(f.uses[0].pageId);
                  }}
                >
                  <Icon name="open" />
                </button>
              )}
              <button
                className="icon-btn"
                aria-label={`Save a copy of ${f.originalName}`}
                title="Save a copy…"
                onClick={() => void ipc.attachmentSaveAs(f.id).catch((e) => setError(toAppError(e).message))}
              >
                <Icon name="download" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="files-foot">
        <div className="files-foot-left">
          <button
            className="btn ghost"
            disabled={!files || !files.some(deletable)}
            onClick={() => setSelected(new Set((files ?? []).filter(deletable).map((f) => f.id)))}
          >
            Select all unused
          </button>
          <label className="files-check" title="A saved version of a page that shows the file will show a missing file after it is deleted">
            <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
            Include files only old versions use
          </label>
        </div>
        {confirming ? (
          <span className="confirm">
            <span className="files-confirm-text">Delete {picked.length} for good?</span>
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn danger" disabled={!picked.length} onClick={() => setConfirming(true)}>
            <Icon name="trash" />
            {picked.length ? `Delete ${picked.length} (${formatBytes(pickedSize)})` : "Delete"}
          </button>
        )}
      </div>
    </>
  );
}

/** Every stored file in the workspace, where it is used, and a safe way to clear out the unused ones. */
export function FilesDialog() {
  const open = useFilesDialog((s) => s.open);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="palette files"
      aria-label="Files"
      onClose={() => useFilesDialog.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useFilesDialog.getState().hide();
      }}
    >
      {open && <FilesBody />}
    </dialog>
  );
}
