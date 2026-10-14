import { useEffect, useRef, useState } from "react";
import { Collapse } from "../../components/Collapse";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { READ_ONLY } from "../../lib/access";
import { useLayout } from "../../stores/layout";
import { useWorkspace } from "../../stores/workspace";
import type { CanvasBoard } from "../../types";
import "./canvas-boards.css";
import { useBoards } from "./store";

/**
 * The workspace's canvas boards, between Recent and Pages. Each is a freeform whiteboard of pages, notes,
 * images and arrows; the header's plus makes a new one.
 */
export function CanvasesSection() {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const view = useWorkspace((s) => s.view);
  const { boards, loaded, activeId } = useBoards();
  const open = useLayout((s) => s.canvasOpen);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; board: CanvasBoard } | null>(null);

  useEffect(() => {
    if (workspaceId) void useBoards.getState().load(workspaceId);
  }, [workspaceId]);

  const items = (board: CanvasBoard): MenuItem[] => [
    { label: "Open", onSelect: () => useBoards.getState().open(board.id) },
    ...(READ_ONLY
      ? []
      : [
          { label: "Rename", onSelect: () => setRenaming(board.id) },
          { label: "Duplicate", onSelect: () => void useBoards.getState().duplicate(board.id) },
          { label: "Delete canvas…", danger: true, separated: true, onSelect: () => setConfirming(board.id) },
        ]),
  ];

  if (!workspaceId || (loaded && boards.length === 0 && READ_ONLY)) return null;
  return (
    <section className="sidebar-recents sidebar-canvases">
      <h2 className="canvases-heading">
        <button className="section-toggle" aria-expanded={open} onClick={() => useLayout.getState().toggleCanvases()}>
          <Icon name="chevron" size={12} />
          Canvases
        </button>
        {!READ_ONLY && (
          <button type="button" className="icon-btn" aria-label="New canvas" title="New canvas" onClick={() => void useBoards.getState().create()}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </h2>
      <Collapse open={open}>
        {loaded && boards.length === 0 ? (
          <p className="side-empty canvases-empty">A whiteboard for pages, notes and images.</p>
        ) : (
          <ul className="canvas-list" aria-label="Canvases">
            {boards.map((b) =>
              confirming === b.id ? (
                <li key={b.id} className="canvas-confirm" role="alert">
                  <span>Delete “{b.name}”? The pages on it are not affected.</span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirming(null);
                      void useBoards.getState().remove(b.id);
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </li>
              ) : (
                <li
                  key={b.id}
                  className={`canvas-row${view === "canvas" && activeId === b.id ? " selected" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, board: b });
                  }}
                >
                  {renaming === b.id ? (
                    <RenameField
                      board={b}
                      onDone={(name) => {
                        setRenaming(null);
                        if (name && name !== b.name) void useBoards.getState().rename(b.id, name);
                      }}
                    />
                  ) : (
                    <>
                      <button type="button" className="title" aria-current={view === "canvas" && activeId === b.id ? "page" : undefined} onClick={() => useBoards.getState().open(b.id)}>
                        <Icon name="canvas" size={16} />
                        <span>{b.name}</span>
                      </button>
                      <span className="actions">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Options for ${b.name}`}
                          aria-haspopup="menu"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setMenu({ x: r.left, y: r.bottom + 4, board: b });
                          }}
                        >
                          <Icon name="more" size={14} />
                        </button>
                      </span>
                    </>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </Collapse>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.board)} onClose={() => setMenu(null)} />}
    </section>
  );
}

function RenameField({ board, onDone }: { board: CanvasBoard; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => ref.current?.select(), []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      autoFocus
      defaultValue={board.name}
      aria-label="Canvas name"
      maxLength={120}
      onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value.trim() || null);
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}
