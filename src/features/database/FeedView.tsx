import { useMemo, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { recordItems } from "./recordMenu";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import type { DbView, RecordRow } from "../../types";
import { thumbUrl } from "../../lib/attachments";
import { CardProp } from "./cells";
import { groupByDay, timeOfDay } from "./feed";
import { isEmptyValue } from "./model";
import type { useDatabase } from "./useDatabase";
import { usePagedRecords } from "./usePagedRecords";

const PAGE = 30;
const MAX_PROPS = 4;

type Db = ReturnType<typeof useDatabase>;

/** Records as a stream, newest first, grouped by day: title, key properties and the start of the text. */
export function FeedView({ db, view, queryVersion, onCreate }: { db: Db; view: DbView; queryVersion: number; onCreate: () => void }) {
  const data = usePagedRecords({ databaseId: db.detail!.database.id, viewId: view.id, queryVersion, pageSize: PAGE, previews: true });
  const openPage = useWorkspace((s) => s.openPage);
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow } | null>(null);
  const byUpdate = view.config.feedOrder === "updated";
  const stamp = (r: RecordRow) => (byUpdate ? r.updatedAt : r.createdAt);
  const props = db.columns.map((c) => c.property).filter((p) => p.type !== "title");
  const days = useMemo(() => groupByDay(data.rows, stamp), [data.rows, byUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = (row: RecordRow): MenuItem[] => recordItems(row, data.reload);

  if (data.done && data.rows.length === 0 && !data.error) {
    return (
      <div className="view-empty">
        <p>Nothing here yet. New records appear in this feed as they are made.</p>
        <button type="button" className="btn" onClick={onCreate}>
          <Icon name="plus" size={14} />
          New record
        </button>
      </div>
    );
  }

  return (
    <div className="feed-wrap">
      {data.error && (
        <p className="error-text" role="alert">
          {data.error}{" "}
          <button type="button" className="link" onClick={data.reload}>
            Try again
          </button>
        </p>
      )}
      <div className="feed" aria-busy={data.loading}>
        {days.map((day) => (
          <section key={day.heading} className="feed-day" aria-label={day.heading}>
            <h3>{day.heading}</h3>
            <ul>
              {day.items.map((row) => {
                const preview = data.previews[row.id];
                const shown = props.filter((p) => !isEmptyValue(row.values[p.id])).slice(0, MAX_PROPS);
                return (
                  <li key={row.id} className="feed-card" onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, row }))}>
                    <div className="feed-meta">
                      <span>{byUpdate ? "Edited" : "Created"} {timeOfDay(stamp(row))}</span>
                      <button type="button" className="icon-btn card-menu" aria-label={`Actions for ${row.title || "Untitled"}`} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, row })}>
                        <Icon name="more" />
                      </button>
                    </div>
                    <button type="button" className="feed-title" onClick={() => void openPage(row.pageId)}>
                      {row.title || <span className="cell-placeholder">Untitled</span>}
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
                    {preview?.text && <p className="feed-text">{preview.text}</p>}
                    {preview?.imageHash && <img className="feed-image" src={thumbUrl(preview.imageHash, 640)} alt={preview.imageName ?? ""} loading="lazy" onError={(e) => (e.currentTarget.hidden = true)} />}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {data.loading && !data.rows.length && <div className="feed-card skeleton" aria-hidden="true" />}
      </div>
      {data.hasMore && (
        <button type="button" className="load-more" disabled={data.loading} onClick={data.loadMore}>
          {data.loading ? "Loading…" : "Show older"}
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.row)} onClose={() => setMenu(null)} />}
    </div>
  );
}
