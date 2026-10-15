import { SECTIONS } from "../nav.mjs";

// The home page atlas: the wiki drawn the way Suivelle's Node Map draws a workspace. Each
// section is a hub spread over a sphere, its pages orbit it, and cross references join pages.
// It turns slowly like the map's auto-orbit, can be dragged, and every star links to its page.

const FAMILIES = ["#7fa4f0", "#a58cf0", "#62b886", "#6fb1e8", "#e0a050", "#cfe0ff", "#ef6e62", "#94a0bb"];
const FAMILIES_LIGHT = ["#2f4a91", "#6a4fc0", "#2f7d52", "#2f6fa8", "#a5651c", "#3b5ba9", "#c4473b", "#59647a"];

function buildGraph() {
  const nodes = [{ id: "home", label: "Suivelle", kind: "root", pos: [0, 0, 0], fam: 5, r: 7 }];
  const edges = [];
  const n = SECTIONS.length;
  const golden = Math.PI * (3 - Math.sqrt(5));
  SECTIONS.forEach((section, s) => {
    const y = 1 - (s / (n - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = s * golden + 0.6;
    const hub = [Math.cos(th) * rad, y * 0.78, Math.sin(th) * rad];
    const hubId = `s${s}`;
    nodes.push({ id: hubId, label: section.title, kind: "section", pos: hub, fam: s, r: 4.2 });
    edges.push({ a: "home", b: hubId, kind: "tree" });
    section.pages.forEach((page, p) => {
      const count = section.pages.length;
      const a = (p / count) * Math.PI * 2 + s;
      const spread = count === 1 ? 0.3 : 0.34;
      // Offset each page around its hub on a small ring tilted by section, so trees read as groups.
      const ox = Math.cos(a) * spread, oy = Math.sin(a) * spread * 0.8, oz = Math.sin(a + s) * spread * 0.6;
      nodes.push({ id: page.slug, label: page.title, blurb: page.blurb, section: section.title, kind: "page", pos: [hub[0] * 1.32 + ox, hub[1] * 1.32 + oy, hub[2] * 1.32 + oz], fam: s, r: 3 });
      edges.push({ a: hubId, b: page.slug, kind: "tree" });
    });
  });
  for (const section of SECTIONS) for (const page of section.pages) for (const target of page.links ?? []) {
    if (!edges.some(e => (e.a === page.slug && e.b === target) || (e.a === target && e.b === page.slug))) edges.push({ a: page.slug, b: target, kind: "link" });
  }
  const byId = new Map(nodes.map(nd => [nd.id, nd]));
  for (const e of edges) { e.na = byId.get(e.a); e.nb = byId.get(e.b); }
  for (const nd of nodes) nd.degree = edges.filter(e => e.na === nd || e.nb === nd).length;
  return { nodes, edges };
}

export function startAtlas(host, base) {
  const canvas = host.querySelector("canvas");
  const card = host.querySelector(".atlas-card");
  const ctx = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const { nodes, edges } = buildGraph();

  let w = 0, h = 0, dpr = 1;
  let yaw = 0.4, pitch = -0.32, spin = 0.0011;
  let dragging = null, hover = null, visible = true, raf = 0;
  const born = performance.now();
  let palette = {};

  const readPalette = () => {
    const cs = getComputedStyle(document.documentElement);
    const light = cs.colorScheme.includes("light") && !cs.colorScheme.includes("dark");
    palette = {
      text: cs.getPropertyValue("--text").trim(),
      dim: cs.getPropertyValue("--dim").trim(),
      faint: cs.getPropertyValue("--faint").trim(),
      canvas: cs.getPropertyValue("--canvas").trim(),
      ink: cs.getPropertyValue("--accent-ink").trim(),
      fam: light ? FAMILIES_LIGHT : FAMILIES,
      light,
    };
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    w = rect.width; h = rect.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    draw(performance.now());
  };

  const project = () => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const scale = Math.min(w, h) * 0.3;
    for (const nd of nodes) {
      const [x, y, z] = nd.pos;
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const f = 3.2 / (3.2 + z2);
      nd.sx = w / 2 + x1 * scale * f;
      nd.sy = h / 2 + y2 * scale * f;
      nd.depth = z2;
      nd.f = f;
    }
  };

  const alphaFor = d => 0.25 + 0.75 * Math.max(0, Math.min(1, (1.4 - d) / 2.4));

  function draw(now) {
    if (!w) return;
    const t = reduced.matches ? 1 : Math.min(1, (now - born) / 1600);
    const ease = 1 - Math.pow(1 - t, 4);
    project();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const focus = hover;
    const lit = new Set();
    if (focus) { lit.add(focus); for (const e of edges) { if (e.na === focus) lit.add(e.nb); if (e.nb === focus) lit.add(e.na); } }

    // Connections draw in from the centre outwards on first paint.
    edges.forEach((e, i) => {
      const local = Math.max(0, Math.min(1, ease * 1.6 - (i / edges.length) * 0.6));
      if (local <= 0) return;
      const on = focus && (e.na === focus || e.nb === focus);
      const depthA = alphaFor((e.na.depth + e.nb.depth) / 2);
      ctx.strokeStyle = on ? palette.ink : e.kind === "link" ? palette.fam[e.nb.fam] : palette.dim;
      ctx.globalAlpha = (focus && !on ? 0.06 : e.kind === "link" ? 0.42 : 0.2) * depthA * (on ? 2.2 : 1);
      ctx.lineWidth = on ? 1.4 : 1;
      if (e.kind === "link") ctx.setLineDash([3, 4]); else ctx.setLineDash([]);
      const x2 = e.na.sx + (e.nb.sx - e.na.sx) * local, y2 = e.na.sy + (e.nb.sy - e.na.sy) * local;
      ctx.beginPath(); ctx.moveTo(e.na.sx, e.na.sy); ctx.lineTo(x2, y2); ctx.stroke();
    });
    ctx.setLineDash([]);

    const order = [...nodes].sort((a, b) => b.depth - a.depth);
    for (const nd of order) {
      const a = alphaFor(nd.depth) * (focus && !lit.has(nd) ? 0.3 : 1);
      const r = nd.r * nd.f * (nd === focus ? 1.5 : 1) * (0.4 + 0.6 * ease);
      const color = nd.kind === "root" ? palette.ink : palette.fam[nd.fam];
      ctx.globalAlpha = a;
      ctx.fillStyle = palette.canvas;
      ctx.beginPath(); ctx.arc(nd.sx, nd.sy, r + 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
      if (nd.kind === "root") {
        // The root is the four-point star from the mark.
        const s = r * 2.2;
        ctx.beginPath();
        ctx.moveTo(nd.sx, nd.sy - s);
        ctx.quadraticCurveTo(nd.sx + s * 0.12, nd.sy - s * 0.12, nd.sx + s, nd.sy);
        ctx.quadraticCurveTo(nd.sx + s * 0.12, nd.sy + s * 0.12, nd.sx, nd.sy + s);
        ctx.quadraticCurveTo(nd.sx - s * 0.12, nd.sy + s * 0.12, nd.sx - s, nd.sy);
        ctx.quadraticCurveTo(nd.sx - s * 0.12, nd.sy - s * 0.12, nd.sx, nd.sy - s);
        ctx.fill();
      } else if (nd.kind === "section") {
        ctx.lineWidth = 1.5; ctx.strokeStyle = color;
        ctx.beginPath(); ctx.arc(nd.sx, nd.sy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(nd.sx, nd.sy, r * 0.42, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(nd.sx, nd.sy, r, 0, Math.PI * 2); ctx.fill();
      }
      nd.drawnR = r;
    }

    // Labels go on last, nearest stars first; one that would overlap a placed label is skipped.
    const placed = [];
    const front = [...nodes].sort((a, b) => (b === focus) - (a === focus) || a.depth - b.depth);
    for (const nd of front) {
      const labelA = Math.max(0, Math.min(1, (0.55 - nd.depth) * 1.4)) * ease;
      if (labelA <= 0.02 && nd !== focus) continue;
      const size = Math.round((nd.kind === "page" ? 12 : 15) * nd.f);
      ctx.font = nd.kind === "page" ? `500 ${size}px "Geist Variable", system-ui, sans-serif` : `italic 500 ${size}px "Newsreader Variable", Georgia, serif`;
      const tw = ctx.measureText(nd.label).width, r = nd.drawnR;
      const flip = nd.sx + r + 7 + tw > w - 4;
      const x = flip ? nd.sx - r - 7 - tw : nd.sx + r + 7;
      const box = [x - 3, nd.sy - size / 2 - 2, x + tw + 3, nd.sy + size / 2 + 2];
      if (nd !== focus && placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      ctx.globalAlpha = (nd === focus ? 1 : labelA * (focus && !lit.has(nd) ? 0.25 : 1)) * (nd.kind === "page" ? 0.85 : 1);
      ctx.fillStyle = nd.kind === "page" ? palette.dim : palette.text;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(nd.label, x, nd.sy + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  const loop = now => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (reduced.matches) { draw(now); return; }
    if (!dragging) yaw += spin;
    draw(now);
    raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  const pick = (x, y) => {
    let best = null, bestD = 22;
    for (const nd of nodes) {
      if (nd.kind === "root") continue;
      const d = Math.hypot(nd.sx - x, nd.sy - y) - nd.depth * 4;
      if (d < bestD) { bestD = d; best = nd; }
    }
    return best;
  };

  const showCard = nd => {
    if (!nd) { card.classList.remove("show"); return; }
    card.innerHTML = nd.kind === "page" ? `<small>${nd.section}</small><b>${nd.label}</b><p>${nd.blurb}</p>` : `<small>Section</small><b>${nd.label}</b><p>${SECTIONS.find(s => s.title === nd.label).pages.map(p => p.title).join(" · ")}</p>`;
    const cw = 260, x = Math.min(w - cw - 4, Math.max(4, nd.sx + 16)), y = Math.min(h - 120, Math.max(4, nd.sy + 14));
    card.style.setProperty("--x", `${x}px`); card.style.setProperty("--y", `${y}px`);
    card.classList.add("show");
  };

  canvas.addEventListener("pointerdown", e => {
    dragging = { x: e.clientX, y: e.clientY, yaw, pitch, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    const rect = canvas.getBoundingClientRect();
    if (dragging) {
      const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { dragging.moved = true; canvas.classList.add("dragging"); }
      yaw = dragging.yaw + dx * 0.006;
      pitch = Math.max(-1.1, Math.min(1.1, dragging.pitch + dy * 0.004));
      if (reduced.matches || !raf) draw(performance.now());
      showCard(null);
      return;
    }
    const nd = pick(e.clientX - rect.left, e.clientY - rect.top);
    if (nd !== hover) {
      hover = nd;
      canvas.classList.toggle("pointing", !!nd && nd.kind === "page");
      showCard(nd);
      if (reduced.matches || !raf) draw(performance.now());
    }
  });
  const end = e => {
    if (!dragging) return;
    const { moved } = dragging;
    dragging = null;
    canvas.classList.remove("dragging");
    if (!moved && e.type === "pointerup") {
      const rect = canvas.getBoundingClientRect();
      const nd = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (nd?.kind === "page") location.href = `${base}wiki/${nd.id}.html`;
      else if (nd?.kind === "section") location.href = `${base}wiki/${SECTIONS.find(s => s.title === nd.label).pages[0].slug}.html`;
    }
    kick();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { if (!dragging) { hover = null; showCard(null); canvas.classList.remove("pointing"); if (!raf) draw(performance.now()); } });

  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) kick(); }).observe(canvas);
  document.addEventListener("visibilitychange", kick);
  new ResizeObserver(resize).observe(canvas);
  const repaint = () => { readPalette(); draw(performance.now()); };
  addEventListener("themechange", repaint);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", repaint);
  reduced.addEventListener("change", kick);
  readPalette();
  document.fonts?.ready.then(() => draw(performance.now()));
  resize();
  kick();
}
