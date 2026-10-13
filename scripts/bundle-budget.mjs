// Fails when built JavaScript chunks exceed their size budgets. Run after `vite build`.
// Budgets are minified bytes; lower them as chunks shrink so regressions cannot creep back in.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const assets = join(dist, "assets");
const kB = 1000;
const BUDGETS = [
  // The startup entry is whatever index.html loads directly.
  { name: "entry", match: (file, entry) => file === entry, max: 540 * kB },
  { name: "Editor", match: (file) => /^Editor-.*\.js$/.test(file), max: 720 * kB },
  { name: "find", match: (file) => /^find-.*\.js$/.test(file), max: 320 * kB },
  { name: "EmojiPicker", match: (file) => /^EmojiPicker-.*\.js$/.test(file), max: 250 * kB },
  { name: "DatabaseView", match: (file) => /^DatabaseView-.*\.js$/.test(file), max: 190 * kB },
];
const TOTAL_JS_MAX = 2_600 * kB;

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = html.match(/<script[^>]+src="\/?assets\/([^"]+\.js)"/)?.[1];
if (!entry) throw new Error("Could not find the entry script in dist/index.html.");

const files = readdirSync(assets).filter((file) => file.endsWith(".js"));
const size = (file) => statSync(join(assets, file)).size;
const failures = [];
for (const budget of BUDGETS) {
  const matched = files.filter((file) => budget.match(file, entry));
  if (!matched.length) {
    failures.push(`${budget.name}: no chunk matched; update scripts/bundle-budget.mjs`);
    continue;
  }
  for (const file of matched) {
    const bytes = size(file);
    const line = `${budget.name.padEnd(13)} ${(bytes / kB).toFixed(1).padStart(8)} kB / ${(budget.max / kB).toFixed(0)} kB  ${file}`;
    console.log(line);
    if (bytes > budget.max) failures.push(line);
  }
}
const total = files.reduce((sum, file) => sum + size(file), 0);
console.log(`${"all JS".padEnd(13)} ${(total / kB).toFixed(1).padStart(8)} kB / ${(TOTAL_JS_MAX / kB).toFixed(0)} kB`);
if (total > TOTAL_JS_MAX) failures.push(`all JS ${(total / kB).toFixed(1)} kB exceeds ${TOTAL_JS_MAX / kB} kB`);

if (failures.length) {
  console.error(`\nBundle budget exceeded:\n${failures.join("\n")}`);
  process.exit(1);
}
