// The storyboard. Drives the real Suivelle UI (mock data) and records a screencast to disk.
// usage: node film.mjs [frames-dir]
import { createFilm, sleep } from "./lib.mjs";

const FRAMES = process.argv[2] ?? "G:/_Temp/claude/X---DEV-Vibe-Projects-Takoception/677f9619-abfb-465d-80a9-a9e627562a14/scratchpad/frames";
const TOTAL_MS = 124000; // progress hairline length; set near the real runtime

const film = await createFilm({ frames: FRAMES });
const { page } = film;
const side = (text) => ({ sel: ".sidebar .node .title", text });
const tab = (text) => ({ sel: ".vtab", text });
const radio = (text, nth = 0) => ({ sel: "dialog[open] [role=radio]", text, nth });

/** Zoom z on horizontal focus x, anchored to the bottom edge so the caption chip stays in frame. */
const zoom = (x, z, dur = 1.5, y = 1 - 0.5 / z) => film.cam(x, y, z, dur);
const reset = (dur = 1.4) => film.cam(0.5, 0.5, 1, dur);

async function scene(name, fn) {
  film.mark(name);
  const t = Date.now();
  try { await fn(); } catch (e) { console.log(`!! scene "${name}" failed:`, String(e).slice(0, 300)); await film.shot(`fail-${name}.png`).catch(() => {}); }
  console.log(`${name}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
/** Click the checkbox of the to-do whose text contains `text`. */
async function clickTodo(text) {
  const p = await page.evaluate((t) => {
    const li = [...document.querySelectorAll(".ProseMirror li[data-checked]")].find((e) => e.textContent.includes(t));
    const r = (li.querySelector("label") ?? li).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  await film.clickAt(p.x, p.y, { dur: 800 });
}

await film.warp(980, 520);

// ---------------------------------------------------------------------------------- title
film.mark("title");
await film.start();
const introDone = page.evaluate(() => window.film.intro());
await sleep(120);
await page.evaluate((ms) => window.film.progressStart(ms), TOTAL_MS);
await introDone;
await page.evaluate(async () => {
  const card = document.querySelector(".film-card");
  window.film.enter();
  window.film.cursor(true);
  await window.film.dismiss(card);
});
await sleep(500);

// ---------------------------------------------------------------------------------- home
await scene("home", async () => {
  await film.move(960, 560, 500);
  await film.cap("Checkboxes", "fill first, then the tick is wiped in");
  zoom(0.5, 1.28, 1.6);
  await sleep(900);
  await clickTodo("colour-blind");
  await sleep(1300);
  await clickTodo("second captain");
  await sleep(1200);
  reset(1.3);
  await film.cap("Tooltips", "one bubble that travels between controls");
  await film.goTo({ sel: ".topbar-actions .icon-btn", text: "favorites" }, { dur: 800 });
  await sleep(900);
  await film.goTo({ sel: ".topbar-actions .icon-btn", text: "history" }, { dur: 420 });
  await sleep(900);
  await film.goTo({ sel: ".topbar-actions .icon-btn", text: "trash" }, { dur: 420 });
  await sleep(900);
  await film.capOff();
  await film.move(1100, 600, 500);
  await film.wheel(520, { dur: 1300, steps: 40 });
  await sleep(500);
  await film.wheel(-520, { dur: 900, steps: 30 });
  await sleep(300);
});

// ---------------------------------------------------------------------------------- sidebar
await scene("sidebar", async () => {
  await film.cap("Sidebar", "rows lift on hover; branches open on a one-row grid");
  for (const name of ["Sprint Board", "Studio Pulse", "Roadmap 2027"]) {
    await film.goTo(side(name), { dur: 420, ox: 0.3 });
    await sleep(260);
  }
  const chev = await page.evaluate(() => {
    const n = [...document.querySelectorAll(".sidebar .node")].find((e) => e.textContent.includes("Game Design Wiki"));
    const r = n.querySelector(".chevron").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await film.clickAt(chev.x, chev.y, { dur: 700 });
  await sleep(1200);
  await film.cap("Context menus", "grow out of the point where you clicked");
  await film.rightClick(side("Orbital traversal"), { dur: 700, ox: 0.4 });
  await sleep(1400);
  await film.key("Escape");
  await sleep(500);
  await film.click({ sel: ".ws-row button", text: "Hollow Orbit" }, { dur: 800 });
  await sleep(1300);
  await film.key("Escape");
  await sleep(500);
  await film.cap("Sidebar", "folds away on one curve and the page widens to fill");
  await film.click({ sel: ".topbar .icon-btn", text: "sidebar", attr: true }, { dur: 800 });
  await sleep(1300);
  await film.click({ sel: ".topbar .icon-btn", text: "sidebar", attr: true }, { dur: 500 });
  await sleep(1200);
  await film.capOff();
});

// ---------------------------------------------------------------------------------- board
await scene("board", async () => {
  await film.cap("Pages slide in", "the page you leave and the page you open share one motion");
  await film.click(side("Sprint Board"), { dur: 900 });
  await sleep(1600);
  await film.cap("Cards", "load in as the columns fill");
  await film.move(1050, 640, 700);
  zoom(0.62, 1.16, 1.6);
  await sleep(900);
  await film.cap("Drag", "the card lifts, the column answers");
  await film.drag({ sel: ".card .card-title", text: "Cockpit HUD" }, await film.at(".lane-cols .board-col:nth-child(3)", 0.5, 0.2), { dur: 1100 });
  await sleep(1100);
  await film.drag({ sel: ".card .card-title", text: "Docking minigame" }, await film.at(".lane-cols .board-col:nth-child(2)", 0.5, 0.2), { dur: 1100 });
  await sleep(1000);
  reset(1.3);
  await film.capOff();
});

// ---------------------------------------------------------------------------------- views
await scene("views", async () => {
  await film.cap("Selection", "one underline slides between views");
  await film.click(tab("All tasks"), { dur: 800 });
  await sleep(1200);
  await film.click(tab("Calendar"), { dur: 600 });
  await sleep(1300);
  await film.click(tab("Timeline"), { dur: 600 });
  await sleep(1300);
  await film.click(tab("Board"), { dur: 600 });
  await sleep(900);
  await film.cap("Menus", "grow out of the control that opened them");
  await film.click({ sel: ".db-toolbar button, .toolbar button, button", text: "Sort" }, { dur: 800 });
  await sleep(1300);
  await film.key("Escape");
  await sleep(500);
  await film.click({ sel: ".db-toolbar button, .toolbar button, button", text: "Filter" }, { dur: 600 });
  await sleep(1300);
  await film.key("Escape");
  await sleep(600);
  await film.capOff();
});

// ---------------------------------------------------------------------------------- palette
await scene("palette", async () => {
  await film.move(1000, 520, 500);
  await film.cap("Dialogs", "scale up from 0.96 in 250ms, leave in 150ms");
  zoom(0.5, 1.15, 1.4);
  await sleep(250);
  await film.chord("Control", "k");
  await sleep(900);
  await film.type("tether", { cps: 6.5 });
  await sleep(1100);
  await film.cap("Search", "results as you type, matches lit in the text");
  await film.key("ArrowDown", 450);
  await film.key("ArrowDown", 450);
  await film.key("ArrowUp", 450);
  await film.key("ArrowUp", 450);
  await sleep(200);
  await film.key("Enter");
  reset(1.3);
  await sleep(1700);
  await film.capOff();
});

// ---------------------------------------------------------------------------------- editor
await scene("editor", async () => {
  await film.cap("Blocks", "type a slash and the menu grows from the caret");
  zoom(0.42, 1.3, 1.6);
  await film.click(".ProseMirror ul li:last-child p", { dur: 900 });
  await film.key("End", 100);
  await film.key("Enter", 100);
  await film.key("Enter", 400);
  await film.type("/call", { cps: 5.5 });
  await sleep(1100);
  await film.key("Enter", 300);
  await sleep(500);
  await film.type("Rest length follows the reel state.", { cps: 17 });
  await sleep(700);
  await film.capOff();
  await film.cap("Selection toolbar", "appears where you are working");
  await film.chord("Shift", "Home");
  await sleep(1400);
  await film.key("ArrowRight", 600);
  reset(1.4);
  await film.capOff();
  await sleep(300);
});

// ---------------------------------------------------------------------------------- dashboard
await scene("dashboard", async () => {
  await film.cap("Charts", "draw themselves in, bar by bar");
  await film.click(side("Studio Pulse"), { dur: 900 });
  zoom(0.6, 1.1, 3.2);
  await sleep(2600);
  await film.move(1500, 640, 800);
  await sleep(1400);
  reset(1.2);
  await film.capOff();
});

// ---------------------------------------------------------------------------------- settings
await scene("settings", async () => {
  await film.cap("Everything runs through one dial", "Settings, then Motion", "top");
  await film.click({ sel: ".sidebar button", text: "Settings" }, { dur: 900 });
  film.cam(0.5, 0.45, 1.16, 1.5);
  await sleep(1300);
  await film.capOff();
  await film.cap("Accent", "swap the one star colour, everywhere at once", "top");
  await film.click(radio("Violet"), { dur: 800 });
  await sleep(1100);
  await film.click(radio("Rose"), { dur: 450 });
  await sleep(1000);
  await film.click(radio("Sapphire"), { dur: 450 });
  await sleep(900);
  await film.cap("Theme", "dark and light share one structure", "top");
  await film.click(radio("Light"), { dur: 700 });
  await sleep(1700);
  await film.click(radio("Dark"), { dur: 600 });
  await sleep(1400);
  await film.cap("Motion", "System, Subtle or Reduced: same tokens, three levels", "top");
  const m = await page.evaluate(() => [...document.querySelectorAll("dialog[open] [role=radio]")].filter((e) => ["System", "Subtle", "Reduced"].includes(e.textContent.trim())).map((e) => e.textContent.trim()));
  console.log("motion radios", m);
  await film.click({ sel: "dialog[open] [role=radio]", text: "Subtle" }, { dur: 800 });
  await sleep(900);
  await film.click({ sel: "dialog[open] [role=radio]", text: "Reduced" }, { dur: 450 });
  await sleep(900);
  await film.click({ sel: "dialog[open] [role=radio]", text: "System", nth: 1 }, { dur: 450 });
  await sleep(700);
  await film.capOff();
  reset(1.2);
  await film.key("Escape");
  await sleep(900);
});

// ---------------------------------------------------------------------------------- toast
await scene("toast", async () => {
  await film.cap("New page", "rises into the tree, ready to type");
  await film.click({ sel: ".sidebar button", text: "New" }, { dur: 900 });
  await sleep(700);
  await film.click(".page-title input", { dur: 500 });
  await film.type("Launch checklist", { cps: 11 });
  await sleep(600);
  await film.key("Enter", 600);
  await film.cap("Toasts", "rise 16px with a 2px blur in 350ms, leave faster", "top");
  await film.click({ sel: ".topbar-actions .icon-btn", text: "trash" }, { dur: 900 });
  film.cam(0.6, 0.93, 1.5, 1.3);
  await sleep(2300);
  await film.click({ sel: ".toast button", text: "Undo" }, { dur: 800 });
  await sleep(1300);
  reset(1.3);
  await sleep(900);
  await film.capOff();
});

// ---------------------------------------------------------------------------------- outro
film.mark("outro");
await film.move(1500, 800, 700);
await page.evaluate(() => window.film.cursor(false));
await page.evaluate(() => window.film.outro());
await sleep(300);
const res = await film.stop();
console.log("frames", res.count, "marks", JSON.stringify(film.marks));
await film.close();
