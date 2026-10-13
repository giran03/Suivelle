import { useEffect, useMemo, useRef, useState } from "react";
import "./dashboard.css";
import { ContextMenu } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { anchorOf, type Anchor } from "../../components/Popover";
import { useWorkspace } from "../../stores/workspace";
import type { DatabaseDetail, DatabaseRef, SharedFilter, Widget } from "../../types";
import { Chart } from "../charts/Chart";
import { useChartData } from "../charts/ChartView";
import { defaultChartSpec, describeChart } from "../charts/chartModel";
import { DatabaseView } from "../database/DatabaseView";
import { andFilters, ExtraFilterContext, useStable } from "../database/extraFilter";
import { AddWidget, FiltersBar, WidgetSettings } from "./DashboardPanels";
import { boxOf, cellsFor, COLS, place, rowsOf, slotFor, type Rect } from "./layout";
import { filterFor } from "./sharedFilters";
import { useDashboard, useDashboardDatabases } from "./useDashboard";
import { Loading } from "../../components/Loading";

const ROW = 64;
const GAP = 12;
/** Below this width the grid becomes a single column, in reading order. */
const STACK_BELOW = 640;

/** The element's width, tracked from the moment it mounts (the grid only exists once there are widgets). */
function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return void setWidth(0);
    const read = () => setWidth(Math.round(el.clientWidth));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

function Missing({ what }: { what: string }) {
  return <p className="dw-missing">{what} is no longer available. It may have been moved to the trash.</p>;
}

function ChartBody({ widget, detail, shared }: { widget: Widget; detail: DatabaseDetail | undefined; shared: ReturnType<typeof filterFor> }) {
  const spec = widget.chart ?? (detail ? defaultChartSpec(detail.properties) : null);
  const filter = useStable(andFilters(widget.filter, shared));
  const needsAxis = !!spec && spec.chartType !== "kpi" && !spec.xPropertyId;
  const chart = useChartData({ databaseId: widget.databaseId ?? "", chart: spec, filter, enabled: !!detail && !!spec && !needsAxis });
  if (!detail || !spec) return <Missing what="This database" />;
  if (needsAxis) return <p className="chart-empty">Choose a property to chart across in the widget settings.</p>;
  if (chart.error) return <p className="error-text">{chart.error}</p>;
  if (!chart.data) return <p className="chart-empty" aria-busy="true"><Loading /></p>;
  return <Chart spec={spec} props={detail.properties} data={chart.data} compact />;
}

function LinkedBody({ widget, ref: dbRef, detail, shared }: { widget: Widget; ref: DatabaseRef | undefined; detail: DatabaseDetail | undefined; shared: ReturnType<typeof filterFor> }) {
  const value = useStable(shared);
  if (!dbRef || !detail) return <Missing what="This database" />;
  if (!detail.views.some((v) => v.id === widget.viewId)) return <Missing what="This view" />;
  return (
    <ExtraFilterContext.Provider value={value}>
      <DatabaseView pageId={dbRef.pageId} embedded={{ viewId: widget.viewId! }} />
    </ExtraFilterContext.Provider>
  );
}

function titleOf(w: Widget, detail: DatabaseDetail | undefined, ref: DatabaseRef | undefined): string {
  if (w.title?.trim()) return w.title.trim();
  if (w.type === "chart") return detail ? describeChart(w.chart ?? defaultChartSpec(detail.properties), detail.properties) : "Chart";
  if (w.type === "linked_view") {
    const v = detail?.views.find((x) => x.id === w.viewId);
    return `${ref?.title || "Untitled"}${v ? ` · ${v.name}` : ""}`;
  }
  return "";
}

/** A dashboard: a page that is a grid of live widgets, with filters shared by all of them. */
export function DashboardView({ pageId }: { pageId: string }) {
  const { layout, error, update } = useDashboard(pageId);
  const workspace = useWorkspace((s) => s.workspace);
  const openPage = useWorkspace((s) => s.openPage);
  const widgets = layout?.widgets ?? [];
  const { refs, details, fetchDetail } = useDashboardDatabases(workspace?.id, widgets.flatMap((w) => (w.databaseId ? [w.databaseId] : [])));
  const [menu, setMenu] = useState<{ x: number; y: number; widget?: Widget } | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<Anchor | null>(null);
  const [settings, setSettings] = useState<{ id: string; anchor: Anchor } | null>(null);
  const [preview, setPreview] = useState<Widget[] | null>(null);
  const [gridRef, width] = useWidth<HTMLDivElement>();
  const latest = useRef<Widget[] | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; x: number; y: number; origin: Rect; base: Widget[] } | null>(null);

  const shown = preview ?? widgets;
  const stacked = width > 0 && width < STACK_BELOW;
  const usedDatabases = useMemo(() => Object.values(details), [details]);

  if (error) {
    return (
      <div className="dash">
        <p className="error-text" role="alert">
          This dashboard could not be loaded. {error}
        </p>
      </div>
    );
  }
  if (!layout) {
    return (
      <div className="dash" aria-busy="true">
        <p className="empty"><Loading /></p>
      </div>
    );
  }

  const setWidgets = (next: Widget[], immediate = false) => update({ ...layout, widgets: next }, immediate);
  const patch = (id: string, p: Partial<Widget>) => setWidgets(widgets.map((w) => (w.id === id ? { ...w, ...p } : w)));
  const setFilters = (filters: SharedFilter[]) => update({ ...layout, filters }, true);

  const begin = (e: React.PointerEvent<HTMLElement>, w: Widget, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: w.id, mode, x: e.clientX, y: e.clientY, origin: { x: w.x, y: w.y, w: w.w, h: w.h }, base: widgets };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const c = cellsFor(e.clientX - d.x, e.clientY - d.y, width, ROW, GAP);
    const r = d.mode === "move" ? { ...d.origin, x: d.origin.x + c.dx, y: d.origin.y + c.dy } : { ...d.origin, w: Math.min(COLS - d.origin.x, d.origin.w + c.dx), h: d.origin.h + c.dy };
    latest.current = place(d.base, d.id, r);
    setPreview(latest.current);
  };
  const end = () => {
    drag.current = null;
    const done = latest.current;
    latest.current = null;
    if (done) setWidgets(done, true);
    setPreview(null);
  };
  const nudge = (e: React.KeyboardEvent, w: Widget, resize = false) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    const r = e.altKey || resize ? { x: w.x, y: w.y, w: w.w + step[0], h: w.h + step[1] } : { x: w.x + step[0], y: w.y + step[1], w: w.w, h: w.h };
    setWidgets(place(widgets, w.id, r));
  };

  const sharedFor = (w: Widget) => filterFor(layout.filters, details[w.databaseId ?? ""]?.properties ?? []);
  const settingsWidget = settings ? widgets.find((w) => w.id === settings.id) : undefined;
  const ordered = stacked ? [...shown].sort((a, b) => a.y - b.y || a.x - b.x) : shown;

  return (
    <div className="dash" onContextMenu={(e) => {
      if (e.defaultPrevented || !(e.target instanceof Element) || !e.target.matches(".dash, .dash-grid, .view-empty")) return;
      e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY });
    }}>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.widget ? [
        { label: "Widget settings…", onSelect: () => { setEditing(true); setSettings({ id: menu.widget!.id, anchor: { left: menu.x, right: menu.x, top: menu.y, bottom: menu.y } }); } },
        { label: "Duplicate widget", onSelect: () => { const w = menu.widget!; setWidgets([...widgets, { ...w, id: crypto.randomUUID(), ...slotFor(widgets, w.w, w.h) }], true); } },
        { label: "Edit layout", onSelect: () => setEditing(true) },
        { label: "Remove widget…", separated: true, danger: true, onSelect: () => { setEditing(true); setSettings({ id: menu.widget!.id, anchor: { left: menu.x, right: menu.x, top: menu.y, bottom: menu.y } }); } },
      ] : [
        { label: "Add widget…", onSelect: () => { setEditing(true); setAdding({ left: menu.x, right: menu.x, top: menu.y, bottom: menu.y }); } },
        { label: editing ? "Finish editing" : "Edit layout", onSelect: () => setEditing(!editing) },
      ]} onClose={() => setMenu(null)} />}
      <div className="dash-toolbar" role="toolbar" aria-label="Dashboard">
        <FiltersBar filters={layout.filters} databases={usedDatabases} onChange={setFilters} />
        <span className="dash-spacer" />
        {editing && (
          <button type="button" className="btn" aria-haspopup="menu" onClick={(e) => setAdding(anchorOf(e.currentTarget))}>
            <Icon name="plus" size={14} />
            Add widget
          </button>
        )}
        <button type="button" className={`btn${editing ? " primary" : ""}`} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done" : "Edit layout"}
        </button>
      </div>

      {widgets.length === 0 ? (
        <div className="view-empty">
          <p>This dashboard is empty. Add charts, numbers, text or a live view of any database.</p>
          <button type="button" className="btn primary" onClick={(e) => (setEditing(true), setAdding(anchorOf(e.currentTarget)))}>
            <Icon name="plus" size={14} />
            Add a widget
          </button>
        </div>
      ) : (
        <div className={`dash-grid${editing ? " editing" : ""}${stacked ? " stacked" : ""}`} ref={gridRef} style={stacked ? undefined : { height: Math.max(1, rowsOf(shown)) * (ROW + GAP) - GAP }}>
          {width > 0 &&
            ordered.map((w) => {
              const detail = details[w.databaseId ?? ""];
              const ref = refs?.find((r) => r.id === w.databaseId);
              const style = stacked ? { height: w.h * ROW + (w.h - 1) * GAP } : boxOf(w, width, ROW, GAP);
              const title = titleOf(w, detail, ref);
              const lifted = drag.current?.id === w.id;
              return (
                <section key={w.id} onContextMenu={(e) => { if (e.defaultPrevented) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, widget: w }); }} className={`dw dw-${w.type}${lifted ? " lifted" : ""}`} style={style} aria-label={title || "Text"}>
                  {(title || editing) && (
                    <header className="dw-head">
                      {editing && (
                        <button
                          type="button"
                          className="dw-grip"
                          aria-label={`Move ${title || "text widget"}. Arrow keys move it; hold Alt to resize.`}
                          onPointerDown={(e) => begin(e, w, "move")}
                          onPointerMove={move}
                          onPointerUp={end}
                          onPointerCancel={end}
                          onKeyDown={(e) => nudge(e, w)}
                        >
                          <Icon name="grip" size={14} />
                        </button>
                      )}
                      <h3 title={title}>{title}</h3>
                      {w.type === "linked_view" && ref && !editing && (
                        <button type="button" className="icon-btn" aria-label={`Open ${ref.title || "the database"}`} title="Open the database" onClick={() => void openPage(ref.pageId)}>
                          <Icon name="open" size={14} />
                        </button>
                      )}
                      {editing && (
                        <button type="button" className="icon-btn" aria-label={`Settings for ${title || "text widget"}`} onClick={(e) => setSettings({ id: w.id, anchor: anchorOf(e.currentTarget) })}>
                          <Icon name="more" />
                        </button>
                      )}
                    </header>
                  )}
                  <div className="dw-body">
                    {w.type === "text" && <p className="dw-text">{w.text?.trim() || (editing ? <span className="picker-muted">Empty text. Open the settings to write something.</span> : null)}</p>}
                    {w.type === "chart" && <ChartBody widget={w} detail={detail} shared={sharedFor(w)} />}
                    {w.type === "linked_view" && <LinkedBody widget={w} ref={ref} detail={detail} shared={sharedFor(w)} />}
                  </div>
                  {editing && !stacked && (
                    <button
                      type="button"
                      className="dw-resize"
                      aria-label={`Resize ${title || "text widget"}. Hold Alt and use arrow keys.`}
                      onPointerDown={(e) => begin(e, w, "resize")}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={end}
                      onKeyDown={(e) => nudge(e, w, true)}
                    />
                  )}
                </section>
              );
            })}
        </div>
      )}
      {layout.widgets.length > 0 && editing && <p className="picker-muted dash-hint">Drag a widget by its handle, or drag the corner to resize. Everything saves as you go.</p>}

      {adding && <AddWidget anchor={adding} widgets={widgets} refs={refs} fetchDetail={fetchDetail} onAdd={(w) => setWidgets([...widgets, w], true)} onClose={() => setAdding(null)} />}
      {settings && settingsWidget && (
        <WidgetSettings
          anchor={settings.anchor}
          widget={settingsWidget}
          detail={details[settingsWidget.databaseId ?? ""]}
          onChange={(p) => patch(settingsWidget.id, p)}
          onRemove={() => {
            setSettings(null);
            setWidgets(widgets.filter((w) => w.id !== settingsWidget.id), true);
          }}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  );
}

