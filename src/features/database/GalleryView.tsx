import { useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { recordItems } from "./recordMenu";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import type { DbView, RecordRow } from "../../types";
import { thumbUrl } from "../../lib/attachments";
import { CardProp } from "./cells";
import { isEmptyValue } from "./model";
import type { useDatabase } from "./useDatabase";
import { usePagedRecords } from "./usePagedRecords";

const PAGE = 48;
const MAX_PROPS = 3;

type Db = ReturnType<typeof useDatabase>;

function Preview({ row, preview, edge }: { row: RecordRow; preview: ReturnType<typeof usePagedRecords>["previews"][string] | undefined; edge: 320 | 640 }) {
  const [broken, setBroken] = useState(false);
  if (preview?.imageHash && !broken) {
    return <img className="gal-image" src={thumbUrl(preview.imageHash, edge)} alt={preview.imageName ?? ""} loading="lazy" onError={() => setBroken(true)} />;
  }
  if (preview?.text) return <p className="gal-text">{preview.text}</p>;
  return (
    <div className="gal-blank" aria-hidden="true">
      <Icon name="page" size={20} />
      <span className="sr-only">{row.title}</span>
    </div>
  );
}

/** A grid of cards: a preview (first image, else the start of the text), the title and a few properties. */
export function GalleryView({ db, view, queryVersion, onCreate }: { db: Db; view: DbView; queryVersion: number; onCreate: () => void }) {
  const databaseId = db.detail!.database.id;
  const data = usePagedRecords({ databaseId, viewId: view.id, queryVersion, pageSize: PAGE, previews: true });
  const openPage = useWorkspace((s) => s.openPage);
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow } | null>(null);
  const size = view.config.cardSize ?? "medium";
  const props = db.columns.map((c) => c.property).filter((p) => p.type !== "title");

  const items = (row: RecordRow): MenuItem[] => recordItems(row, data.reload);

  if (data.done && data.rows.length === 0 && !data.error) {
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
    <div className="gallery-wrap">
      {data.error && (
        <p className="error-text" role="alert">
          {data.error}{" "}
          <button type="button" className="link" onClick={data.reload}>
            Try again
          </button>
        </p>
      )}
      <ul className={`gallery size-${size}`} aria-label="Records" aria-busy={data.loading}>
        {data.rows.map((row) => {
          const shown = props.filter((p) => !isEmptyValue(row.values[p.id])).slice(0, MAX_PROPS);
          return (
            <li key={row.id} className="gal-card" onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, row }))}>
              <button type="button" className="gal-open" onClick={() => void openPage(row.pageId)}>
                <span className="gal-preview">
                  <Preview row={row} preview={data.previews[row.id]} edge={size === "small" ? 320 : 640} />
                </span>
                <span className="gal-title">{row.title || <span className="cell-placeholder">Untitled</span>}</span>
              </button>
              <button type="button" className="icon-btn card-menu" aria-label={`Actions for ${row.title || "Untitled"}`} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, row })}>
                <Icon name="more" />
              </button>
              {shown.length > 0 && (
                <div className="card-props">
                  {shown.map((p) => (
                    <div key={p.id} className="card-prop" title={p.name}>
                      <CardProp prop={p} row={row} />
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
        {data.loading && !data.rows.length && Array.from({ length: 6 }, (_, i) => <li key={i} className="gal-card skeleton" aria-hidden="true" />)}
      </ul>
      {data.hasMore && (
        <button type="button" className="load-more gal-more" disabled={data.loading} onClick={data.loadMore}>
          {data.loading ? "Loading…" : "Show more"}
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.row)} onClose={() => setMenu(null)} />}
    </div>
  );
}
