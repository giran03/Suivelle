/**
 * Sliding selection (the transitions.dev tabs): segmented controls, the database view tabs and the open-page strip
 * share one highlight that travels to whichever item is selected. Nothing is added to the DOM: this only measures
 * the selected item and writes --pill-x/-y/-w/-h on its container, and motion.css draws the highlight with ::before,
 * so React keeps owning the markup.
 */
const CONTAINERS = ".seg, .view-tabs, .tabbar:not(.tabbar-drop)";
const SELECTED = ':scope > .on, :scope > [aria-selected="true"], :scope > [aria-pressed="true"], :scope > [aria-checked="true"]';
const WATCHED = ["class", "aria-selected", "aria-pressed", "aria-checked", "hidden"];

function place(container: HTMLElement): void {
  const item = container.querySelector<HTMLElement>(SELECTED);
  if (!item || item.offsetWidth === 0) {
    container.removeAttribute("data-pill");
    return;
  }
  const s = container.style;
  s.setProperty("--pill-x", `${item.offsetLeft}px`);
  s.setProperty("--pill-y", `${item.offsetTop}px`);
  s.setProperty("--pill-w", `${item.offsetWidth}px`);
  s.setProperty("--pill-h", `${item.offsetHeight}px`);
  if (container.getAttribute("data-pill") === "on") return;
  // The first position is written without a transition; the next two frames switch the sliding on.
  container.setAttribute("data-pill", "init");
  requestAnimationFrame(() => requestAnimationFrame(() => container.isConnected && container.getAttribute("data-pill") === "init" && container.setAttribute("data-pill", "on")));
}

export function installSlidingPills(): () => void {
  const sized = new ResizeObserver((entries) => {
    for (const e of entries) place(e.target as HTMLElement);
  });
  const seen = new Set<HTMLElement>();
  let frame = 0;

  function sweep(): void {
    frame = 0;
    for (const c of seen) if (!c.isConnected) { sized.unobserve(c); seen.delete(c); }
    document.querySelectorAll<HTMLElement>(CONTAINERS).forEach((c) => {
      if (!seen.has(c)) {
        seen.add(c);
        sized.observe(c);
      }
      place(c);
    });
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sweep);
  };

  const mutations = new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target instanceof Element ? r.target : r.target.parentElement;
      // Only changes in or around a container matter; everything else in the app is none of our business.
      if (t && (t.closest(CONTAINERS) || (r.type === "childList" && [...r.addedNodes].some((n) => n instanceof Element && (n.matches(CONTAINERS) || n.querySelector(CONTAINERS)))))) {
        schedule();
        return;
      }
    }
  });
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: WATCHED });
  window.addEventListener("resize", schedule);
  void document.fonts?.ready.then(schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    sized.disconnect();
    window.removeEventListener("resize", schedule);
    seen.forEach((c) => c.removeAttribute("data-pill"));
  };
}
