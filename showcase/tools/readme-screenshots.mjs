// Capture the real app UI with fictional showcase data for the README.
// Build/serve the showcase first, then: node readme-screenshots.mjs [preview-url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "docs/images");
const url = process.argv[2] ?? "http://localhost:1492/";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1.5 },
  args: ["--hide-scrollbars"],
});

async function clickText(page, selector, text) {
  const items = await page.$$(selector);
  for (const item of items) {
    if ((await item.evaluate((element) => element.textContent.trim())) === text) {
      await item.click();
      return;
    }
  }
  throw new Error(`Could not find ${text} in ${selector}`);
}

async function shot(name, theme, pageId, prepare) {
  const page = await browser.newPage();
  try {
    await page.emulateTimezone("Asia/Manila");
    if (name === "calendar") await page.setViewport({ width: 1440, height: 1080, deviceScaleFactor: 1.5 });
    const pageWidth = name === "side-peek" ? "full" : name === "calendar" ? "wide" : "standard";
    await page.evaluateOnNewDocument((theme, pageId, pageWidth) => {
      // Pin the sample date; no personal workspace or profile is loaded.
      const OriginalDate = Date;
      const instant = OriginalDate.parse("2026-10-14T10:00:00+08:00");
      window.Date = class extends OriginalDate {
        constructor(...args) { if (args.length) super(...args); else super(instant); }
        static now() { return instant; }
      };
      localStorage.clear();
      localStorage.setItem("suivelle.preferences", JSON.stringify({ theme, pageWidth }));
      localStorage.setItem("suivelle.layout", JSON.stringify({ recentOpen: false }));
      localStorage.setItem("suivelle.page.ws_orbit", pageId);
      localStorage.setItem("suivelle.expanded.ws_orbit", JSON.stringify(["pg_wiki"]));
    }, theme, pageId, pageWidth);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    await delay(800);
    if (prepare) await prepare(page);
    await delay(800);
    await page.mouse.move(1438, 958);
    await page.screenshot({ path: resolve(output, `readme-${name}-v014.png`) });
    if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
    console.log(`Captured ${name}`);
  } finally { await page.close(); }
}

try {
  await mkdir(output, { recursive: true });
  await shot("workspace-dark", "dark", "pg_home");
  await shot("workspace-light", "light", "pg_home");
  await shot("project-board", "light", "pg_sprint");
  await shot("project-table", "light", "pg_sprint", (page) => clickText(page, ".vtab", "All tasks"));
  await shot("calendar", "dark", "pg_calendar", async (page) => {
    await page.waitForFunction(() => document.body.innerText.includes("Playtest weekend"));
  });
  await shot("dashboard", "light", "pg_pulse");
  await shot("side-peek", "dark", "pg_wk41", async (page) => {
    const items = await page.$$(".sidebar .node .title");
    for (const item of items) {
      if ((await item.evaluate((element) => element.textContent.trim())) === "Tether physics") {
        await item.click({ button: "right" });
        await page.waitForSelector('[role="menuitem"][aria-label="Open beside"]');
        await page.click('[role="menuitem"][aria-label="Open beside"]');
        await page.waitForSelector(".peek-panel");
        return;
      }
    }
    throw new Error("Tether physics is missing from the sidebar");
  });
} finally { await browser.close(); }
