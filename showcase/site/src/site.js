import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "./site.css";
import { startDemos } from "./demos.js";

const root = document.documentElement;
root.classList.add("js");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const base = root.dataset.root || "./";

/* Theme: follows the system until the visitor picks one. */
const themeKey = "suivelle-site-theme";
const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches);
document.querySelector(".theme-btn")?.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  const apply = () => {
    root.dataset.theme = next;
    try { localStorage.setItem(themeKey, next); } catch {}
    window.dispatchEvent(new Event("themechange"));
  };
  if (document.startViewTransition && !reduced.matches) document.startViewTransition(apply);
  else apply();
});

/* Words of the hero headline rise in one after another. */
for (const h of document.querySelectorAll("[data-words]")) {
  let i = 0;
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(part); continue; }
          const span = document.createElement("span");
          span.className = "w";
          span.style.setProperty("--i", i++);
          span.textContent = part;
          frag.append(span);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    }
  };
  walk(h);
}

/* Reveal on scroll. Content is visible without the script; the class only exists with it. */
const revealer = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
const autoReveal = document.querySelectorAll(".doc > figure, .doc > .demo");
autoReveal.forEach(el => el.classList.add("reveal"));
for (const group of document.querySelectorAll("[data-stagger]")) [...group.children].forEach((el, i) => { el.classList.add("reveal"); el.style.setProperty("--delay", `${i * 70}ms`); });
document.querySelectorAll(".reveal").forEach(el => {
  // Anything already on screen at load shows at once, so the first paint never waits.
  if (el.getBoundingClientRect().top < innerHeight * 0.9 && !el.closest("[data-stagger]")) el.classList.add("in");
  else revealer.observe(el);
});

/* Heading anchors and the table of contents with a sliding indicator. */
const doc = document.querySelector(".doc");
const tocList = document.querySelector(".toc ul");
if (doc) {
  const headings = [...doc.querySelectorAll("h2[id]")];
  for (const h of doc.querySelectorAll("h2[id], h3[id]")) {
    const a = document.createElement("a");
    a.className = "anchor";
    a.href = `#${h.id}`;
    a.textContent = "#";
    a.setAttribute("aria-label", `Link to ${h.textContent}`);
    h.append(a);
  }
  if (tocList) {
    if (!headings.length) document.querySelector(".toc").hidden = true;
    for (const h of headings) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${h.id}`;
      a.textContent = h.firstChild.textContent;
      li.append(a);
      tocList.append(li);
    }
    const links = [...tocList.querySelectorAll("a")];
    const progress = document.querySelector(".toc-progress span");
    let ticking = false;
    const update = () => {
      ticking = false;
      let current = 0;
      headings.forEach((h, i) => { if (h.getBoundingClientRect().top < innerHeight * 0.3) current = i; });
      links.forEach((a, i) => a.setAttribute("aria-current", String(i === current)));
      const active = links[current];
      if (active) {
        tocList.style.setProperty("--ind-top", `${active.offsetTop}px`);
        tocList.style.setProperty("--ind-h", `${active.offsetHeight}px`);
      }
      const max = document.documentElement.scrollHeight - innerHeight;
      progress?.style.setProperty("--progress", max > 0 ? Math.min(1, scrollY / max) : 1);
    };
    addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    addEventListener("resize", update);
    update();
  }
}

/* Mobile navigation drawer. */
const sidebar = document.querySelector(".sidebar");
const scrim = document.querySelector(".sidebar-scrim");
const menuBtn = document.querySelector(".menu-btn");
const setMenu = open => {
  sidebar?.classList.toggle("open", open);
  if (scrim) scrim.hidden = !open;
  menuBtn?.setAttribute("aria-expanded", String(open));
  menuBtn?.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
};
menuBtn?.addEventListener("click", () => setMenu(!sidebar.classList.contains("open")));
scrim?.addEventListener("click", () => setMenu(false));
addEventListener("keydown", e => { if (e.key === "Escape" && sidebar?.classList.contains("open")) setMenu(false); });
sidebar?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });

/* Search: a small index built from the wiki at build time. */
const dialog = document.querySelector(".search-dialog");
const input = dialog?.querySelector("input");
const results = dialog?.querySelector(".search-results");
const empty = dialog?.querySelector(".search-empty");
let index = null;
let selected = 0;
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const highlight = (text, terms) => {
  let html = escapeHtml(text);
  for (const t of terms) html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  return html;
};
const snippet = (text, terms) => {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map(t => { const i = lower.indexOf(t); return i < 0 ? Infinity : i; }).filter(Number.isFinite), 0) - 60);
  return (at > 0 ? "…" : "") + text.slice(at, at + 180);
};
async function loadIndex() {
  if (index) return index;
  try { index = await (await fetch(`${base}search-index.json`)).json(); } catch { index = []; }
  return index;
}
function render(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let hits;
  if (!terms.length) hits = (index || []).filter(e => !e.url.includes("#")).map(e => ({ e, score: 0 }));
  else {
    hits = (index || []).map(e => {
      const heading = e.heading.toLowerCase(), page = e.page.toLowerCase(), text = e.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (heading.includes(t)) score += heading.startsWith(t) ? 8 : 5;
        else if (page.includes(t)) score += 3;
        else if (text.includes(t)) score += 1;
        else return null;
      }
      return { e, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
  }
  hits = hits.slice(0, 12);
  selected = 0;
  results.innerHTML = hits.map(({ e }, i) => `<li role="option" aria-selected="${i === 0}"><a href="${base}${e.url}"><small>${escapeHtml(e.page)}</small><b>${highlight(e.heading, terms)}</b>${terms.length ? `<span>${highlight(snippet(e.text, terms), terms)}</span>` : ""}</a></li>`).join("");
  empty.hidden = hits.length > 0;
}
const select = i => {
  const items = [...results.children];
  if (!items.length) return;
  selected = (i + items.length) % items.length;
  items.forEach((li, j) => li.setAttribute("aria-selected", String(j === selected)));
  items[selected].scrollIntoView({ block: "nearest" });
};
async function openSearch() {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  input.value = "";
  await loadIndex();
  render("");
}
function closeSearch() {
  if (!dialog?.open) return;
  if (reduced.matches) return dialog.close();
  dialog.classList.add("closing");
  setTimeout(() => { dialog.classList.remove("closing"); dialog.close(); }, 150);
}
document.querySelectorAll("[data-search-open]").forEach(b => b.addEventListener("click", openSearch));
input?.addEventListener("input", () => render(input.value));
dialog?.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
  else if (e.key === "Enter") { const a = results.children[selected]?.querySelector("a"); if (a) { e.preventDefault(); location.href = a.href; } }
  else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
});
dialog?.addEventListener("click", e => { if (e.target === dialog) closeSearch(); });
results?.addEventListener("click", () => dialog.close());
addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); dialog?.open ? closeSearch() : openSearch(); }
  else if (e.key === "/" && !dialog?.open && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); openSearch(); }
});

/* Home page atlas and the interface demos load only where they appear. */
const atlasEl = document.querySelector("[data-atlas]");
if (atlasEl) import("./atlas.js").then(m => m.startAtlas(atlasEl, base));
startDemos(document, reduced);

/* Demo theatre: tabs with one highlight that slides, auto-advancing until the visitor picks one. */
for (const theatre of document.querySelectorAll(".theatre")) {
  const tabs = [...theatre.querySelectorAll('[role="tab"]')];
  const slider = theatre.querySelector(".slider");
  const DURATION = 11000;
  let current = 0, auto = !reduced.matches, startedAt = performance.now(), inView = false;
  const place = () => {
    const t = tabs[current];
    slider.style.setProperty("--top", `${t.offsetTop}px`);
    slider.style.setProperty("--h", `${t.offsetHeight}px`);
    if (getComputedStyle(theatre.querySelector(".theatre-tabs")).gridTemplateColumns.split(" ").length > 1) {
      slider.style.left = `${t.offsetLeft}px`; slider.style.width = `${t.offsetWidth}px`; slider.style.right = "auto";
    } else { slider.style.left = ""; slider.style.width = ""; slider.style.right = ""; }
  };
  const show = (i, focus = false) => {
    if (i === current && !focus) return;
    const old = document.getElementById(tabs[current].getAttribute("aria-controls"));
    old.hidden = true;
    old.querySelector("[data-demo]")?.dispatchEvent(new Event("demo:hide", { bubbles: true }));
    tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(j === i)); t.tabIndex = j === i ? 0 : -1; t.querySelector(".bar i").style.transform = "scaleX(0)"; });
    current = i;
    const panel = document.getElementById(tabs[i].getAttribute("aria-controls"));
    panel.hidden = false;
    panel.querySelector("[data-demo]")?.dispatchEvent(new Event("demo:show", { bubbles: true }));
    if (focus) tabs[i].focus();
    startedAt = performance.now();
    place();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => { auto = false; t.querySelector(".bar i").style.transform = "scaleX(0)"; show(i); });
    t.addEventListener("keydown", e => {
      const n = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (n) { e.preventDefault(); auto = false; show((current + n + tabs.length) % tabs.length, true); }
      if (e.key === "Home") { e.preventDefault(); auto = false; show(0, true); }
      if (e.key === "End") { e.preventDefault(); auto = false; show(tabs.length - 1, true); }
    });
  });
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; if (inView) startedAt = performance.now(); }, { threshold: 0.3 }).observe(theatre);
  const tick = now => {
    if (auto && inView) {
      const p = Math.min(1, (now - startedAt) / DURATION);
      tabs[current].querySelector(".bar i").style.transform = `scaleX(${p})`;
      if (p >= 1) show((current + 1) % tabs.length);
    }
    if (auto) requestAnimationFrame(tick);
    else tabs.forEach(t => { t.querySelector(".bar i").style.transform = "scaleX(0)"; });
  };
  requestAnimationFrame(tick);
  addEventListener("resize", place);
  document.fonts?.ready.then(place);
  place();
}
