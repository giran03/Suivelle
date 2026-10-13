// Recorder toolkit: drives the real app with a visible cursor and captures a CDP screencast to disk.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export async function createFilm({ frames, url = "http://localhost:1488/", width = 1600, height = 900, dsf = 1.5, layout = { recentOpen: false } } = {}) {
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--hide-scrollbars", `--force-device-scale-factor=${dsf}`, "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--autoplay-policy=no-user-gesture-required"],
    defaultViewport: { width, height },
  });
  const page = await browser.newPage();
  const presenter = fs.readFileSync(path.join(HERE, "presenter.js"), "utf8");
  await page.evaluateOnNewDocument((layoutJson) => {
    try { localStorage.setItem("suivelle.layout", layoutJson); } catch {}
  }, JSON.stringify(layout));
  await page.evaluateOnNewDocument(presenter);
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300)); });
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);

  const cdp = await page.createCDPSession();
  const stamps = [];
  let writing = Promise.resolve();
  let n = 0;
  let recording = false;
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (!recording) return;
    const i = n++;
    stamps.push(f.metadata.timestamp);
    const buf = Buffer.from(f.data, "base64");
    writing = writing.then(() => fs.promises.writeFile(path.join(frames, `f${String(i).padStart(6, "0")}.jpg`), buf));
  });

  const f = {
    page, cdp, browser,
    marks: [],
    camera: [],
    t0: 0,
    now() { return Date.now() / 1000; },
    mark(name) { f.marks.push({ name, t: f.now() }); },
    /** Virtual camera: ease to focus point (x, y as 0..1 of the frame) at zoom z over dur seconds. Applied in assembly. */
    cam(x, y, z, dur = 1.4) { f.camera.push({ t: f.now(), x, y, z, dur }); },
    async start() {
      f.t0 = performance.now();
      recording = true;
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: Math.round(width * dsf), maxHeight: Math.round(height * dsf) });
    },
    async stop() {
      await sleep(250);
      await cdp.send("Page.stopScreencast");
      recording = false;
      await writing;
      fs.writeFileSync(path.join(frames, "stamps.json"), JSON.stringify({ stamps, marks: f.marks, camera: f.camera }));
      const gaps = stamps.slice(1).map((t, i) => (t - stamps[i]) * 1000).sort((a, b) => a - b);
      console.log(`screencast: ${n} frames, ${(n / (stamps.at(-1) - stamps[0])).toFixed(1)} fps avg, p95 gap ${gaps[Math.floor(gaps.length * 0.95)].toFixed(0)}ms, max ${gaps.at(-1).toFixed(0)}ms`);
      return { count: n, stamps };
    },
    async close() { await browser.close(); },

    // ---------------------------------------------------------------- pointer
    pos: { x: 800, y: 460 },
    async warp(x, y) { f.pos = { x, y }; await page.mouse.move(x, y); },
    async move(x, y, dur = 700) {
      const a = { ...f.pos };
      const dx = x - a.x, dy = y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) return;
      // a slight arc so the path feels hand-guided; longer moves arc more
      const nx = -dy / dist, ny = dx / dist;
      const bow = Math.min(40, dist * 0.06) * (dx > 0 ? 1 : -1);
      const start = performance.now();
      for (;;) {
        const t = Math.min(1, (performance.now() - start) / dur);
        const e = easeInOut(t);
        const arc = Math.sin(e * Math.PI) * bow;
        f.pos = { x: a.x + dx * e + nx * arc, y: a.y + dy * e + ny * arc };
        await page.mouse.move(f.pos.x, f.pos.y);
        if (t >= 1) break;
        await sleep(4);
      }
      f.pos = { x, y };
    },
    async box(target) {
      return page.evaluate((t) => {
        let el = null;
        if (typeof t === "string") el = document.querySelector(t);
        else if (t.sel) el = [...document.querySelectorAll(t.sel)].filter((e) => (e.textContent || e.getAttribute("aria-label") || "").trim().toLowerCase().includes(t.text.toLowerCase()) || (t.attr && (e.getAttribute("aria-label") || "").toLowerCase().includes(t.text.toLowerCase())))[t.nth ?? 0];
        if (!el) return null;
        let r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { el.scrollIntoView({ block: "center", inline: "nearest" }); r = el.getBoundingClientRect(); }
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, target);
    },
    async at(target, ox = 0.5, oy = 0.5) {
      const b = await f.box(target);
      if (!b) throw new Error("not found: " + JSON.stringify(target));
      return { x: b.x + b.w * ox, y: b.y + b.h * oy };
    },
    async goTo(target, { dur = 700, ox = 0.5, oy = 0.5 } = {}) { const p = await f.at(target, ox, oy); await f.move(p.x, p.y, dur); return p; },
    async click(target, o = {}) {
      await f.goTo(target, o);
      await sleep(o.hover ?? 140);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(o.after ?? 120);
    },
    async rightClick(target, o = {}) {
      await f.goTo(target, o);
      await sleep(140);
      await page.mouse.down({ button: "right" });
      await sleep(60);
      await page.mouse.up({ button: "right" });
      // headless Chrome does not synthesise contextmenu from a right button press
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        el?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, buttons: 2, view: window }));
      }, f.pos);
      await sleep(o.after ?? 120);
    },
    async clickAt(x, y, o = {}) { await f.move(x, y, o.dur ?? 600); await sleep(140); await page.mouse.down(); await sleep(70); await page.mouse.up(); await sleep(o.after ?? 120); },
    async drag(from, to, { dur = 1000, hold = 160, lift = 220 } = {}) {
      await f.goTo(from, { dur: 650 });
      await sleep(140);
      await page.mouse.down();
      await sleep(lift);
      const p = typeof to.x === "number" ? to : await f.at(to);
      // first nudge past the drag threshold, then glide
      await f.move(f.pos.x + 10, f.pos.y + 10, 120);
      await f.move(p.x, p.y, dur);
      await sleep(hold);
      await page.mouse.up();
      await sleep(160);
    },
    async type(text, { cps = 14, jitter = 0.5 } = {}) {
      for (const ch of text) {
        await page.keyboard.type(ch);
        await sleep((1000 / cps) * (1 - jitter / 2 + Math.random() * jitter));
      }
    },
    async key(k, wait = 120) { await page.keyboard.press(k); await sleep(wait); },
    async chord(...keys) {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
    },
    async wheel(dy, { steps = 24, dur = 700 } = {}) {
      for (let i = 0; i < steps; i++) { await page.mouse.wheel({ deltaY: dy / steps }); await sleep(dur / steps); }
    },
    async eval(fn, ...args) { return page.evaluate(fn, ...args); },
    async cap(title, detail, pos) { await page.evaluate((a, b, c) => window.film.cap(a, b, c), title, detail, pos); },
    async capOff() { await page.evaluate(() => window.film.capOff()); },
    async progress(p) { await page.evaluate((v) => window.film.progress(v), p); },
    async shot(name) { fs.mkdirSync(path.join(HERE, "shots"), { recursive: true }); await page.screenshot({ path: path.join(HERE, "shots", name) }); },
  };
  void easeOut;
  return f;
}
