/* In-memory stand-in for the Rust backend. Enough of the command surface for the showcase flows. */
import { seed, type Store } from "./seed";

const db: Store = seed();
const now = () => new Date().toISOString();
let counter = 1000;
const nid = (p: string) => `${p}_${++counter}`;
const err = (code: string, message: string) => Promise.reject({ code, message });

const live = (p: { deletedAt: string | null }) => !p.deletedAt;
const kids = (parent: string | null) =>
  db.pages.filter((p) => p.parentPageId === parent && live(p) && p.kind !== "record").sort((a, b) => a.position - b.position);
const withCount = (p: any) => ({ ...p, childCount: kids(p.id).length });

function propsOf(dbId: string) {
  return db.properties.filter((p) => p.databaseId === dbId).sort((a, b) => a.position - b.position);
}
function detail(pageId: string) {
  const d = db.databases.find((x) => x.pageId === pageId);
  if (!d) throw { code: "not_found", message: "Database not found." };
  return { database: d, page: withCount(db.pages.find((p) => p.id === pageId)), properties: propsOf(d.id), views: db.views.filter((v) => v.databaseId === d.id) };
}
const optionOrder = (prop: any, id: unknown) => (prop.config.options ?? []).findIndex((o: any) => o.id === id);

function sortRows(rows: any[], dbId: string, sorts: any[]) {
  if (!sorts?.length) return rows;
  const props = propsOf(dbId);
  return [...rows].sort((a, b) => {
    for (const s of sorts) {
      const prop = props.find((p) => p.id === s.propertyId);
      if (!prop) continue;
      const va = prop.type === "title" ? a.title : a.values[prop.id];
      const vb = prop.type === "title" ? b.title : b.values[prop.id];
      const k = (v: any) => (prop.type === "date" ? v?.start ?? "" : prop.type === "select" || prop.type === "status" ? optionOrder(prop, v) : v ?? "");
      const ka = k(va), kb = k(vb);
      const c = ka < kb ? -1 : ka > kb ? 1 : 0;
      if (c) return s.direction === "desc" ? -c : c;
    }
    return 0;
  });
}

function groupKeyOf(prop: any, row: any): string {
  const v = prop.type === "title" ? row.title : row.values[prop.id];
  if (prop.type === "checkbox") return v === true ? "true" : "false";
  if (prop.type === "multi_select") return Array.isArray(v) && v.length ? v[0] : "__empty";
  if (prop.type === "date") return v?.start ? String(v.start).slice(0, 7) : "__empty";
  return v ? String(v) : "__empty";
}

function rowsFor(input: any) {
  const d = db.databases.find((x) => x.id === input.databaseId)!;
  let rows = db.records.filter((r) => r.databaseId === d.id);
  const view = db.views.find((v) => v.id === input.viewId);
  const props = propsOf(d.id);
  if (input.groupKey && view?.config.group) {
    const gp = props.find((p) => p.id === view.config.group!.propertyId)!;
    rows = rows.filter((r) => groupKeyOf(gp, r) === input.groupKey);
  }
  if (input.range) {
    const { propertyId, from, to } = input.range;
    rows = rows.filter((r) => {
      const s = (r.values[propertyId] as any)?.start as string | undefined;
      if (!from && !to) return !s;
      return !!s && (!from || s >= from) && (!to || s <= to);
    });
  }
  return sortRows(rows, d.id, view?.config.sorts ?? []);
}

function recordPageOf(input: any) {
  const rows = rowsFor(input);
  const start = input.cursor ? Number(input.cursor) : 0;
  const limit = input.limit ?? 50;
  const slice = rows.slice(start, start + limit);
  return { rows: slice, total: input.skipTotal ? null : rows.length, nextCursor: start + limit < rows.length ? String(start + limit) : null };
}

function groupCounts(input: any) {
  const view = db.views.find((v) => v.id === input.viewId)!;
  const props = propsOf(view.databaseId);
  const gp = props.find((p) => p.id === view.config.group?.propertyId);
  if (!gp) return [];
  const rows = db.records.filter((r) => r.databaseId === view.databaseId);
  const keys = [...(gp.config.options ?? []).map((o: any) => o.id), "__empty"];
  return keys.map((k) => ({ key: k, count: rows.filter((r) => groupKeyOf(gp, r) === k).length, subgroups: [] }));
}

function isoWeek(day: string) {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function chartData(input: any) {
  const spec = input.chart ?? db.views.find((v) => v.id === input.viewId)?.config.chart;
  const rows = db.records.filter((r) => r.databaseId === input.databaseId);
  const props = propsOf(input.databaseId);
  const xp = props.find((p) => p.id === spec?.xPropertyId);
  const yp = props.find((p) => p.id === spec?.yPropertyId);
  const gp = props.find((p) => p.id === spec?.groupPropertyId);
  const bucketOf = (r: any) => {
    if (!xp) return null;
    const v = xp.type === "title" ? r.title : r.values[xp.id];
    if (xp.type === "date") {
      const s = v?.start as string | undefined;
      if (!s) return "__empty";
      if (spec.bucket === "day") return s.slice(0, 10);
      if (spec.bucket === "week") return isoWeek(s);
      return s.slice(0, 7);
    }
    if (xp.type === "checkbox") return v === true ? "true" : "false";
    if (xp.type === "multi_select") return Array.isArray(v) && v.length ? v[0] : "__empty";
    return v ? String(v) : "__empty";
  };
  const cell = new Map<string, { x: string | null; group: string | null; vals: number[]; count: number }>();
  for (const r of rows) {
    const x = bucketOf(r);
    const g = gp ? groupKeyOf(gp, r) : null;
    const key = `${x}|${g}`;
    const c = cell.get(key) ?? { x, group: g, vals: [] as number[], count: 0 };
    c.count++;
    if (yp) {
      const n = r.values[yp.id];
      if (typeof n === "number") c.vals.push(n);
    }
    cell.set(key, c);
  }
  const points = [...cell.values()].map((c) => {
    const agg = spec?.aggregation ?? "count";
    const sum = c.vals.reduce((a, b) => a + b, 0);
    const value =
      agg === "count" || !yp ? c.count : agg === "sum" ? sum : agg === "average" ? (c.vals.length ? sum / c.vals.length : null) : agg === "min" ? Math.min(...c.vals) : Math.max(...c.vals);
    return { x: c.x, group: c.group, value, count: c.count };
  });
  return { points, truncated: false, records: rows.length };
}

const MARK_A = "";
const MARK_B = "";
function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 100);
  const a = Math.max(0, i - 40), b = Math.min(text.length, i + q.length + 60);
  return (a ? "…" : "") + text.slice(a, i) + MARK_A + text.slice(i, i + q.length) + MARK_B + text.slice(i + q.length, b) + (b < text.length ? "…" : "");
}
const blockText = (b: any) => {
  try {
    const d = JSON.parse(b.dataJson);
    return (d.content ?? []).map((n: any) => n.text ?? "").join("") || d.text || "";
  } catch {
    return "";
  }
};

function search(input: any) {
  const q = (input.query ?? "").trim();
  if (!q) return [];
  const out: any[] = [];
  const parentTitle = (p: any) => db.pages.find((x) => x.id === p.parentPageId)?.title ?? null;
  for (const p of db.pages.filter((x) => live(x) && x.workspaceId === input.workspaceId)) {
    if (p.title.toLowerCase().includes(q.toLowerCase()))
      out.push({ kind: "page", pageId: p.id, blockId: null, pageTitle: p.title, parentTitle: parentTitle(p), snippet: snippet(p.title, q), updatedAt: p.updatedAt });
  }
  if (!input.titlesOnly) {
    for (const b of db.blocks) {
      const t = blockText(b);
      const p = db.pages.find((x) => x.id === b.pageId);
      if (p && live(p) && t.toLowerCase().includes(q.toLowerCase()))
        out.push({ kind: "block", pageId: p.id, blockId: b.id, pageTitle: p.title, parentTitle: parentTitle(p), snippet: snippet(t, q), updatedAt: p.updatedAt });
    }
  }
  return out.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 30));
}

function touchPage(id: string) {
  const p = db.pages.find((x) => x.id === id);
  if (p) {
    p.updatedAt = now();
    p.revision++;
  }
}

const READ_COMMANDS = new Set([
  "workspace_list", "workspace_get", "workspace_stats", "page_list_children", "page_list_favorites",
  "page_list_trash", "page_list_recent", "page_get", "page_ancestors", "page_titles", "page_backlinks",
  "block_list", "history_list", "search_workspace", "database_get", "database_list", "query_records",
  "group_counts", "chart_data", "record_previews", "record_get", "record_lookup", "record_template_list",
  "automation_list", "automation_runs", "dashboard_get", "template_list", "backup_list", "attachment_list",
  "shell_get_behavior", "quick_capture_shortcut", "formula_preview", "export_shape",
]);

/** Only read commands and temporary display preferences cross the showcase boundary. */
export async function handle(cmd: string, a: any): Promise<unknown> {
  if (cmd === "page_touch" || cmd === "history_checkpoint") return null;
  if (cmd === "shell_set_behavior") return structuredClone(a.behavior);
  if (cmd === "workspace_update_settings") {
    const settings = JSON.parse(db.workspaces[0].settingsJson);
    const requested = JSON.parse(a.input.settingsJson);
    if (["light", "dark", "system"].includes(requested.theme)) settings.theme = requested.theme;
    db.workspaces[0].settingsJson = JSON.stringify(settings);
    return structuredClone(db.workspaces[0]);
  }
  if (cmd === "view_update") {
    const input = a.input;
    const view = db.views.find((v) => v.id === input.viewId);
    if (!view) throw { code: "not_found", message: "View not found." };
    if (input.name !== undefined) throw { code: "read_only", message: "This showcase is read-only." };
    const displayKeys = new Set(["columns", "sorts", "filter", "group", "subgroup", "hideEmptyGroups", "datePropertyId", "cardSize", "zoom", "feedOrder"]);
    const config = Object.fromEntries(Object.entries(input.config ?? {}).filter(([key]) => displayKeys.has(key)));
    view.config = { ...view.config, ...structuredClone(config) };
    return structuredClone(view);
  }
  if (!READ_COMMANDS.has(cmd)) throw { code: "read_only", message: "This showcase is read-only. Explore pages, search, and switch views freely." };
  // Read results never expose references that a caller can use to mutate the sample workspace.
  return structuredClone(await dispatch(cmd, a));
}

function dispatch(cmd: string, a: any): unknown {
  switch (cmd) {
    case "workspace_list": return db.workspaces;
    case "workspace_get": return db.workspaces[0];
    case "workspace_stats": return { pages: db.pages.length, records: db.records.length, databases: 1, dashboards: 1, trashed: 0 };
    case "workspace_update_settings": { db.workspaces[0].settingsJson = a.input.settingsJson; return db.workspaces[0]; }
    case "workspace_update": { if (a.name) db.workspaces[0].name = a.name; return db.workspaces[0]; }
    case "page_list_children": return kids(a.parentPageId).map(withCount);
    case "export_shape": {
      // What the export form shows; saving stays blocked like every other write.
      const page = db.pages.find((p) => p.id === a.pageId);
      if (!page) throw { code: "not_found", message: "Page not found." };
      // Records count too: a database exports a page per record.
      const below = (id: string): typeof db.pages =>
        db.pages.filter((p) => p.parentPageId === id && live(p)).flatMap((k) => [k, ...below(k.id)]);
      const all = [page, ...below(page.id)];
      const opts = a.options ?? {};
      const files = opts.format === "pdf" || !opts.includeSubpages ? 1 : all.length;
      return {
        kind: page.kind === "database" ? "database" : page.kind === "record" ? "record" : "page",
        title: page.title,
        needsFolder: files > 1,
        hasChildren: all.length > 1,
        hasDatabases: all.some((p) => p.kind === "database"),
        files,
      };
    }
    case "page_list_favorites": return db.pages.filter((p) => p.favorite && live(p)).map(withCount);
    case "page_list_trash": return db.pages.filter((p) => !live(p)).map(withCount);
    case "page_list_recent":
      return db.pages.filter((p) => live(p) && p.kind !== "record").sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, a.limit ?? 8).map(withCount);
    case "page_get": { const p = db.pages.find((x) => x.id === a.id); if (!p) return err("not_found", "Page not found."); return withCount(p); }
    case "page_ancestors": {
      const out: any[] = [];
      let p = db.pages.find((x) => x.id === a.id);
      while (p) { out.unshift(withCount(p)); const pid: string | null = p.parentPageId; p = db.pages.find((x) => x.id === pid); }
      return out;
    }
    case "page_titles":
      return a.ids.map((id: string) => { const p = db.pages.find((x) => x.id === id); return { id, title: p?.title ?? "", icon: p?.icon ?? null, deleted: !p || !live(p) }; });
    case "page_touch": touchPage(a.id); return null;
    case "page_backlinks": return [];
    case "page_create": {
      const i = a.input;
      const siblings = db.pages.filter((p) => p.parentPageId === (i.parentPageId ?? null));
      const p = { id: nid("pg"), workspaceId: i.workspaceId, parentPageId: i.parentPageId ?? null, title: i.title ?? "", icon: null, cover: null, position: siblings.length, favorite: false, archived: false, deletedAt: null, revision: 1, createdAt: now(), updatedAt: now(), childCount: 0, kind: "page" as const };
      db.pages.push(p);
      return p;
    }
    case "page_update": {
      const i = a.input;
      const p = db.pages.find((x) => x.id === i.id)!;
      for (const k of ["title", "favorite", "icon", "cover"]) if (k in i && i[k] !== undefined) (p as any)[k] = i[k];
      p.updatedAt = now();
      return withCount(p);
    }
    case "page_delete": { db.pages.find((x) => x.id === a.id)!.deletedAt = now(); return null; }
    case "page_restore": { const p = db.pages.find((x) => x.id === a.id)!; p.deletedAt = null; return withCount(p); }
    case "page_move": {
      const i = a.input;
      const p = db.pages.find((x) => x.id === i.id)!;
      p.parentPageId = i.parentPageId;
      const sibs = db.pages.filter((x) => x.parentPageId === i.parentPageId && x.id !== p.id).sort((x, y) => x.position - y.position);
      const at = i.beforePageId ? sibs.findIndex((s) => s.id === i.beforePageId) : sibs.length;
      sibs.splice(at < 0 ? sibs.length : at, 0, p);
      sibs.forEach((s, n) => (s.position = n));
      return withCount(p);
    }
    case "block_list": return db.blocks.filter((b) => b.pageId === a.pageId);
    case "block_apply_batch": {
      const { pageId, upserts, deleteIds } = a.input;
      db.blocks = db.blocks.filter((b) => !(deleteIds as string[]).includes(b.id));
      for (const u of upserts) {
        const ex = db.blocks.find((b) => b.id === u.id);
        if (ex) Object.assign(ex, u, { updatedAt: now() });
        else db.blocks.push({ ...u, pageId, revision: 1, createdAt: now(), updatedAt: now() });
      }
      touchPage(pageId);
      return null;
    }
    case "history_checkpoint": return null;
    case "history_list": return [];
    case "search_workspace": return search(a.input);
    case "search_rebuild": return 0;
    case "database_get": return detail(a.pageId);
    case "database_list": return db.databases.map((d) => ({ id: d.id, pageId: d.pageId, title: db.pages.find((p) => p.id === d.pageId)!.title }));
    case "query_records": return recordPageOf(a.input);
    case "group_counts": return groupCounts(a.input);
    case "chart_data": return chartData(a.input);
    case "record_previews": return [];
    case "record_get": {
      const r = db.records.find((x) => x.pageId === a.pageId || x.id === a.pageId);
      if (!r) return err("not_found", "Record not found.");
      return { record: r, database: detail(db.databases.find((d) => d.id === r.databaseId)!.pageId) };
    }
    case "record_create": {
      const i = a.input;
      const d = db.databases.find((x) => x.id === i.databaseId)!;
      d.nextUniqueId++;
      const pg = { id: nid("pg"), workspaceId: db.workspaces[0].id, parentPageId: d.pageId, title: i.title ?? "", icon: null, cover: null, position: 0, favorite: false, archived: false, deletedAt: null, revision: 1, createdAt: now(), updatedAt: now(), childCount: 0, kind: "record" as const };
      db.pages.push(pg);
      const r = { id: nid("rec"), pageId: pg.id, databaseId: d.id, title: i.title ?? "", uniqueId: d.nextUniqueId - 1, createdAt: now(), updatedAt: now(), values: { ...(i.values ?? {}) } };
      db.records.push(r);
      return r;
    }
    case "record_set_value": {
      const i = a.input;
      const r = db.records.find((x) => x.id === i.recordId)!;
      const prop = db.properties.find((p) => p.id === i.propertyId)!;
      if (prop.type === "title") { r.title = String(i.value ?? ""); db.pages.find((p) => p.id === r.pageId)!.title = r.title; }
      else r.values[i.propertyId] = i.value;
      r.updatedAt = now();
      return r;
    }
    case "record_bulk_set": {
      const i = a.input;
      return i.recordIds.map((id: string) => { const r = db.records.find((x) => x.id === id)!; r.values[i.propertyId] = i.value; return r; });
    }
    case "record_lookup": return [];
    case "record_template_list": return [];
    case "automation_list": return [];
    case "automation_runs": return [];
    case "view_update": {
      const i = a.input;
      const v = db.views.find((x) => x.id === i.viewId)!;
      v.config = { ...v.config, ...i.config };
      if (i.name) v.name = i.name;
      return v;
    }
    case "view_create": {
      const i = a.input;
      const v: any = { id: nid("view"), databaseId: i.databaseId, name: i.name ?? i.type, type: i.type, config: { columns: propsOf(i.databaseId).map((p) => ({ propertyId: p.id })), sorts: [], filter: null } };
      if (i.type === "board") v.config.group = { propertyId: "p_status" };
      if (i.type === "calendar" || i.type === "timeline") v.config.datePropertyId = "p_due";
      db.views.push(v);
      return v;
    }
    case "view_delete": { db.views = db.views.filter((v) => v.id !== a.id); return null; }
    case "property_update": {
      const i = a.input;
      const p = db.properties.find((x) => x.id === i.id)!;
      if (i.name) p.name = i.name;
      if (i.config) p.config = i.config;
      return p;
    }
    case "dashboard_get": return { page: withCount(db.pages.find((x) => x.id === a.pageId)), layout: db.dashboards[a.pageId] };
    case "dashboard_save": { db.dashboards[a.input.pageId] = a.input.layout; return a.input.layout; }
    case "template_list": return [];
    case "backup_list": return [];
    case "attachment_list": return [];
    case "shell_get_behavior": return { tray: false, closeToTray: false, minimizeToTray: false, startWithSystem: false, startMinimized: false };
    case "shell_set_behavior": return a.behavior;
    case "quick_capture_shortcut": return false;
    case "formula_preview": return { resultType: null, error: null, samples: [], properties: [] };
    case "backup_set_auto": return db.workspaces;
    default:
      console.warn("[showcase mock] unhandled command:", cmd, a);
      return null;
  }
}
