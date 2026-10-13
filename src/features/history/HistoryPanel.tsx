import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { PreviewBlock, RevisionDetail, RevisionMeta } from "../../types";
import { formatStamp } from "../database/model";
import { flushAllEditors } from "../editor/flushRegistry";

import { useHistoryPanel } from "./store";
export { useHistoryPanel } from "./store";


const KIND: Record<RevisionMeta["kind"], string> = { auto: "Automatic", manual: "Saved by you", restore: "Before a restore" };
const MARK: Record<PreviewBlock["change"], { sign: string; label: string }> = {
  same: { sign: "", label: "" },
  changed: { sign: "~", label: "Differs from the page now" },
  added: { sign: "+", label: "Not on the page now; restoring brings it back" },
  removed: { sign: "−", label: "On the page now; restoring removes it" },
};

function Block({ b }: { b: PreviewBlock }) {
  const mark = MARK[b.change];
  return (
    <li className={`hist-block ${b.change}`} style={{ paddingLeft: 8 + b.depth * 14 }}>
      <span className="hist-mark" title={mark.label} role={mark.label ? "img" : undefined} aria-label={mark.label || undefined}>
        {mark.sign}
      </span>
      <span className="hist-type">{b.type.replace(/_/g, " ")}</span>
      <span className="hist-text">{b.text || <span className="picker-muted">(empty)</span>}</span>
    </li>
  );
}

function Body({ pageId }: { pageId: string }) {
  const [versions, setVersions] = useState<RevisionMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useWorkspace((s) => s.notify);
  const hide = useHistoryPanel((s) => s.hide);

  const load = useCallback(async () => {
    try {
      await flushAllEditors();
      const list = await ipc.historyList(pageId);
      setVersions(list);
      setSelected((s) => (s && list.some((v) => v.id === s) ? s : (list[0]?.id ?? null)));
      setError(null);
    } catch (e) {
      setError(toAppError(e).message);
    }
  }, [pageId]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    let cancelled = false;
    ipc
      .historyGet(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const saveVersion = async () => {
    setBusy(true);
    try {
      await flushAllEditors();
      const v = await ipc.historySaveVersion(pageId);
      await load();
      setSelected(v.id);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const reloadPage = async () => {
    const s = useWorkspace.getState();
    await s.selectPage(pageId, { fromHistory: true });
    s.bumpEditor();
  };

  const restore = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await flushAllEditors();
      const safety = await ipc.historyRestore(detail.meta.id);
      await reloadPage();
      await load();
      notify(`Restored the version from ${formatStamp(detail.meta.createdAt)}`, safety ? async () => {
        await ipc.historyRestore(safety);
        await reloadPage();
        await load();
      } : undefined);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const changes = detail ? detail.blocks.filter((b) => b.change !== "same").length + detail.removed.length : 0;

  return (
    <>
      <header className="hist-head">
        <h2>Version history</h2>
        <button type="button" className="icon-btn" aria-label="Close history" onClick={hide}>
          <Icon name="close" />
        </button>
      </header>
      <div className="hist-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void saveVersion()}>
          <Icon name="plus" size={14} />
          Save version
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="hist-body">
        <ul className="hist-list" role="listbox" aria-label="Versions" aria-busy={!versions}>
          {versions?.length === 0 && <li className="picker-muted hist-empty">No earlier versions yet. They are saved as you work.</li>}
          {versions?.map((v) => (
            <li key={v.id} role="option" aria-selected={v.id === selected}>
              <button type="button" className={`hist-item${v.id === selected ? " on" : ""}`} onClick={() => setSelected(v.id)}>
                <span className="hist-when">{formatStamp(v.createdAt)}</span>
                <span className="hist-meta">
                  {KIND[v.kind]} · {v.blockCount} {v.blockCount === 1 ? "block" : "blocks"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {detail && (
          <section className="hist-preview" aria-label="Preview of this version">
            <h3>{detail.meta.title || "Untitled"}</h3>
            {detail.meta.title !== detail.currentTitle && <p className="picker-muted">The page is called “{detail.currentTitle || "Untitled"}” now.</p>}
            <p className="picker-muted" aria-live="polite">
              {changes === 0 ? "Identical to the page now." : `${changes} ${changes === 1 ? "difference" : "differences"} from the page now.`}
            </p>
            <ul className="hist-blocks">
              {detail.blocks.map((b) => (
                <Block key={b.id} b={b} />
              ))}
              {detail.blocks.length === 0 && <li className="picker-muted hist-empty">This version was empty.</li>}
            </ul>
            {detail.removed.length > 0 && (
              <>
                <h4>Would be removed</h4>
                <ul className="hist-blocks">
                  {detail.removed.map((b) => (
                    <Block key={b.id} b={b} />
                  ))}
                </ul>
              </>
            )}
            <div className="hist-restore">
              <button type="button" className="btn primary" disabled={busy || changes === 0} onClick={() => void restore()}>
                Restore this version
              </button>
              <p className="picker-muted">The page as it is now is saved first, so you can undo.</p>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/** Slides in from the right of the page; shows the saved versions of the open page or record. */
export function HistoryPanel() {
  const open = useHistoryPanel((s) => s.open);
  const hide = useHistoryPanel((s) => s.hide);
  const page = useWorkspace((s) => s.selectedPage);
  const view = useWorkspace((s) => s.view);
  const eligible = !!page && view === "page" && page.kind !== "database" && page.kind !== "dashboard";

  useEffect(() => {
    if (!eligible) hide();
  }, [eligible, page?.id, hide]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hide]);

  if (!open || !eligible || !page) return null;
  return (
    <aside className="hist-panel" aria-label="Version history">
      <Body key={page.id} pageId={page.id} />
    </aside>
  );
}
