import { useEffect, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { ChartView } from "../charts/ChartView";
import { FormView } from "../forms/FormView";
import { BoardView } from "./BoardView";
import { AutomationsDialog } from "../automation/AutomationsDialog";
import { FeedView } from "./FeedView";
import { NewRecordButton } from "./RecordTemplates";
import { CalendarView } from "./CalendarView";
import { GalleryView } from "./GalleryView";
import { TimelineView } from "./TimelineView";
import { ZOOM, type Zoom } from "./calendar";
import "./database.css";
import { countConditions } from "./filter";
import { Grid } from "./Grid";
import { collapseKey, type HeaderSegment } from "./groups";
import { GroupPanel } from "./GroupPanel";
import { ListView } from "./ListView";
import { isFilterable } from "./model";
import { FilterPanel, PropertiesPanel, SortPanel } from "./Panels";
import { useDatabase } from "./useDatabase";
import { useRecordTable } from "./useRecordTable";
import { VIEW_META, ViewTabs } from "./ViewTabs";
import { Loading } from "../../components/Loading";
import { PopNumber } from "../../components/Feedback";

type PanelName = "filter" | "sort" | "group" | "props";

/**
 * The body of a database page: view tabs, a toolbar, and the active view of its records. A dashboard
 * embeds one saved view on its own (`embedded`), without the tabs and toolbar.
 */
export function DatabaseView({ pageId, embedded }: { pageId: string; embedded?: { viewId: string; /** Keep the filter, sort and new-record toolbar (an inline block in a page). */ tools?: boolean } }) {
  const db = useDatabase(pageId, embedded?.viewId);
  const { detail, view } = db;
  const type = view?.type ?? "table";
  const usesTable = type === "table" || type === "list";
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const table = useRecordTable(detail?.database.id, usesTable ? view : undefined, db.queryVersion, collapsed);
  const [context, setContext] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [panel, setPanel] = useState<{ name: PanelName; anchor: Anchor } | null>(null);
  const [automations, setAutomations] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ row: number; nonce: number } | null>(null);
  const setError = useWorkspace((s) => s.setError);
  const viewId = view?.id;

  // Collapsed groups belong to the view they were collapsed in.
  useEffect(() => {
    setCollapsed(new Set());
    setPanel(null);
  }, [viewId]);

  if (db.error) {
    return (
      <div className="db-wrap">
        <p className="error-text" role="alert">
          This database could not be loaded. {db.error}
        </p>
      </div>
    );
  }
  if (!detail || !view || !db.views) {
    return (
      <div className="db-wrap" aria-busy="true">
        <p className="empty"><Loading /></p>
      </div>
    );
  }

  const cfg = view.config;
  const dateProps = detail.properties.filter((p) => p.type === "date");
  const hasDate = dateProps.some((p) => p.id === cfg.datePropertyId);
  const filters = countConditions(cfg.filter);
  const open = (name: PanelName) => (e: React.MouseEvent<HTMLButtonElement>) => setPanel(panel?.name === name ? null : { name, anchor: anchorOf(e.currentTarget) });
  const toggleGroup = (h: HeaderSegment) => {
    const key = h.level === 0 ? collapseKey(h.key) : collapseKey(h.parentKey ?? "", h.key);
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const create = async (templateId: string | null = null) => {
    try {
      const row = await ipc.recordCreate({ databaseId: detail.database.id, templateId });
      if (type === "table" && !cfg.group) {
        const index = table.rowCount;
        table.addExtra(row);
        setFocusRequest({ row: index, nonce: Date.now() });
      } else if (usesTable) {
        table.addExtra(row);
      } else {
        await useWorkspace.getState().openPage(row.pageId);
      }
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const countLabel = ` ${table.total === 1 ? "record" : "records"}${filters ? " match" : ""}`;

  const sortable = !(type === "chart" || type === "form" || type === "feed");
  const tools = !embedded || !!embedded.tools;

  return (
    <div className={`db-wrap${embedded ? " embedded" : ""}`} onContextMenu={(e) => {
      if (e.defaultPrevented || !(e.target instanceof Element) || !e.target.matches(".db-wrap, .view-empty, .list-view, .gallery-wrap, .gallery, .board-scroll")) return;
      e.preventDefault();
      setContext({ x: e.clientX, y: e.clientY, items: [
        { label: "New record", onSelect: () => void create() },
        ...(tools ? [{ label: "View properties…", onSelect: () => setPanel({ name: "props", anchor: { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY } }) }] : []),
      ] });
    }}>
      {context && <ContextMenu x={context.x} y={context.y} items={context.items} onClose={() => setContext(null)} />}
      {!embedded && (
      <ViewTabs
        views={db.views}
        activeId={view.id}
        onSelect={db.setActiveView}
        onCreate={(t) => void db.createView(t)}
        onRename={(id, name) => void db.renameView(id, name)}
        onDuplicate={(id) => void db.duplicateView(id)}
        onDelete={(id) => void db.deleteView(id)}
      />
      )}
      {tools && (
      <div className="db-toolbar" role="toolbar" aria-label={`${VIEW_META[type].label} options`}>
        {type !== "form" && (
          <button type="button" className={`tbtn${filters ? " on" : ""}`} aria-expanded={panel?.name === "filter"} onClick={open("filter")}>
            <Icon name="filter" size={14} />
            Filter
            {filters > 0 && <span className="tcount">{filters}</span>}
          </button>
        )}
        {sortable && (
          <button type="button" className={`tbtn${cfg.sorts.length ? " on" : ""}`} aria-expanded={panel?.name === "sort"} onClick={open("sort")}>
            <Icon name="arrowUp" size={14} />
            Sort
            {cfg.sorts.length > 0 && <span className="tcount">{cfg.sorts.length}</span>}
          </button>
        )}
        {(type === "table" || type === "list" || type === "board") && (
          <button type="button" className={`tbtn${cfg.group ? " on" : ""}`} aria-expanded={panel?.name === "group"} onClick={open("group")}>
            <Icon name="layers" size={14} />
            Group
            {cfg.group && <span className="tcount">{cfg.subgroup ? 2 : 1}</span>}
          </button>
        )}
        {type !== "chart" && type !== "form" && (
          <button type="button" className="tbtn" aria-expanded={panel?.name === "props"} onClick={open("props")}>
            <Icon name="columns" size={14} />
            Properties
          </button>
        )}
        {!embedded && (
          <button type="button" className="tbtn" onClick={() => setAutomations(true)}>
            <Icon name="bolt" size={14} />
            Automations
          </button>
        )}
        {type === "feed" && (
          <label className="tsel">
            <span className="sr-only">Order</span>
            <select value={cfg.feedOrder ?? "created"} onChange={(e) => db.updateView({ feedOrder: e.target.value as "created" | "updated" }, { rows: true })}>
              <option value="created">Newest created</option>
              <option value="updated">Recently edited</option>
            </select>
          </label>
        )}
        {(type === "calendar" || type === "timeline") && hasDate && dateProps.length > 1 && (
          <label className="tsel">
            <span className="sr-only">Date property</span>
            <select value={cfg.datePropertyId ?? ""} onChange={(e) => db.updateView({ datePropertyId: e.target.value }, { rows: true })}>
              {dateProps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {type === "gallery" && (
          <label className="tsel">
            <span className="sr-only">Card size</span>
            <select value={cfg.cardSize ?? "medium"} onChange={(e) => db.updateView({ cardSize: e.target.value as "small" | "medium" | "large" })}>
              <option value="small">Small cards</option>
              <option value="medium">Medium cards</option>
              <option value="large">Large cards</option>
            </select>
          </label>
        )}
        {type === "timeline" && hasDate && (
          <div className="seg" role="group" aria-label="Zoom">
            {(Object.keys(ZOOM) as Zoom[]).map((z) => (
              <button key={z} type="button" className={`seg-btn${(cfg.zoom ?? "month") === z ? " on" : ""}`} aria-pressed={(cfg.zoom ?? "month") === z} onClick={() => db.updateView({ zoom: z })}>
                {ZOOM[z].label}
              </button>
            ))}
          </div>
        )}
        <span className="db-total" aria-hidden="true">
          {usesTable && table.loaded && (
            <>
              <PopNumber text={table.total.toLocaleString()} />
              {countLabel}
            </>
          )}
        </span>
        {type !== "board" && type !== "form" && type !== "chart" && <NewRecordButton databaseId={detail.database.id} onCreate={(t) => void create(t)} />}
      </div>
      )}

      {usesTable && table.error && (
        <p className="error-text" role="alert">
          {table.error}{" "}
          <button type="button" className="link" onClick={table.reload}>
            Try again
          </button>
        </p>
      )}

      {type === "table" && (
        <Grid
          columns={db.columns}
          view={cfg}
          db={db}
          table={table}
          focusRequest={focusRequest}
          onCreate={() => void create()}
          onAddProperty={(anchor) => setPanel({ name: "props", anchor })}
          onToggleGroup={toggleGroup}
        />
      )}
      {type === "list" && <ListView db={db} view={view} table={table} onToggleGroup={toggleGroup} onCreate={() => void create()} />}
      {type === "board" && <BoardView db={db} view={view} queryVersion={db.queryVersion} />}
      {type === "gallery" && <GalleryView db={db} view={view} queryVersion={db.queryVersion} onCreate={() => void create()} />}
      {type === "feed" && <FeedView db={db} view={view} queryVersion={db.queryVersion} onCreate={() => void create()} />}
      {type === "chart" && <ChartView db={db} view={view} queryVersion={db.queryVersion} bare={!!embedded} />}
      {type === "form" && <FormView db={db} view={view} locked={!!embedded} />}
      {(type === "calendar" || type === "timeline") &&
        (hasDate ? (
          type === "calendar" ? (
            <CalendarView db={db} view={view} queryVersion={db.queryVersion} />
          ) : (
            <TimelineView db={db} view={view} queryVersion={db.queryVersion} />
          )
        ) : (
          <div className="view-empty">
            <p>A {type} needs a date property to place records on.</p>
            {dateProps.length > 0 ? (
              <select aria-label="Date property" value="" onChange={(e) => e.target.value && db.updateView({ datePropertyId: e.target.value }, { rows: true })}>
                <option value="">Choose a date property…</option>
                {dateProps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <button type="button" className="btn" onClick={() => void db.addProperty("Date", "date")}>
                <Icon name="plus" size={14} />
                Add a Date property
              </button>
            )}
          </div>
        ))}

      {!embedded && <AutomationsDialog open={automations} detail={detail} onClose={() => setAutomations(false)} onAddButton={async () => void (await db.addProperty("Button", "button"))} />}
      {panel?.name === "filter" && (
        <FilterPanel
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          props={detail.properties.filter(isFilterable)}
          filter={cfg.filter}
          onChange={(filter) => db.updateView({ filter }, { rows: true, debounce: 250 })}
        />
      )}
      {panel?.name === "sort" && <SortPanel anchor={panel.anchor} onClose={() => setPanel(null)} props={detail.properties} sorts={cfg.sorts} onChange={(sorts) => db.updateView({ sorts }, { rows: true })} />}
      {panel?.name === "group" && (
        <GroupPanel
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          props={detail.properties}
          config={cfg}
          allowSubgroup
          onChange={(patch) => {
            setCollapsed(new Set());
            db.updateView(patch, { rows: true });
          }}
        />
      )}
      {panel?.name === "props" && (
        <PropertiesPanel anchor={panel.anchor} onClose={() => setPanel(null)} columns={db.allColumns} databaseId={detail.database.id} properties={detail.properties} onToggle={(id, hidden) => db.patchColumn(id, { hidden })} onAdd={db.addProperty} />
      )}
    </div>
  );
}
