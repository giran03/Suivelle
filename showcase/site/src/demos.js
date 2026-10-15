// Small, looping re-enactments of real Suivelle interactions, built from the app's own
// patterns and sample data from the demo workspace. Each runs only while it is on screen,
// and shows its finished state, without movement, when reduced motion is on.

const MARK = `<svg class="mark" viewBox="0 0 96 96" aria-hidden="true"><rect class="mark-tile" x="1" y="1" width="94" height="94" rx="22"/><g transform="translate(48 48) scale(1.08) translate(-55 -47)"><path class="mark-s" d="M66 28H48A12 12 0 0 0 48 52A12 12 0 0 1 48 76H30" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path class="mark-k" d="M70 13C71.6 23.5 74.5 26.4 85 28C74.5 29.6 71.6 32.5 70 43C68.4 32.5 65.5 29.6 55 28C65.5 26.4 68.4 23.5 70 13Z"/></g></svg>`;
const CURSOR = `<div class="cursor"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z" fill="#fff" stroke="#0b1226" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`;
const SEARCH = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M10.5 18a7.5 7.5 0 1 1 5.3-2.2L21 21"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

const frame = (crumbs, body, extra = "") => `<div class="mock" aria-hidden="true"><div class="mock-bar">${MARK}<span class="crumbs">Hollow Orbit / <b>${crumbs}</b></span></div><div class="mock-body">${body}</div>${extra}${CURSOR}</div>`;

const TEMPLATES = {
  palette: () => frame("Studio Home", `<h4 class="ttl">Studio Home</h4><p class="muted">Hollow Orbit is a small studio building a game about swinging between derelict stations.</p><div class="line" style="width:88%"></div><div class="line" style="width:72%"></div><div class="line" style="width:80%"></div><div class="line" style="width:54%"></div><div class="line" style="width:66%"></div>`,
    `<div class="mock-dim"></div><div class="pop palette"><div class="pf">${SEARCH}<span class="q"></span><span class="caret"></span></div><div class="list"></div><div class="foot"><span>↑↓ to move</span><span>Enter to open</span><span>Esc to close</span></div></div>`),
  board: () => frame("Sprint Board", `<div class="board">
      <div class="col" data-col="0"><div class="col-h"><i style="--c:var(--faint)"></i>Backlog<small>2</small></div>
        <div class="card"><b>Captain's log, part two</b><div class="tags"><span class="tag" style="--c:var(--violet)">Narrative</span></div></div>
        <div class="card"><b>Colour-blind palette</b><div class="tags"><span class="tag" style="--c:var(--blue)">Art</span><span class="tag" style="--c:var(--amber)">High</span></div></div></div>
      <div class="col" data-col="1"><div class="col-h"><i style="--c:var(--amber)"></i>In progress<small>2</small></div>
        <div class="card mover"><b>Tether snap VFX</b><div class="tags"><span class="tag" style="--c:var(--blue)">Art</span><span class="tag" style="--c:var(--red)">Urgent</span></div></div>
        <div class="card"><b>Gravity well camera</b><div class="tags"><span class="tag" style="--c:var(--green)">Code</span></div></div></div>
      <div class="col" data-col="2"><div class="col-h"><i style="--c:var(--green)"></i>Done<small>1</small></div>
        <div class="card"><b>Lock tether constants</b><div class="tags"><span class="tag" style="--c:var(--green)">Code</span></div></div></div>
    </div>`),
  paste: () => frame("Dev journal", `<h4>Thursday</h4><div class="para">
      <p>Read the <span class="w1">tether notes</span> before the playtest.</p>
      <p>New accent for the HUD: <span class="w2"></span></p>
      <p>Camera jitter is tracked in <span class="w3"></span></p></div>`,
    `<div class="toast"><span class="msg">Pasted as a link</span><b>Undo</b></div>`),
  calendar: () => {
    const days = ["Mon 12", "Tue 13", "Wed 14", "Thu 15", "Fri 16"];
    const ev = (top, hgt, c, t, s) => `<div class="ev" style="top:${top}px;height:${hgt}px;--c:var(${c})">${t}<small>${s}</small></div>`;
    const events = [[ev(8, 52, "--blue", "Standup", "9:00")], [ev(68, 80, "--violet", "Narrative pass", "10:00")], [], [ev(8, 112, "--green", "Playtest", "9:00")], [ev(128, 52, "--amber", "Review", "11:00")]];
    return frame("Studio Calendar", `<div class="cal-wrap"><div class="week"><div class="hours"><div class="dh"></div><div class="slots"><span style="top:0">9</span><span style="top:60px">10</span><span style="top:120px">11</span><span style="top:180px">12</span></div></div>
      ${days.map((d, i) => `<div class="d${i + 1}"><div class="dh">${d}</div><div class="slots" data-day="${i}">${events[i].join("")}</div></div>`).join("")}</div>
      <div class="drawer"><p>Unscheduled tasks</p><div class="task mover">Tether snap VFX</div><div class="task">Colour-blind palette</div><div class="task">Captain's log, part two</div></div></div>`,
      `<div class="toast"><span>Scheduled 10:00–11:00</span><b>Undo</b></div>`);
  },
  review: () => `<div class="mock" aria-hidden="true"><div class="mock-bar">${MARK}<span class="crumbs">Review inbox</span></div><div class="inbox">
      <div class="inbox-list"><div class="inbox-item active"><b>Update Tether physics</b>Claude Code · 3 changes</div><div class="inbox-item"><b>New memory: build cadence</b>Codex · saved</div><div class="inbox-item"><b>Vault health</b>2 broken links</div></div>
      <div class="inbox-main"><header><span class="agent-dot">CC</span><span><b style="color:var(--text)">Claude Code</b> proposes changes to <b style="color:var(--text)">Tether physics</b></span></header>
        <div class="diff"><div class="del">- Rope stiffness ramps linearly with stretch.</div><div class="add">+ Rope stiffness eases out with stretch (easeOutExpo).</div><div class="add">+ Clamp tension between 0 and 1.4 before the ramp.</div><div class="add">+ See [[Orbital traversal]] for the swing arc.</div></div>
        <div class="inbox-actions"><span class="btn btn-primary approve">Approve all</span><span class="btn btn-secondary">Approve some</span><span class="btn btn-ghost">Reject with note</span></div>
        <span class="approved">${CHECK}Applied. Revert any time from Activity.</span></div></div>${CURSOR}</div>`,
};

const sleep = (ms, run) => new Promise((resolve, reject) => {
  const id = setTimeout(() => (run.alive ? resolve() : reject(new Error("stopped"))), ms);
  run.timers.push(id);
});

function cursorTo(host, el, run, dx = 0.5, dy = 0.5) {
  const c = host.querySelector(".cursor");
  const box = host.querySelector(".mock").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  c.classList.add("on");
  c.style.transform = `translate(${r.left - box.left + r.width * dx}px, ${r.top - box.top + r.height * dy}px)`;
  return sleep(720, run);
}

const SCRIPTS = {
  async palette(host, run, still) {
    const q = host.querySelector(".q"), list = host.querySelector(".list"), pal = host.querySelector(".palette"), dim = host.querySelector(".mock-dim");
    const ttl = host.querySelector(".ttl"), crumb = host.querySelector(".crumbs b");
    const rows = [["Sprint Board", "Database", "SB", "sprint board"], ["Studio Home", "“…landing in the Sprint Board”", "SH", "studio home sprint"], ["Studio Pulse", "Dashboard", "SP", "studio pulse"], ["Create task in project…", "Command", "+", "create task project"]];
    const show = filter => {
      const hits = rows.filter(r => r[3].includes(filter));
      list.innerHTML = `<div class="pop-label">${filter ? "Results" : "Recent"}</div>` + hits.map((r, i) => `<div class="pop-row${i === 0 ? " active" : ""}"><span class="gl">${r[2]}</span>${r[0]}<small>${r[1]}</small></div>`).join("");
    };
    if (still) { dim.classList.add("on"); pal.classList.add("on"); q.textContent = "sprint"; show("sprint"); return; }
    for (;;) {
      ttl.textContent = "Studio Home"; crumb.textContent = "Studio Home"; q.textContent = ""; show("");
      await sleep(900, run);
      dim.classList.add("on"); pal.classList.add("on");
      await sleep(700, run);
      for (const ch of "sprint") { q.textContent += ch; show(q.textContent); await sleep(110, run); }
      await sleep(700, run);
      const items = list.querySelectorAll(".pop-row");
      items[0]?.classList.remove("active"); items[1]?.classList.add("active");
      await sleep(500, run);
      items[1]?.classList.remove("active"); items[0]?.classList.add("active");
      await sleep(600, run);
      pal.classList.remove("on"); dim.classList.remove("on");
      ttl.textContent = "Sprint Board"; crumb.textContent = "Sprint Board";
      await sleep(2400, run);
    }
  },

  async board(host, run, still) {
    const card = host.querySelector(".mover");
    const cols = host.querySelectorAll(".col");
    const counts = () => cols.forEach(c => { c.querySelector("small").textContent = c.querySelectorAll(".card").length; });
    if (still) { cols[2].insertBefore(card, cols[2].children[1]); counts(); return; }
    for (;;) {
      cols[1].insertBefore(card, cols[1].children[1]); counts(); card.style.transform = ""; card.classList.remove("lifted");
      await sleep(900, run);
      await cursorTo(host, card, run, 0.3, 0.4);
      card.classList.add("lifted");
      card.style.transform = "rotate(-1.5deg) scale(1.02)";
      await sleep(300, run);
      // FLIP: measure where the card will sit in Done, then slide it there.
      const first = card.getBoundingClientRect();
      const target = cols[2];
      const ghost = card.cloneNode(true); ghost.style.visibility = "hidden"; ghost.style.transform = "";
      target.insertBefore(ghost, target.children[1]);
      const last = ghost.getBoundingClientRect();
      ghost.remove();
      card.style.transform = `translate(${last.left - first.left}px, ${last.top - first.top}px) rotate(1deg) scale(1.02)`;
      const c = host.querySelector(".cursor");
      const box = host.querySelector(".mock").getBoundingClientRect();
      c.style.transform = `translate(${last.left - box.left + last.width * 0.3}px, ${last.top - box.top + last.height * 0.4}px)`;
      await sleep(760, run);
      card.style.transition = "none";
      card.style.transform = "";
      target.insertBefore(card, target.children[1]);
      card.offsetWidth;
      card.style.transition = "";
      card.classList.remove("lifted");
      counts();
      await sleep(2600, run);
      c.classList.remove("on");
      await sleep(400, run);
    }
  },

  async paste(host, run, still) {
    const w1 = host.querySelector(".w1"), w2 = host.querySelector(".w2"), w3 = host.querySelector(".w3");
    const toast = host.querySelector(".toast"), msg = host.querySelector(".toast .msg");
    const done = () => {
      w1.innerHTML = `<a class="made morph">tether notes</a>`;
      w2.innerHTML = `<span class="swatch morph"><i></i>#7fa4f0</span>`;
      w3.innerHTML = `<span class="badge morph"><i></i>giran03/Suivelle #42</span>`;
    };
    if (still) { done(); return; }
    for (;;) {
      w1.innerHTML = "tether notes"; w2.innerHTML = ""; w3.innerHTML = "";
      await sleep(800, run);
      w1.innerHTML = `<span class="sel">tether notes</span>`;
      await sleep(900, run);
      w1.innerHTML = `<a class="made morph">tether notes</a>`;
      msg.textContent = "Linked the selected words"; toast.classList.add("on");
      await sleep(1400, run); toast.classList.remove("on");
      await sleep(500, run);
      w2.innerHTML = `<span class="muted">#7fa4f0</span>`;
      await sleep(500, run);
      w2.innerHTML = `<span class="swatch morph"><i></i>#7fa4f0</span>`;
      await sleep(1200, run);
      w3.innerHTML = `<span class="muted">https://github.com/giran03/Suivelle/issues/42</span>`;
      await sleep(600, run);
      w3.innerHTML = `<span class="badge morph"><i></i>giran03/Suivelle #42</span>`;
      msg.textContent = "Pasted as a badge"; toast.classList.add("on");
      await sleep(1500, run); toast.classList.remove("on");
      await sleep(2200, run);
    }
  },

  async calendar(host, run, still) {
    const task = host.querySelector(".drawer .mover");
    const slot = host.querySelector('.slots[data-day="2"]');
    const toast = host.querySelector(".toast");
    const place = () => {
      const ev = document.createElement("div");
      ev.className = "ev landing"; ev.style.cssText = "top:68px;height:52px;--c:var(--red)"; ev.innerHTML = "Tether snap VFX<small>10:00 · 1 h</small>";
      slot.append(ev);
    };
    if (still) { task.style.display = "none"; place(); return; }
    for (;;) {
      slot.querySelector(".ev")?.remove();
      task.style.display = ""; task.style.opacity = ""; task.style.transform = ""; task.classList.remove("flying");
      await sleep(900, run);
      await cursorTo(host, task, run, 0.25, 0.5);
      task.classList.add("flying");
      const a = task.getBoundingClientRect(), b = slot.getBoundingClientRect();
      const dx = b.left + 4 - a.left, dy = b.top + 68 - a.top;
      task.style.transform = `translate(${dx}px, ${dy}px)`;
      const c = host.querySelector(".cursor"), box = host.querySelector(".mock").getBoundingClientRect();
      c.style.transform = `translate(${b.left - box.left + 20}px, ${b.top - box.top + 80}px)`;
      await sleep(820, run);
      task.style.display = "none";
      place();
      toast.classList.add("on");
      await sleep(1800, run);
      toast.classList.remove("on");
      host.querySelector(".cursor").classList.remove("on");
      await sleep(1800, run);
    }
  },

  async review(host, run, still) {
    const lines = host.querySelectorAll(".diff div"), btn = host.querySelector(".approve"), ok = host.querySelector(".approved");
    if (still) { lines.forEach(l => l.classList.add("on")); ok.classList.add("on"); return; }
    for (;;) {
      lines.forEach(l => l.classList.remove("on")); ok.classList.remove("on");
      await sleep(700, run);
      for (const l of lines) { l.classList.add("on"); await sleep(380, run); }
      await sleep(500, run);
      await cursorTo(host, btn, run, 0.5, 0.6);
      btn.classList.add("pressed"); await sleep(140, run); btn.classList.remove("pressed");
      ok.classList.add("on");
      await sleep(2600, run);
      host.querySelector(".cursor").classList.remove("on");
      await sleep(500, run);
    }
  },
};

export function startDemos(scope, reduced) {
  const hosts = scope.querySelectorAll("[data-demo]");
  if (!hosts.length) return;
  const runs = new Map();
  const stop = host => { const run = runs.get(host); if (run) { run.alive = false; run.timers.forEach(clearTimeout); runs.delete(host); } };
  const start = host => {
    stop(host);
    const kind = host.dataset.demo;
    host.innerHTML = TEMPLATES[kind]();
    const run = { alive: true, timers: [] };
    runs.set(host, run);
    SCRIPTS[kind](host, run, reduced.matches).catch(() => {});
  };
  for (const host of hosts) host.innerHTML = TEMPLATES[host.dataset.demo]();
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting && e.target.offsetParent !== null) { if (!runs.has(e.target)) start(e.target); }
      else stop(e.target);
    }
  }, { threshold: 0.35 });
  hosts.forEach(h => io.observe(h));
  // Tabbed demos re-enter when their panel becomes visible.
  scope.addEventListener("demo:show", e => { io.unobserve(e.target); start(e.target); io.observe(e.target); });
  scope.addEventListener("demo:hide", e => stop(e.target));
  reduced.addEventListener("change", () => [...runs.keys()].forEach(start));
}
