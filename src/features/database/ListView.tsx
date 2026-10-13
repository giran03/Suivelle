import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "../../components/ContextMenu";
import { recordItems } from "./recordMenu";
import type { RecordRow } from "../../types";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import type { DbView } from "../../types";
import { CardProp } from "./cells";
import { GroupLabel } from "./GroupLabel";
import type { HeaderSegment } from "./groups";
import { isEmptyValue } from "./model";
import type { useDatabase } from "./useDatabase";
import type { useRecordTable } from "./useRecordTable";
import { useScaled } from "../../stores/preferences";

const BASE_ROW_HEIGHT = 38;
const MAX_PROPS = 4;

type Db = ReturnType<typeof useDatabase>;
type Table = ReturnType<typeof useRecordTable>;

/** Compact rows: the title, then the first few visible properties that have a value. */
export function ListView({ db, view, table, onToggleGroup, onCreate }: { db: Db; view: DbView; table: Table; onToggleGroup: (h: HeaderSegment) => void; onCreate: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const openPage = useWorkspace((s) => s.openPage);
  const ROW_HEIGHT = useScaled(BASE_ROW_HEIGHT, 30);
  const virtualizer = useVirtualizer({ count: table.rowCount, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });
  useEffect(() => virtualizer.measure(), [ROW_HEIGHT]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  const { ensureRange } = table;
  useEffect(() => {
    if (items.length) ensureRange(first, last);
  }, [first, last, items.length, ensureRange]);

  const cardProps = db.columns.map((c) => c.property).filter((p) => p.type !== "title" && p.id !== view.config.group?.propertyId && p.id !== view.config.subgroup?.propertyId);

  if (table.loaded && table.rowCount === 0) {
    return (
      <div className="view-empty">
        <p>No records here yet.</p>
        <button type="button" className="btn" onClick={onCreate}>
          <Icon name="plus" size={14} />
          New record
        </button>
      </div>
    );
  }

  return (
    <div className="list-view" ref={scroller} role="list" aria-label="Records" aria-busy={!table.loaded}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((v) => {
          const item = table.itemAt(v.index);
          const style = { transform: `translateY(${v.start}px)`, height: ROW_HEIGHT };
          if (item.type === "header") {
            const h = item.header;
            const spec = h.level === 0 ? view.config.group : view.config.subgroup;
            return (
              <div key={v.key} role="listitem" className={`list-group level-${h.level}`} style={style}>
                <button type="button" className="group-toggle" aria-expanded={!h.collapsed} onClick={() => onToggleGroup(h)}>
                  <Icon name="chevron" size={14} />
                  <GroupLabel prop={db.byId.get(spec?.propertyId ?? "")} groupKey={h.key} spec={spec} />
                  <span className="group-count">{h.count.toLocaleString()}</span>
                </button>
              </div>
            );
          }
          const row = item.row;
          if (!row) return <div key={v.key} role="listitem" className="list-row skeleton" style={style} aria-hidden="true" />;
          const shown = cardProps.filter((p) => !isEmptyValue(row.values[p.id])).slice(0, MAX_PROPS);
          return (
            <div key={v.key} role="listitem" className="list-row" style={style} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}>
              <button type="button" className="list-title" onClick={() => void openPage(row.pageId)}>
                {row.title || <span className="cell-placeholder">Untitled</span>}
              </button>
              <div className="list-props">
                {shown.map((p) => (
                  <span key={p.id} className="list-prop" title={p.name}>
                    <CardProp prop={p} row={row} />
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={recordItems(menu.row, table.reload)} onClose={() => setMenu(null)} />}
    </div>
  );
}
