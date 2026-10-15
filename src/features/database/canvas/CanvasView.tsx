import { useCallback, useEffect, useMemo, useRef } from "react";
import { Icon } from "../../../components/Icon";
import { READ_ONLY } from "../../../lib/access";
import { thumbUrl } from "../../../lib/attachments";
import { newId } from "../../../lib/ids";
import { useWorkspace } from "../../../stores/workspace";
import type { CanvasItem, CanvasOp, DbView, Property, RecordRow } from "../../../types";
import { CardProp } from "../cells";
import { isEmptyValue } from "../model";
import { recordItems } from "../recordMenu";
import type { useDatabase } from "../useDatabase";
import { usePagedRecords } from "../usePagedRecords";
import { CanvasBoard } from "./CanvasBoard";
import { useCanvas } from "./useCanvas";
import { bounds, gridSlots } from "./viewport";

type Db = ReturnType<typeof useDatabase>;

const CARD_W = 240;
const CARD_H = 120;
const MAX_CARD_PROPS = 3;

interface RecordCard {
  row: RecordRow;
  preview: { imageHash?: string | null; text?: string | null } | undefined;
}

/** A database's canvas view: its records as cards, any of which can be placed anywhere, plus notes, images and arrows. */
export function CanvasView({ db, view, queryVersion }: { db: Db; view: DbView; queryVersion: number }) {
  const databaseId = db.detail!.database.id;
  const records = usePagedRecords({ databaseId, viewId: view.id, queryVersion, pageSize: 200, loadAll: true, previews: true });
  const canvas = useCanvas(view.id);
  const placing = useRef(new Set<string>());

  const props = useMemo(() => db.columns.map((c) => c.property).filter((p) => p.type !== "title"), [db.columns]);
  const cards = useMemo(() => new Map<string, unknown>(records.rows.map((row): [string, RecordCard] => [row.id, { row, preview: records.previews[row.id] }])), [records.rows, records.previews]);

  // Records that are not on the board yet get a spot below what is there.
  useEffect(() => {
    if (READ_ONLY || !canvas.data || !records.done || records.loading) return;
    const placed = new Set(canvas.data.items.map((i) => i.recordId).filter(Boolean));
    const room = Math.max(0, 1000 - canvas.data.items.length);
    const missing = records.rows.filter((r) => !placed.has(r.id) && !placing.current.has(r.id)).slice(0, room);
    if (!missing.length) return;
    const all = bounds(canvas.data.items);
    const origin = { x: all ? all.x : 0, y: all ? all.y + all.h + 48 : 0 };
    const slots = gridSlots(missing.length, origin, { w: CARD_W, h: CARD_H });
    let z = canvas.data.items.reduce((m, i) => Math.max(m, i.z), 0);
    const ops: CanvasOp[] = missing.map((r, n) => {
      placing.current.add(r.id);
      return { op: "upsert_item", item: { id: newId(), kind: "record", recordId: r.id, text: "", attachmentHash: null, x: slots[n].x, y: slots[n].y, w: CARD_W, h: CARD_H, z: ++z, color: null } };
    });
    canvas.apply(ops);
  }, [canvas, canvas.data, records.done, records.loading, records.rows]);

  const renderCard = useCallback(
    (card: unknown, _item: CanvasItem, open: () => void) => {
      const { row, preview } = card as RecordCard;
      return <RecordCardBody row={row} preview={preview} props={props} onOpen={open} />;
    },
    [props],
  );
  const cardLabel = useCallback((card: unknown) => (card as RecordCard).row.title || "Untitled", []);
  const openCard = useCallback((card: unknown) => void useWorkspace.getState().openPage((card as RecordCard).row.pageId), []);
  const cardMenu = useCallback((card: unknown) => recordItems((card as RecordCard).row, records.reload), [records.reload]);

  const notice = records.truncated ? "Only the first 1,000 records are placed on a canvas. Narrow the view with a filter to see the rest." : null;

  return (
    <CanvasBoard
      scopeId={view.id}
      canvas={canvas}
      ready={records.done}
      awaitingPlacement={records.rows.length > 0}
      cards={cards}
      renderCard={renderCard}
      cardLabel={cardLabel}
      openCard={openCard}
      cardMenu={cardMenu}
      removableCards={false}
      notice={notice}
    />
  );
}

function RecordCardBody({ row, preview, props, onOpen }: { row: RecordRow; preview: RecordCard["preview"]; props: Property[]; onOpen: () => void }) {
  const shown = props.filter((p) => !isEmptyValue(row.values[p.id])).slice(0, MAX_CARD_PROPS);
  return (
    <>
      <div className="cv-card-head">
        <span className="cv-card-title">{row.title || <span className="cell-placeholder">Untitled</span>}</span>
        <button type="button" className="icon-btn cv-open" aria-label={`Open ${row.title || "Untitled"}`} onClick={onOpen}>
          <Icon name="page" size={14} />
        </button>
      </div>
      {preview?.imageHash ? <img className="cv-card-image" src={thumbUrl(preview.imageHash, 320)} alt="" draggable={false} /> : preview?.text ? <p className="cv-card-text">{preview.text}</p> : null}
      {shown.length > 0 && (
        <div className="card-props">
          {shown.map((p) => (
            <div key={p.id} className="card-prop" title={p.name}>
              <CardProp prop={p} row={row} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
