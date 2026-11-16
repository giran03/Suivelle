import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import { toAppError } from "../../lib/ipc";
import type { Workspace } from "../../types";

function Row({ workspace, disabled, move, children }: { workspace: Workspace; disabled: boolean; move: (id: string, direction: number) => void; children: ReactNode }) {
  const drag = useDraggable({ id: workspace.id, disabled });
  const drop = useDroppable({ id: workspace.id, disabled });
  return <li ref={(node) => { drag.setNodeRef(node); drop.setNodeRef(node); }} data-ws-id={workspace.id} className={`ws-reorder-row${drag.isDragging ? " dragging" : ""}${drop.isOver && !drag.isDragging ? " drop-target" : ""}`}>
    <button type="button" ref={drag.setActivatorNodeRef} className="ws-drag-handle" disabled={disabled} {...drag.attributes} {...drag.listeners}
      aria-label={`Reorder ${workspace.name}. Use Up and Down arrow keys to move.`} title="Drag to reorder; arrow keys also work"
      onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); move(workspace.id, e.key === "ArrowUp" ? -1 : 1); } }}><Icon name="grip" size={14} /></button>
    {children}
    {drop.isOver && !drag.isDragging && <span className="ws-drop-skel" aria-hidden="true"><span className="ws-drop-skel-badge" /><span className="ws-drop-skel-lines"><i style={{ width: "44%" }} /><i style={{ width: "72%" }} /></span></span>}
  </li>;
}

export function WorkspaceList({ workspaces, disabled, className, children }: { workspaces: Workspace[]; disabled: boolean; className?: string; children: (workspace: Workspace) => ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const positionsRef = useRef<Map<string, number>>(new Map());
  const orderKey = workspaces.map((w) => w.id).join("|");

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduced =
      document.documentElement.dataset.motion === "reduced" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const prev = positionsRef.current;
    const next = new Map<string, number>();
    const items = list.querySelectorAll<HTMLLIElement>(":scope > li[data-ws-id]");
    items.forEach((el) => {
      const id = el.dataset.wsId!;
      const top = el.getBoundingClientRect().top;
      next.set(id, top);
      const oldTop = prev.get(id);
      if (!reduced && prev.size > 0 && oldTop !== undefined) {
        const dy = oldTop - top;
        if (Math.abs(dy) > 1) {
          el.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
            { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
          );
        }
      }
    });
    positionsRef.current = next;
  }, [orderKey]);
  const reorder = (id: string, target: string) => {
    if (disabled || id === target) return;
    try {
      useWorkspace.getState().reorderWorkspace(id, target);
      const ordered = useWorkspace.getState().workspaces;
      setStatus(`${ordered.find((w) => w.id === id)?.name} moved to position ${ordered.findIndex((w) => w.id === id) + 1} of ${ordered.length}.`);
      setError(null);
    } catch (e) { setError(toAppError(e).message); }
  };
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => { if (over) reorder(String(active.id), String(over.id)); }}>
    <ul ref={listRef} className={className}>{workspaces.map((w) => <Row key={w.id} workspace={w} disabled={disabled} move={(id, direction) => { const index = workspaces.findIndex((item) => item.id === id); const target = workspaces[index + direction]; if (target) reorder(id, target.id); }}>{children(w)}</Row>)}</ul>
    <span className="sr-only" role="status">{status}</span>
    {error && <p className="field-error" role="alert">{error}</p>}
  </DndContext>;
}
