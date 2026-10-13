import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Icon } from "../../components/Icon";
import { syncDialog } from "../../lib/dialog";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { WorkspaceBadge } from "../workspaces/WorkspaceBadge";
import { transferPages } from "./pageClipboard";
import { clearSelection } from "./pageSelection";

interface TransferState {
  open: boolean;
  pages: Page[];
  mode: "move" | "copy";
  show: (pages: Page[], mode: "move" | "copy") => void;
  hide: () => void;
}

export const usePageTransfer = create<TransferState>((set) => ({
  open: false,
  pages: [],
  mode: "move",
  show: (pages, mode) => set({ open: true, pages, mode }),
  hide: () => set({ open: false }),
}));

function Body({ pages, mode }: { pages: Page[]; mode: "move" | "copy" }) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const [busy, setBusy] = useState<string | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  useEffect(() => void useWorkspace.getState().refreshWorkspaces(), []);
  const from = pages[0]?.workspaceId;
  const others = workspaces.filter((w) => w.id !== from);
  const verb = mode === "move" ? "Move" : "Copy";
  const name = pages.length === 1 ? `“${pages[0].title || "Untitled"}”` : `${pages.length} pages`;
  const them = pages.length === 1 ? "The page and the pages inside it" : "The pages and the pages inside them";

  const go = async (id: string) => {
    // A move deletes the originals for good, so it asks once more.
    if (mode === "move" && sure !== id) {
      setSure(id);
      return;
    }
    setBusy(id);
    const done = await transferPages(pages, id, mode);
    setBusy(null);
    if (done) {
      clearSelection();
      usePageTransfer.getState().hide();
    }
  };

  return (
    <div className="bak">
      <header className="tpl-head">
        <h2>
          {verb} {name} to…
        </h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => usePageTransfer.getState().hide()}>
          <Icon name="close" />
        </button>
      </header>
      <p className="picker-muted">
        {mode === "move" ? `${them} go to the top level of the workspace you pick. The originals are then deleted for good, and this cannot be undone.` : `A copy of ${them.toLowerCase()} goes to the top level of the workspace you pick.`}
      </p>
      {others.length === 0 ? (
        <p className="picker-muted">There is no other workspace yet. Create one from the workspace menu first.</p>
      ) : (
        <ul className="bak-list" aria-label="Workspaces">
          {others.map((w) => (
            <li key={w.id} className="bak-row">
              <WorkspaceBadge workspace={w} />
              <span className="bak-text">
                <b>{w.name}</b>
              </span>
              <button type="button" className={sure === w.id ? "btn danger" : "btn"} disabled={busy !== null} onClick={() => void go(w.id)}>
                {busy === w.id ? "Working…" : sure === w.id ? "Confirm: move and delete" : verb}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Asks which workspace pages go to. Opened from the page menu (Move to workspace, Copy to workspace). */
export function PageTransferDialog() {
  const { open, pages, mode } = usePageTransfer();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="palette tpl-dialog"
      aria-label="Move or copy pages to another workspace"
      onClose={() => usePageTransfer.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) usePageTransfer.getState().hide();
      }}
    >
      {open && pages.length > 0 && <Body pages={pages} mode={mode} />}
    </dialog>
  );
}
