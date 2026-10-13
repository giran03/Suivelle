/* Mock workspace: "Hollow Orbit", an indie studio making a space-tether game. All invented. */

export interface Store {
  workspaces: any[];
  pages: any[];
  blocks: any[];
  databases: any[];
  properties: any[];
  views: any[];
  records: any[];
  dashboards: Record<string, any>;
}

const WS = "ws_orbit";
const DB = "db_sprint";
const T = (d: number) => new Date(Date.now() + d * 86400000);
const iso = (d: number) => T(d).toISOString().slice(0, 10);
const stamp = (d: number) => T(d).toISOString();

let n = 0;
const page = (id: string, title: string, o: Partial<any> = {}) => ({
  id, workspaceId: WS, parentPageId: null, title, icon: null, cover: null, position: n++, favorite: false, archived: false,
  deletedAt: null, revision: 1, createdAt: stamp(-30), updatedAt: stamp(-1), childCount: 0, kind: "page", ...o,
});

type Run = string | { t: string; b?: boolean; i?: boolean; c?: boolean };
const runs = (r: Run[] | string) =>
  (Array.isArray(r) ? r : [r]).map((x) =>
    typeof x === "string"
      ? { type: "text", text: x }
      : { type: "text", text: x.t, ...(x.b || x.i || x.c ? { marks: [...(x.b ? [{ type: "bold" }] : []), ...(x.i ? [{ type: "italic" }] : []), ...(x.c ? [{ type: "code" }] : [])] } : {}) },
  );

let bn = 0;
const block = (pageId: string, type: string, data: any, parent: string | null = null, id?: string) => ({
  id: id ?? `b_${pageId}_${bn++}`, pageId, parentBlockId: parent, type, position: bn, dataJson: JSON.stringify(data), schemaVersion: 2, revision: 1, createdAt: stamp(-20), updatedAt: stamp(-1),
});
const p = (pg: string, r: Run[] | string) => block(pg, "paragraph", { content: runs(r) });
const h = (pg: string, lvl: 1 | 2 | 3, r: string) => block(pg, `heading_${lvl}`, { content: runs(r) });
const bl = (pg: string, r: Run[] | string, parent: string | null = null) => block(pg, "bullet_list", { content: runs(r) }, parent);
const td = (pg: string, r: string, checked = false) => block(pg, "todo", { content: runs(r), checked });

const opt = (id: string, name: string, color: string, group?: string) => ({ id, name, color, ...(group ? { group } : {}) });

const STATUS = [opt("s_backlog", "Backlog", "gray", "todo"), opt("s_prog", "In progress", "blue", "doing"), opt("s_review", "In review", "violet", "doing"), opt("s_done", "Done", "green", "done")];
const PRIORITY = [opt("pr_high", "High", "red"), opt("pr_med", "Medium", "orange"), opt("pr_low", "Low", "gray")];
const AREA = [
  opt("a_eng", "Engine", "blue"), opt("a_feel", "Feel", "violet"), opt("a_world", "Worldgen", "green"), opt("a_art", "Art", "orange"), opt("a_vfx", "VFX", "red"),
  opt("a_design", "Design", "gray"), opt("a_narr", "Narrative", "violet"), opt("a_audio", "Audio", "blue"), opt("a_ui", "UI", "green"), opt("a_rel", "Release", "orange"),
];

const prop = (id: string, name: string, type: string, position: number, config: any = {}) => ({ id, databaseId: DB, name, type, config, position });

// [title, status, priority, areas, due offset (days), estimate]
const TASKS: [string, string, string, string[], number, number][] = [
  ["Tether physics prototype", "s_prog", "pr_high", ["a_eng"], 2, 8],
  ["Gravity-well camera easing", "s_review", "pr_med", ["a_eng", "a_feel"], 1, 3],
  ["Procedural asteroid belts", "s_prog", "pr_high", ["a_world"], 4, 8],
  ["Signal flare VFX pass", "s_backlog", "pr_low", ["a_art", "a_vfx"], 12, 5],
  ["Docking minigame", "s_backlog", "pr_med", ["a_design"], 9, 5],
  ["Captain's log narration", "s_review", "pr_med", ["a_narr", "a_audio"], 3, 3],
  ["Cockpit HUD readability", "s_prog", "pr_high", ["a_ui"], 5, 5],
  ["Save-slot migration", "s_done", "pr_med", ["a_eng"], -6, 3],
  ["Warp jump soundtrack stems", "s_done", "pr_low", ["a_audio"], -4, 2],
  ["Fuel economy tuning", "s_backlog", "pr_high", ["a_design"], 7, 5],
  ["Controller rumble curves", "s_review", "pr_low", ["a_feel"], 2, 2],
  ["Nebula skybox LODs", "s_backlog", "pr_med", ["a_art", "a_world"], 14, 5],
  ["Colour-blind safe palette", "s_prog", "pr_high", ["a_ui"], 6, 3],
  ["Playtest build 0.7", "s_done", "pr_high", ["a_rel"], -2, 2],
  ["Crash on station undock", "s_done", "pr_high", ["a_eng"], -3, 3],
  ["Tutorial pacing pass", "s_review", "pr_med", ["a_design", "a_narr"], 4, 3],
  ["Store capsule art", "s_backlog", "pr_med", ["a_art", "a_rel"], 16, 5],
  ["Steam Deck verification", "s_backlog", "pr_high", ["a_rel"], 18, 8],
];

const PG = {
  home: "pg_home", sprint: "pg_sprint", pulse: "pg_pulse", wiki: "pg_wiki", tether: "pg_tether", orbit: "pg_orbit", narr: "pg_narr",
  journal: "pg_journal", wk41: "pg_wk41", road: "pg_road",
};

export function seed(): Store {
  const pages = [
    page(PG.home, "Studio Home", { icon: "icon:star", favorite: true, cover: "gradient:dusk", updatedAt: stamp(0) }),
    page(PG.sprint, "Sprint Board", { icon: "icon:table", kind: "database", favorite: true, updatedAt: stamp(0) }),
    page(PG.pulse, "Studio Pulse", { icon: "icon:chart", kind: "dashboard", favorite: true, updatedAt: stamp(-1) }),
    page(PG.wiki, "Game Design Wiki", { icon: "icon:layers", updatedAt: stamp(-2) }),
    page(PG.tether, "Tether physics", { parentPageId: PG.wiki, icon: "icon:link", updatedAt: stamp(-2) }),
    page(PG.orbit, "Orbital traversal", { parentPageId: PG.wiki, icon: "icon:timeline", updatedAt: stamp(-3) }),
    page(PG.narr, "Narrative bible", { parentPageId: PG.wiki, icon: "icon:note", updatedAt: stamp(-4) }),
    page(PG.journal, "Dev journal", { icon: "icon:feed", updatedAt: stamp(-1) }),
    page(PG.wk41, "Week 41: the tether holds", { parentPageId: PG.journal, icon: "icon:bolt", updatedAt: stamp(-1) }),
    page(PG.road, "Roadmap 2027", { icon: "icon:calendar", updatedAt: stamp(-5) }),
  ];

  const properties = [
    prop("p_title", "Task", "title", 0),
    prop("p_status", "Status", "status", 1, { options: STATUS }),
    prop("p_priority", "Priority", "select", 2, { options: PRIORITY }),
    prop("p_area", "Area", "multi_select", 3, { options: AREA }),
    prop("p_due", "Due", "date", 4),
    prop("p_est", "Points", "number", 5),
    prop("p_id", "ID", "unique_id", 6, { prefix: "HO" }),
  ];

  const records = TASKS.map(([title, status, pri, areas, due, est], i) => ({
    id: `rec_${i + 1}`, pageId: `pg_rec_${i + 1}`, databaseId: DB, title, uniqueId: i + 101, createdAt: stamp(-20 + i), updatedAt: stamp(-i % 6),
    values: { p_status: status, p_priority: pri, p_area: areas, p_due: { start: iso(due) }, p_est: est },
  }));
  const recordPages = records.map((r) => page(r.pageId, r.title, { parentPageId: PG.sprint, kind: "record" }));

  const cols = properties.map((x) => ({ propertyId: x.id }));
  const views = [
    { id: "v_board", databaseId: DB, name: "Board", type: "board", config: { columns: cols.map((c) => ({ ...c, hidden: c.propertyId === "p_status" || c.propertyId === "p_est" || c.propertyId === "p_id" })), sorts: [], filter: null, group: { propertyId: "p_status" }, hideEmptyGroups: true } },
    { id: "v_table", databaseId: DB, name: "All tasks", type: "table", config: { columns: [{ propertyId: "p_id", width: 84 }, { propertyId: "p_title", width: 300 }, { propertyId: "p_status", width: 150 }, { propertyId: "p_priority", width: 120 }, { propertyId: "p_area", width: 220 }, { propertyId: "p_due", width: 140 }, { propertyId: "p_est", width: 90 }], sorts: [], filter: null } },
    { id: "v_cal", databaseId: DB, name: "Calendar", type: "calendar", config: { columns: cols, sorts: [], filter: null, datePropertyId: "p_due" } },
    { id: "v_time", databaseId: DB, name: "Timeline", type: "timeline", config: { columns: cols, sorts: [], filter: null, datePropertyId: "p_due", zoom: "month" } },
  ];

  const blocks: any[] = [];
  const H = PG.home;
  blocks.push(
    p(H, [{ t: "Hollow Orbit", b: true }, " is a small studio building a game about swinging between derelict stations on a single glowing tether. This page is the one we open every morning."]),
    block(H, "callout", { tone: "tip", content: runs("Build 0.7 shipped to playtesters on Friday. Feedback is landing in the Sprint Board.") }),
    h(H, 2, "This week"),
    td(H, "Lock the tether physics constants", true),
    td(H, "Review camera easing with the gravity wells", true),
    td(H, "Ship the colour-blind safe palette"),
    td(H, "Record the second captain's log"),
    h(H, 2, "How we work"),
    bl(H, [{ t: "Local first. ", b: true }, "Everything lives in this workspace, on this machine."]),
    bl(H, [{ t: "One board. ", b: true }, "Every task is a record in the Sprint Board."]),
    bl(H, [{ t: "Short notes. ", b: true }, "If it needs more than a page, it is a design problem."]),
    block(H, "quote", { content: runs("Make the rope feel like a promise.") }),
    block(H, "code", { language: "typescript", text: "const tension = clamp(stretch / rest, 0, 1.4);\nrope.stiffness = lerp(0.35, 1.0, easeOutExpo(tension));" }),
    block(H, "divider", {}),
    p(H, "Press Ctrl K to search the workspace and jump anywhere."),
  );
  const TP = PG.tether;
  blocks.push(
    h(TP, 2, "Constraints"),
    p(TP, "The tether is a chain of 24 verlet segments with a distance constraint solved four times per frame."),
    bl(TP, "Rest length scales with the player's reel state"),
    bl(TP, "Stretch past 1.4x snaps the anchor and plays the unhook cue"),
    block(TP, "equation", { latex: "F = k\\,(L - L_0) - c\\,\\dot{L}" }),
  );
  blocks.push(h(PG.wk41, 2, "What changed"), p(PG.wk41, "The tether finally holds under spin. The trick was solving constraints before integrating the rotation."));

  const dashboards = {
    [PG.pulse]: {
      widgets: [
        { id: "w_kpi", type: "chart", x: 0, y: 0, w: 3, h: 2, title: "Open tasks", databaseId: DB, chart: { chartType: "kpi", aggregation: "count", sort: "x" }, filter: { propertyId: "p_status", operator: "is_not", value: "s_done" } },
        { id: "w_pts", type: "chart", x: 3, y: 0, w: 3, h: 2, title: "Points planned", databaseId: DB, chart: { chartType: "kpi", aggregation: "sum", yPropertyId: "p_est", sort: "x" } },
        { id: "w_status", type: "chart", x: 6, y: 0, w: 6, h: 4, title: "Tasks by status", databaseId: DB, chart: { chartType: "bar", xPropertyId: "p_status", aggregation: "count", sort: "x" } },
        { id: "w_prio", type: "chart", x: 0, y: 2, w: 6, h: 4, title: "Priority mix", databaseId: DB, chart: { chartType: "donut", xPropertyId: "p_priority", aggregation: "count", sort: "x" } },
        { id: "w_due", type: "chart", x: 6, y: 4, w: 6, h: 4, title: "Points due by week", databaseId: DB, chart: { chartType: "area", xPropertyId: "p_due", bucket: "week", yPropertyId: "p_est", aggregation: "sum", sort: "x" } },
        { id: "w_text", type: "text", x: 0, y: 6, w: 6, h: 2, title: "Focus", text: "Ship the tether. Everything else is garnish." },
      ],
      filters: [],
    },
  };

  return {
    workspaces: [{ id: WS, name: "Hollow Orbit", icon: "symbol:star", settingsJson: JSON.stringify({ theme: "dark", accent: "blue", description: "Indie studio workspace" }), schemaVersion: 1, revision: 1, createdAt: stamp(-60), updatedAt: stamp(-1) }],
    pages: [...pages, ...recordPages],
    blocks,
    databases: [{ id: DB, pageId: PG.sprint, workspaceId: WS, nextUniqueId: 101 + TASKS.length }],
    properties,
    views,
    records,
    dashboards,
  };
}
