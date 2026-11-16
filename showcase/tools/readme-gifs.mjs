// Record crisp, lightweight animated GIFs of the current Suivelle UI for the README.
// Serve the showcase on port 1492 first, then: node showcase/tools/readme-gifs.mjs [preview-url]
import puppeteer from "puppeteer-core";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "docs/images");
const tmpBase = resolve(root, ".tmp/gif-frames");
const url = process.argv[2] ?? "http://localhost:1492/";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  args: ["--hide-scrollbars"],
});

async function clickText(page, selector, text) {
  const items = await page.$$(selector);
  for (const item of items) {
    if ((await item.evaluate((el) => el.textContent.trim())) === text) {
      await item.click();
      return;
    }
  }
  throw new Error(`Could not find "${text}" in ${selector}`);
}

async function openApp(theme, pageId, pageWidth = "standard") {
  const page = await browser.newPage();
  await page.emulateTimezone("Asia/Manila");
  await page.evaluateOnNewDocument((theme, pageId, pageWidth) => {
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
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await delay(700);
  await page.mouse.move(1278, 798);
  return page;
}

async function recordClip(name, theme, pageId, pageWidth, fn) {
  const dir = join(tmpBase, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const page = await openApp(theme, pageId, pageWidth);
  let frame = 0;
  let running = true;

  const snap = async () => {
    const idx = String(frame++).padStart(4, "0");
    await page.screenshot({ path: join(dir, `f${idx}.png`) });
  };

  const loop = (async () => {
    while (running) {
      const t0 = Date.now();
      await snap().catch(() => {});
      const wait = Math.max(0, 80 - (Date.now() - t0));
      if (wait > 0) await delay(wait);
    }
  })();

  try {
    await delay(350);
    await fn(page);
    await delay(650);
  } finally {
    running = false;
    await loop;
    await page.close();
  }

  const outGif = join(output, `readme-${name}.gif`);
  const vf = "fps=12,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3";
  const res = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-framerate", "12",
    "-i", join(dir, "f%04d.png"),
    "-vf", vf,
    "-loop", "0",
    outGif,
  ], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
  console.log(`Encoded ${outGif} (${frame} frames)`);
}

try {
  await mkdir(output, { recursive: true });

  // 1. Fuzzy Command Palette (Ctrl+P)
  await recordClip("palette", "dark", "pg_home", "standard", async (page) => {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyP");
    await page.keyboard.up("Control");
    await delay(450);
    await page.keyboard.type("sprint", { delay: 85 });
    await delay(650);
    await page.keyboard.press("Enter");
    await delay(750);
  });

  // 2. Database Views & Table Search
  await recordClip("databases", "light", "pg_sprint", "wide", async (page) => {
    await delay(400);
    await clickText(page, ".vtab", "All tasks");
    await delay(650);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyF");
    await page.keyboard.up("Control");
    await delay(350);
    await page.keyboard.type("tether", { delay: 85 });
    await delay(800);
    await clickText(page, ".vtab", "Timeline");
    await delay(750);
  });

  // 3. Octopolis Split Panes
  await recordClip("split-panes", "dark", "pg_wk41", "full", async (page) => {
    await delay(350);
    const items = await page.$$(".sidebar .node .title");
    for (const item of items) {
      if ((await item.evaluate((el) => el.textContent.trim())) === "Tether physics") {
        await item.click({ button: "right" });
        await page.waitForSelector('[role="menuitem"][aria-label="Open beside"]');
        await delay(350);
        await page.click('[role="menuitem"][aria-label="Open beside"]');
        await delay(900);
        break;
      }
    }
  });

  // 4. 3D / 2D Node Map
  await recordClip("node-map", "dark", "pg_home", "standard", async (page) => {
    await delay(300);
    const btn = await page.$('.sidebar-footer button[aria-label*="Node Map" i], .sidebar-footer button[title*="Node Map" i], button[aria-label*="Node map" i]');
    if (btn) {
      await btn.click();
    } else {
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyP");
      await page.keyboard.up("Control");
      await delay(250);
      await page.keyboard.type("Node Map", { delay: 60 });
      await delay(250);
      await page.keyboard.press("Enter");
    }
    await delay(1100);
    await page.mouse.move(640, 420);
    await page.mouse.down();
    await page.mouse.move(760, 360, { steps: 14 });
    await page.mouse.up();
    await delay(700);
  });

  // 5. 17 Curated Themes in Settings > Appearance
  await recordClip("themes", "dark", "pg_home", "standard", async (page) => {
    await delay(300);
    const settingsBtn = await page.$('.sidebar-footer button[aria-label*="Settings" i], .sidebar-footer button[title*="Settings" i]');
    if (settingsBtn) {
      await settingsBtn.click();
    } else {
      await page.keyboard.down("Control");
      await page.keyboard.press("Comma");
      await page.keyboard.up("Control");
    }
    await delay(500);
    const navItems = await page.$$("dialog[open] button, [role='dialog'] button");
    for (const b of navItems) {
      if ((await b.evaluate((el) => el.textContent.trim())) === "Appearance") {
        await b.click();
        break;
      }
    }
    await delay(500);
    await page.evaluate(() => {
      const card = document.querySelector("dialog[open] .theme-card, [role='dialog'] .theme-card, dialog[open] [data-preset], [role='dialog'] [data-preset], dialog[open] .preset-card, [role='dialog'] .preset-card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    await delay(600);
    const presets = await page.$$("dialog[open] .theme-card, [role='dialog'] .theme-card, dialog[open] [data-preset], [role='dialog'] [data-preset], dialog[open] .preset-card, [role='dialog'] .preset-card");
    if (presets.length >= 6) {
      await presets[0].click();
      await delay(650);
      await presets[4].click();
      await delay(650);
      await presets[3].click();
      await delay(650);
    } else {
      await delay(800);
    }
  });
} finally {
  await browser.close();
  await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
}
