// Fails when built JavaScript exceeds its size budgets. Run after `vite build`.
// Budgets are minified bytes; lower them as code shrinks so regressions cannot creep back in.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const assets = join(dist, "assets");
const kB = 1000;
/** Everything loaded before the first render: the entry, the modules main.tsx imports right away, and their static imports. */
// Calendar/media commands and shell integration; heavy views and dialogs load on demand.
// Includes the sidebar's Canvases section and the canvas boards store.
const STARTUP_MAX = 540 * kB;
const STARTUP_ROOTS = [/^App-.*\.js$/, /^ErrorBoundary-.*\.js$/];
const BUDGETS = [
  { name: "Editor", match: (file) => /^Editor-.*\.js$/.test(file), max: 720 * kB },
  { name: "find", match: (file) => /^find-.*\.js$/.test(file), max: 320 * kB },
  { name: "EmojiPicker", match: (file) => /^EmojiPicker-.*\.js$/.test(file), max: 250 * kB },
  { name: "CanvasView", match: (file) => /^CanvasView-.*\.js$/.test(file), max: 40 * kB },
  { name: "WorkspaceCanvas", match: (file) => /^WorkspaceCanvas-.*\.js$/.test(file), max: 30 * kB },
  { name: "canvas engine", match: (file) => /^useCanvas-.*\.js$/.test(file), max: 80 * kB },
  { name: "DatabaseView", match: (file) => /^DatabaseView-.*\.js$/.test(file), max: 190 * kB },
  { name: "MapCanvas", match: (file) => /^MapCanvas-.*\.js$/.test(file), max: 600 * kB },
  { name: "NodeMap", match: (file) => /^NodeMap-.*\.js$/.test(file), max: 45 * kB },
];
// Includes the calendar views, recurrence/import support, and date/time pickers.
// Three.js and the map layout worker are lazy-loaded; preserve the startup budget.
const TOTAL_JS_MAX = (2_840 + 750) * kB;

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = html.match(/<script[^>]+src="\/?assets\/([^"]+\.js)"/)?.[1];
if (!entry) throw new Error("Could not find the entry script in dist/index.html.");

const files = readdirSync(assets).filter((file) => file.endsWith(".js"));
const size = (file) => statSync(join(assets, file)).size;
const failures = [];
const report = (name, bytes, max, detail = "") => {
  const line = `${name.padEnd(13)} ${(bytes / kB).toFixed(1).padStart(8)} kB / ${(max / kB).toFixed(0)} kB  ${detail}`;
  console.log(line);
  if (bytes > max) failures.push(line);
};

// Follow static imports (`from"./x.js"`, `import"./x.js"`) from the startup roots.
const startup = new Set();
const queue = [entry, ...files.filter((file) => STARTUP_ROOTS.some((re) => re.test(file)))];
while (queue.length) {
  const file = queue.pop();
  if (startup.has(file) || !files.includes(file)) continue;
  startup.add(file);
  const code = readFileSync(join(assets, file), "utf8");
  for (const [, dep] of code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) queue.push(dep);
}
report("startup", [...startup].reduce((sum, file) => sum + size(file), 0), STARTUP_MAX, `${startup.size} chunks from ${entry}`);

for (const budget of BUDGETS) {
  const matched = files.filter(budget.match);
  if (!matched.length) failures.push(`${budget.name}: no chunk matched; update scripts/bundle-budget.mjs`);
  for (const file of matched) report(budget.name, size(file), budget.max, file);
}
report("all JS", files.reduce((sum, file) => sum + size(file), 0), TOTAL_JS_MAX);

if (failures.length) {
  console.error(`\nBundle budget exceeded:\n${failures.join("\n")}`);
  process.exit(1);
}
