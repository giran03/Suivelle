import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { ipc, toAppError } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";
import type { DatabaseDetail } from "../../../types";
import { DatabaseView } from "../../database/DatabaseView";
import "../embeds.css";
import { PickItem, useLoaded } from "./pickers";
import { SearchField } from "../../../components/SearchField";

const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 900;

/** Chooses which database this block shows, or creates a new one. */
function Picker({ onPick, onCancel }: { onPick: (pageId: string) => void; onCancel?: () => void }) {
  const [query, setQuery] = useState("");
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const { data: list, error, setError } = useLoaded(workspaceId, (id) => ipc.databaseList(id));

  const shown = (list ?? []).filter((d) => (d.title || "Untitled").toLowerCase().includes(query.trim().toLowerCase()));

  const create = async () => {
    if (!workspaceId) return;
    try {
      const created = await ipc.databaseCreate(workspaceId, null);
      await useWorkspace.getState().reloadTree();
      onPick(created.page.id);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  return (
    <div className="dbv-picker">
      <div className="dbv-picker-head">
        <Icon name="table" />
        <SearchField
          wrapClassName="sf-grow"
          autoFocus
          value={query}
          placeholder="Search databases…"
          aria-label="Search databases"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && shown[0]) onPick(shown[0].pageId);
            if (e.key === "Escape") onCancel?.();
          }}
        />
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <ul className="dbv-picker-list">
        {shown.map((d) => (
          <PickItem key={d.id} icon="table" onPick={() => onPick(d.pageId)}>
            {d.title || "Untitled"}
          </PickItem>
        ))}
        {list && shown.length === 0 && <li className="dbv-none">{list.length ? "No database matches." : "This workspace has no databases yet."}</li>}
      </ul>
      <button type="button" className="btn" onClick={() => void create()}>
        <Icon name="plus" />
        New database
      </button>
    </div>
  );
}

function DatabaseViewNode({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const pageId = (node.attrs.pageId as string | null) ?? null;
  const viewId = (node.attrs.viewId as string | null) ?? null;
  const savedHeight = typeof node.attrs.height === "number" ? (node.attrs.height as number) : DEFAULT_HEIGHT;
  const editable = editor.isEditable;
  const [changing, setChanging] = useState(false);
  const [detail, setDetail] = useState<DatabaseDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [height, setHeight] = useState(savedHeight);
  const dragging = useRef(false);
  const dataEpoch = useWorkspace((s) => s.dataEpoch);

  useEffect(() => {
    if (!dragging.current) setHeight(savedHeight);
  }, [savedHeight]);

  useEffect(() => {
    if (!pageId) return;
    let alive = true;
    setMissing(null);
    ipc
      .databaseGet(pageId)
      .then((d) => alive && setDetail(d))
      .catch((e) => {
        if (!alive) return;
        setDetail(null);
        setMissing(toAppError(e).message);
      });
    return () => {
      alive = false;
    };
  }, [pageId, dataEpoch]);

  const activeViewId = useMemo(() => {
    if (!detail) return null;
    return viewId && detail.views.some((v) => v.id === viewId) ? viewId : (detail.views[0]?.id ?? null);
  }, [detail, viewId]);

  const choose = (id: string) => {
    updateAttributes({ pageId: id, viewId: null });
    setChanging(false);
  };

  if (!pageId || changing) {
    return (
      <NodeViewWrapper className={`dbv${selected ? " is-selected" : ""}`} contentEditable={false}>
        {editable ? (
          <Picker onPick={choose} onCancel={pageId ? () => setChanging(false) : undefined} />
        ) : (
          <p className="dbv-none">No database chosen.</p>
        )}
      </NodeViewWrapper>
    );
  }

  if (missing) {
    return (
      <NodeViewWrapper className="dbv" contentEditable={false}>
        <div className="dbv-missing" role="alert">
          <Icon name="warning" />
          <span>This database can't be shown. It may have been deleted or moved to the trash.</span>
          {editable && (
            <button type="button" className="btn" onClick={() => setChanging(true)}>
              Choose another
            </button>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragging.current = true;
    const startY = e.clientY;
    const startH = height;
    let latest = startH;
    const move = (ev: PointerEvent) => {
      latest = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + ev.clientY - startY));
      setHeight(latest);
    };
    const stop = () => {
      dragging.current = false;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
      updateAttributes({ height: Math.round(latest) });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
  };

  return (
    <NodeViewWrapper className={`dbv${selected ? " is-selected" : ""}`} contentEditable={false}>
      <div className="dbv-head">
        <Icon name="table" />
        <button type="button" className="dbv-title" title="Open this database" onClick={() => void useWorkspace.getState().openPage(pageId)}>
          {detail ? detail.page.title || "Untitled" : "Loading…"}
        </button>
        {detail && detail.views.length > 1 && (
          <select
            className="dbv-views"
            aria-label="View"
            value={activeViewId ?? ""}
            disabled={!editable}
            onChange={(e) => updateAttributes({ viewId: e.target.value })}
          >
            {detail.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <span className="dbv-spacer" />
        <button type="button" className="icon-btn" aria-label="Open as a page" title="Open as a page" onClick={() => void useWorkspace.getState().openPage(pageId)}>
          <Icon name="open" />
        </button>
        {editable && (
          <button type="button" className="icon-btn" aria-label="Show a different database" title="Show a different database" onClick={() => setChanging(true)}>
            <Icon name="duplicate" />
          </button>
        )}
      </div>
      <div className="dbv-body" style={{ height }}>
        {activeViewId ? (
          <DatabaseView key={`${pageId}:${activeViewId}`} pageId={pageId} embedded={{ viewId: activeViewId, tools: true }} />
        ) : (
          detail && <p className="dbv-none">This database has no views.</p>
        )}
      </div>
      {editable && (
        <div className="dbv-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the database block" title="Drag to resize" onPointerDown={startResize} />
      )}
    </NodeViewWrapper>
  );
}

export const DatabaseViewBlock = Node.create({
  name: "databaseView",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const attr = { default: null };
    return { pageId: attr, viewId: attr, height: attr };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="database-view"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "database-view" }, HTMLAttributes)];
  },

  addNodeView() {
    // The grid, filters and cells handle their own keys and pointers; the editor must not.
    return ReactNodeViewRenderer(DatabaseViewNode, { stopEvent: () => true, ignoreMutation: () => true });
  },
});
