import { useState, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import { toAppError } from "../../lib/ipc";
import type { Workspace } from "../../types";

function Row({ workspace, disabled, move, children }: { workspace: Workspace; disabled: boolean; move: (id: string, direction: number) => void; children: ReactNode }) {
  const drag = useDraggable({ id: workspace.id, disabled });
  const drop = useDroppable({ id: workspace.id, disabled });
  return <li ref={(node) => { drag.setNodeRef(node); drop.setNodeRef(node); }} className={`ws-reorder-row${drag.isDragging ? " dragging" : ""}${drop.isOver && !drag.isDragging ? " drop-target" : ""}`}>
    <button type="button" ref={drag.setActivatorNodeRef} className="ws-drag-handle" disabled={disabled} {...drag.attributes} {...drag.listeners}
      aria-label={`Reorder ${workspace.name}. Use Up and Down arrow keys to move.`} title="Drag to reorder; arrow keys also work"
      onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); move(workspace.id, e.key === "ArrowUp" ? -1 : 1); } }}><Icon name="grip" size={14} /></button>
    {children}
  </li>;
}

export function WorkspaceList({ workspaces, disabled, className, children }: { workspaces: Workspace[]; disabled: boolean; className?: string; children: (workspace: Workspace) => ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    <ul className={className}>{workspaces.map((w) => <Row key={w.id} workspace={w} disabled={disabled} move={(id, direction) => { const index = workspaces.findIndex((item) => item.id === id); const target = workspaces[index + direction]; if (target) reorder(id, target.id); }}>{children(w)}</Row>)}</ul>
    <span className="sr-only" role="status">{status}</span>
    {error && <p className="field-error" role="alert">{error}</p>}
  </DndContext>;
}
