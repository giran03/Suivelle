import { useEffect, useState } from "react";
import { ContextMenu } from "../../components/ContextMenu";
import type { Page } from "../../types";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

/** Destructive buttons ask twice, inline, instead of opening a modal. */
function Confirm({ label, confirmLabel, onConfirm, danger = true, request = 0 }: { label: string; confirmLabel: string; onConfirm: () => void; danger?: boolean; request?: number }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (request) setAsking(true); }, [request]);
  return asking ? (
    <span className="confirm" role="group" aria-label={confirmLabel}>
      <button className={`btn${danger ? " danger" : ""}`} autoFocus onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button className="btn" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button className="btn" onClick={() => setAsking(true)}>
      {label}
    </button>
  );
}

export function TrashView() {
  const [menu, setMenu] = useState<{ x: number; y: number; page: Page } | null>(null);
  const [request, setRequest] = useState<{ id: string; seq: number } | null>(null);
  const trash = useWorkspace((s) => s.trash);
  const { restorePage, deletePermanently, emptyTrash } = useWorkspace.getState();

  return (
    <div className="trash">
      {menu && <ContextMenu x={menu.x} y={menu.y} items={[
        { label: "Restore", onSelect: () => void restorePage(menu.page.id) },
        { label: "Delete forever…", danger: true, separated: true, onSelect: () => setRequest((r) => ({ id: menu.page.id, seq: (r?.seq ?? 0) + 1 })) },
      ]} onClose={() => setMenu(null)} />}
      <div className="trash-head">
        <h1>Trash</h1>
        {trash.length > 0 && (
          <Confirm label="Empty trash" confirmLabel="Delete everything forever" onConfirm={() => void emptyTrash()} />
        )}
      </div>
      {trash.length === 0 ? (
        <p className="empty">Trash is empty. Pages you delete stay here until you remove them for good.</p>
      ) : (
        <ul className="trash-list">
          {trash.map((p) => (
            <li key={p.id} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, page: p }); }}>
              <Icon name="page" />
              <span className="trash-title">{p.title || "Untitled"}</span>
              <span className="trash-when">Deleted {when(p.deletedAt)}</span>
              <button className="btn" onClick={() => void restorePage(p.id)}>
                <Icon name="restore" />
                Restore
              </button>
              <Confirm request={request?.id === p.id ? request.seq : 0} label="Delete forever" confirmLabel="Confirm delete" onConfirm={() => void deletePermanently(p.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
