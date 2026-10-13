/* Presentation layer for the film: cursor, click ripples, motion captions, title and end cards.
   It is injected into the page by the recorder and is not part of the product UI. */
const __filmBoot = () => {
  if (window.film) return;
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const css = `
  #film-root { position: fixed; inset: 0; margin: 0; padding: 0; border: 0; width: auto; height: auto; max-width: none; max-height: none; overflow: visible; background: transparent; color: inherit; z-index: 2147483000; pointer-events: none; font-family: "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; }
  #film-cursor { position: absolute; left: 0; top: 0; width: 24px; height: 24px; margin: -3px 0 0 -4px; opacity: 0; transition: opacity 240ms ${EASE}; will-change: transform; filter: drop-shadow(0 2px 3px rgba(2,5,15,.5)); }
  #film-cursor svg { display: block; transform-origin: 4px 3px; transition: transform 140ms ${EASE}; }
  #film-cursor.down svg { transform: scale(.86); }
  .film-ripple { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 1.5px solid var(--accent-ui, #a9c4ff); opacity: .9; animation: film-ripple 620ms ${EASE} forwards; }
  @keyframes film-ripple { to { transform: scale(4.2); opacity: 0; } }
  #film-cap { position: absolute; left: 50%; bottom: 30px; transform: translate(-50%, 16px); opacity: 0; filter: blur(2px); display: grid; gap: 2px; justify-items: center; text-align: center; padding: 10px 20px 11px; border-radius: 10px; background: var(--surface-2, #172243); border: 1px solid var(--border-strong, rgba(169,196,255,.2)); box-shadow: var(--menu-shadow, 0 14px 36px rgba(2,5,15,.55)); color: var(--text-primary, #e8edf8); transition: opacity 250ms ${EASE}, transform 350ms ${EASE}, filter 350ms ${EASE}; }
  #film-cap.top { bottom: auto; top: 76px; transform: translate(-50%, -16px); }
  #film-cap.top.on { transform: translate(-50%, 0); }
  #film-cap.on { opacity: 1; transform: translate(-50%, 0); filter: blur(0); }
  #film-cap.off { transition-duration: 160ms, 250ms, 250ms; }
  #film-cap b { font-size: 1rem; font-weight: 600; letter-spacing: -0.005em; }
  #film-cap span { font-size: 0.8125rem; color: var(--text-muted, #94a0bb); font-variant-numeric: tabular-nums; }
  #film-cap .swap { transition: opacity 160ms ${EASE}, filter 160ms ${EASE}; }
  #film-cap.swapping .swap { opacity: 0; filter: blur(3px); }
  #film-bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; transform-origin: 0 50%; transform: scaleX(0); background: var(--accent-ui, #a9c4ff); opacity: .55; }
  .film-card { position: absolute; inset: 0; background: #0b1226; color: #e8edf8; display: grid; place-items: center; overflow: hidden; opacity: 1; }
  .film-card.dark-fade { transition: opacity 700ms ${EASE}, transform 900ms ${EASE}, filter 700ms ${EASE}; }
  .film-card.gone { opacity: 0; transform: scale(1.045); filter: blur(10px); }
  .film-stack { position: relative; display: grid; justify-items: center; }
  .film-art { position: relative; width: 960px; height: 620px; }
  .film-art > svg:first-child { position: absolute; inset: 0; overflow: visible; }
  .film-art .film-mark { position: absolute; left: 50%; top: 50%; width: 210px; height: 210px; margin: -105px 0 0 -105px; overflow: visible; }
  .film-word { margin-top: 18px; font-family: "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; font-size: 64px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
  .film-tag { margin-top: 12px; font-size: 24px; font-weight: 500; color: #a9c4ff; }
  .film-sub { margin-top: 26px; font-size: 15px; color: #94a0bb; letter-spacing: .005em; }
  .film-hide { opacity: 0; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.append(style);

  const root = document.createElement("div");
  root.id = "film-root";
  root.innerHTML = `
    <div id="film-cursor"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M4.2 2.6 L4.2 18.4 L8.4 14.6 L11.2 21 L14 19.8 L11.2 13.6 L16.8 13.4 Z" fill="#fff" stroke="#0b1226" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
    <div id="film-cap" role="presentation"><b class="swap"></b><span class="swap"></span></div>
    <div id="film-bar"></div>`;
  root.setAttribute("popover", "manual");
  document.documentElement.append(root);
  // Dialogs and menus live in the top layer; keep the cursor and captions above whatever opens.
  const promote = () => { try { root.hidePopover(); root.showPopover(); } catch {} };
  promote();
  let layers = 0;
  new MutationObserver(() => {
    const n = document.querySelectorAll("dialog[open], [popover]:popover-open").length;
    if (n !== layers) { layers = n; if (n > 1) requestAnimationFrame(promote); }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });

  const $ = (s) => root.querySelector(s);
  const cursor = $("#film-cursor");
  const cap = $("#film-cap");
  const bar = $("#film-bar");

  window.addEventListener("pointermove", (e) => {
    cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }, true);
  window.addEventListener("pointerdown", (e) => {
    cursor.classList.add("down");
    const r = document.createElement("div");
    r.className = "film-ripple";
    r.style.left = e.clientX + "px";
    r.style.top = e.clientY + "px";
    root.append(r);
    setTimeout(() => r.remove(), 700);
  }, true);
  window.addEventListener("pointerup", () => cursor.classList.remove("down"), true);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const BRAND_S = "M66 28H48A12 12 0 0 0 48 52A12 12 0 0 1 48 76H30";
  const STAR = "M70 13C71.6 23.5 74.5 26.4 85 28C74.5 29.6 71.6 32.5 70 43C68.4 32.5 65.5 29.6 55 28C65.5 26.4 68.4 23.5 70 13Z";
  const cardHtml = (final) => `
    <div class="film-stack">
      <div class="film-art">
        <svg viewBox="0 0 260 168" fill="none">
          <g class="lines" stroke="rgba(169,196,255,.26)" stroke-width=".7" stroke-linecap="round">
            <path d="M20 118 L62 70 L104 96" pathLength="1"/><path d="M156 92 L196 52 L240 74" pathLength="1"/><path d="M196 52 L214 126" pathLength="1"/>
          </g>
          <g class="dots" fill="#94a0bb">
            <circle cx="20" cy="118" r="2.5"/><circle cx="62" cy="70" r="3"/><circle cx="104" cy="96" r="2"/><circle cx="156" cy="92" r="2"/><circle cx="196" cy="52" r="3.5"/><circle cx="240" cy="74" r="2.5"/><circle cx="214" cy="126" r="2"/>
          </g>
          <circle class="comet" r="1.6" fill="#cfe0ff" cx="0" cy="0" opacity="0"/>
        </svg>
        <svg class="film-mark" viewBox="0 0 96 96">
          <g transform="translate(48 48) scale(1.08) translate(-55 -47)">
            <path class="s" d="${BRAND_S}" pathLength="1" fill="none" stroke="#7fa4f0" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
            <path class="k" d="${STAR}" fill="#cfe0ff" style="transform-box:fill-box;transform-origin:50% 50%"/>
          </g>
        </svg>
      </div>
      <div class="film-word">Suivelle</div>
      <div class="film-tag">A universe for your thoughts.</div>
      <div class="film-sub">${final}</div>
    </div>`;

  const play = (el, kf, opt) => el.animate(kf, { fill: "both", easing: EASE, ...opt });

  async function title(final, { hold = 1800, opaqueAtStart = true } = {}) {
    const card = document.createElement("div");
    card.className = "film-card dark-fade";
    card.innerHTML = cardHtml(final);
    root.prepend(card);
    const q = (s) => card.querySelector(s);
    const lines = [...card.querySelectorAll(".lines path")];
    const dots = [...card.querySelectorAll(".dots circle")];
    const s = q(".s"), k = q(".k"), word = q(".film-word"), tag = q(".film-tag"), sub = q(".film-sub");
    // lines are drawn first, then the stars light in along them
    lines.forEach((p, i) => play(p, [{ strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDasharray: 1, strokeDashoffset: 0 }], { duration: 1100, delay: 250 + i * 260 }));
    dots.forEach((d, i) => play(d, [{ opacity: 0, transform: "scale(0)" }, { opacity: 1, transform: "scale(1)" }], { duration: 520, delay: 350 + i * 130, easing: "cubic-bezier(0.34,1.4,0.64,1)" }).effect.updateTiming({}) );
    dots.forEach((d) => (d.style.transformBox = "fill-box", d.style.transformOrigin = "center"));
    // the mark: the S is drawn, then the star arrives
    play(s, [{ strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDasharray: 1, strokeDashoffset: 0 }], { duration: 950, delay: 700 });
    play(k, [{ opacity: 0, transform: "scale(.2) rotate(-90deg)" }, { opacity: 1, transform: "scale(1) rotate(0deg)" }], { duration: 700, delay: 1450, easing: "cubic-bezier(0.34,1.3,0.64,1)" });
    play(word, [{ opacity: 0, transform: "translateY(14px)", filter: "blur(6px)" }, { opacity: 1, transform: "translateY(0)", filter: "blur(0)" }], { duration: 750, delay: 1500 });
    play(tag, [{ opacity: 0, transform: "translateY(10px)", filter: "blur(4px)" }, { opacity: 1, transform: "translateY(0)", filter: "blur(0)" }], { duration: 700, delay: 1900 });
    play(sub, [{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 2400 });
    // one signal travelling along the first constellation
    const comet = q(".comet");
    comet.animate([{ opacity: 0, offsetDistance: "0%" }, { opacity: 1, offsetDistance: "12%" }, { opacity: 1, offsetDistance: "88%" }, { opacity: 0, offsetDistance: "100%" }], { duration: 1500, delay: 900, easing: "ease-in-out", fill: "both" });
    comet.style.offsetPath = "path('M20 118 L62 70 L104 96 L156 92 L196 52 L240 74')";
    comet.style.offsetRotate = "0deg";
    await wait(2900 + hold);
    return card;
  }

  window.film = {
    cursor(on) { cursor.style.opacity = on ? "1" : "0"; },
    cap(titleText, detail, pos) {
      cap.classList.toggle("top", pos === "top");
      const swap = () => {
        cap.querySelector("b").textContent = titleText;
        cap.querySelector("span").textContent = detail || "";
        cap.querySelector("span").style.display = detail ? "" : "none";
      };
      if (cap.classList.contains("on")) {
        cap.classList.add("swapping");
        setTimeout(() => { swap(); cap.classList.remove("swapping"); }, 170);
      } else {
        swap();
        cap.classList.remove("off");
        void cap.offsetWidth;
        cap.classList.add("on");
      }
    },
    capOff() { cap.classList.add("off"); cap.classList.remove("on"); },
    progress(p) { bar.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`; },
    async intro() {
      await title("Motion showcase", { hold: 1100 });
    },
    async dismiss(card) {
      card.classList.add("gone");
      await wait(900);
      card.remove();
    },
    async outro() {
      const card = document.createElement("div");
      card.className = "film-card";
      card.style.opacity = "0";
      card.innerHTML = cardHtml("Every motion on screen is the shipped app. One dial sets them all.");
      root.insertBefore(card, cursor);
      const q = (s) => card.querySelector(s);
      card.querySelectorAll(".lines path").forEach((p) => (p.style.strokeDasharray = 1, p.style.strokeDashoffset = 0));
      card.querySelectorAll(".lines path").forEach((p) => p.setAttribute("stroke", "rgba(169,196,255,.26)"));
      q(".comet").style.display = "none";
      const a = card.animate([{ opacity: 0, transform: "scale(.985)", filter: "blur(8px)" }, { opacity: 1, transform: "scale(1)", filter: "blur(0)" }], { duration: 900, easing: EASE, fill: "both" });
      await a.finished;
      const word = q(".film-word"), tag = q(".film-tag"), sub = q(".film-sub");
      [word, tag, sub].forEach((el, i) => play(el, [{ opacity: 0, transform: "translateY(10px)", filter: "blur(4px)" }, { opacity: 1, transform: "translateY(0)", filter: "blur(0)" }], { duration: 650, delay: 150 + i * 160 }));
      await wait(4200);
    },
    progressStart(ms) { bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: ms, easing: "linear", fill: "both" }); },
    /** The app arrives: sidebar rows rise in turn, the topbar settles, the page lifts into place. */
    enter() {
      const rise = (els, { y = 8, x = 0, step = 40, delay = 0, dur = 650, blur = 3 } = {}) =>
        els.forEach((el, i) => el.animate([{ opacity: 0, transform: `translate(${x}px, ${y}px)`, filter: `blur(${blur}px)` }, { opacity: 1, transform: "translate(0,0)", filter: "blur(0)" }], { duration: dur, delay: delay + i * step, easing: EASE, fill: "backwards" }));
      const q = (s) => [...document.querySelectorAll(s)];
      rise(q(".sidebar > header, .sidebar .ws-row, .sidebar .side-search"), { x: -10, y: 0, step: 60 });
      rise(q(".sidebar .section-toggle, .sidebar .node"), { x: -10, y: 0, step: 38, delay: 220 });
      rise(q(".sidebar > button, .sidebar .footer-row, .sidebar > div:last-child > *"), { y: 6, x: 0, step: 50, delay: 500 });
      rise(q("main .topbar"), { y: -8, dur: 700, delay: 120 });
      rise(q(".main-scroll > *"), { y: 16, step: 90, delay: 260, dur: 800, blur: 4 });
    },
    wait,
  };
};
if (document.documentElement) __filmBoot(); else document.addEventListener("DOMContentLoaded", __filmBoot, { once: true });
