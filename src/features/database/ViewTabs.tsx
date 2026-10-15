import { useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon, type IconName } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import type { DbView, ViewType } from "../../types";

export const VIEW_META: Record<ViewType, { label: string; icon: IconName; blurb: string }> = {
  table: { label: "Table", icon: "table", blurb: "Rows and columns" },
  board: { label: "Board", icon: "columns", blurb: "Cards in columns by status or select" },
  list: { label: "List", icon: "bullet", blurb: "Compact rows with key properties" },
  gallery: { label: "Gallery", icon: "image", blurb: "A grid of cards with previews" },
  calendar: { label: "Calendar", icon: "calendar", blurb: "Records placed on a month by date" },
  timeline: { label: "Timeline", icon: "timeline", blurb: "Date ranges as bars over time" },
  chart: { label: "Chart", icon: "chart", blurb: "Bars, lines, pies or a single number" },
  form: { label: "Form", icon: "form", blurb: "Fill in fields to add a record" },
  feed: { label: "Feed", icon: "feed", blurb: "Newest records first, by day" },
  canvas: { label: "Canvas", icon: "canvas", blurb: "A freeform board for cards, notes, images and arrows" },
};

const ORDER: ViewType[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form", "feed", "canvas"];

/** The tab strip above the toolbar: one tab per saved view, and a menu to add another. */
export function ViewTabs({
  views,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: {
  views: DbView[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (type: ViewType) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; view: DbView } | null>(null);
  const [adding, setAdding] = useState<Anchor | null>(null);
  const [renaming, setRenaming] = useState<{ view: DbView; anchor: Anchor } | null>(null);
  const [confirm, setConfirm] = useState<{ view: DbView; anchor: Anchor } | null>(null);
  const [draft, setDraft] = useState("");

  const items = (v: DbView, anchor: Anchor): MenuItem[] => [
    {
      label: "Rename",
      onSelect: () => {
        setDraft(v.name);
        setRenaming({ view: v, anchor });
      },
    },
    { label: "Duplicate", onSelect: () => onDuplicate(v.id) },
    { label: "Delete view", danger: true, separated: true, disabled: views.length <= 1, onSelect: () => setConfirm({ view: v, anchor }) },
  ];

  return (
    <div className="view-tabs" role="group" aria-label="Views">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          aria-pressed={v.id === activeId}
          className={`vtab${v.id === activeId ? " on" : ""}`}
          onClick={() => onSelect(v.id)}
          onDoubleClick={(e) => {
            setDraft(v.name);
            setRenaming({ view: v, anchor: anchorOf(e.currentTarget) });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, view: v });
          }}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom, view: v });
            }
          }}
        >
          <Icon name={VIEW_META[v.type].icon} size={14} />
          {v.name}
        </button>
      ))}
      <button type="button" className="vtab add" aria-label="Add a view" title="Add a view" aria-haspopup="menu" onClick={(e) => setAdding(anchorOf(e.currentTarget))}>
        <Icon name="plus" size={14} />
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items(menu.view, { left: menu.x, top: menu.y - 2, right: menu.x, bottom: menu.y + 2 })}
          onClose={() => setMenu(null)}
        />
      )}
      {adding && (
        <Popover anchor={adding} onClose={() => setAdding(null)} label="Add a view" className="picker view-types">
          <div className="picker-group">Layout</div>
          {ORDER.map((t) => (
            <button
              key={t}
              type="button"
              className="view-type"
              onClick={() => {
                setAdding(null);
                onCreate(t);
              }}
            >
              <Icon name={VIEW_META[t].icon} />
              <span>
                <b>{VIEW_META[t].label}</b>
                <small>{VIEW_META[t].blurb}</small>
              </span>
            </button>
          ))}
        </Popover>
      )}
      {renaming && (
        <Popover anchor={renaming.anchor} onClose={() => setRenaming(null)} label="Rename view" className="picker">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRename(renaming.view.id, draft);
              setRenaming(null);
            }}
          >
            <label className="field">
              <span>View name</span>
              <input value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <div className="picker-actions">
              <button type="button" className="btn" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!draft.trim()}>
                Save
              </button>
            </div>
          </form>
        </Popover>
      )}
      {confirm && (
        <Popover anchor={confirm.anchor} onClose={() => setConfirm(null)} label="Delete view" className="picker">
          <p className="confirm-text">Delete the “{confirm.view.name}” view? The records stay; only this layout is removed.</p>
          <div className="picker-actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                const id = confirm.view.id;
                setConfirm(null);
                onDelete(id);
              }}
            >
              Delete view
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}
