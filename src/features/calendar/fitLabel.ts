/** Smallest label size before the text is dropped; below it the bar is only a color. */
const SIZES = [13, 12, 11, 10];
const MIN_TEXT_WIDTH = 40;

const clipped = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("*")].filter(
    (n) => n.scrollWidth > n.clientWidth + 1,
  );

/**
 * Makes an event's label fit its bar: shrink first, ellipsize at the smallest size, and hide the
 * text once too little room is left to read. Hidden labels stay available through the tooltip.
 */
export function fitLabel(el: HTMLElement) {
  el.removeAttribute("data-label");
  el.style.removeProperty("font-size");
  if (!clipped(el).length) return;
  for (const size of SIZES) {
    el.style.fontSize = `${size}px`;
    if (!clipped(el).length) return;
  }
  const room = Math.min(...clipped(el).map((n) => n.clientWidth));
  if (room < MIN_TEXT_WIDTH) {
    el.style.removeProperty("font-size");
    el.dataset.label = "hidden";
  }
}

const watchers = new WeakMap<HTMLElement, () => void>();

/** Keeps the label fitted while the bar resizes or its text changes. */
export function watchLabel(el: HTMLElement, title: string) {
  unwatchLabel(el);
  el.title = title;
  let width = -1;
  const run = () => fitLabel(el);
  const resize = new ResizeObserver(([entry]) => {
    const next = Math.round(entry.contentRect.width);
    if (next === width) return;
    width = next;
    run();
  });
  const text = new MutationObserver(run);
  resize.observe(el);
  text.observe(el, { childList: true, subtree: true, characterData: true });
  watchers.set(el, () => {
    resize.disconnect();
    text.disconnect();
  });
  run();
}

export function unwatchLabel(el: HTMLElement) {
  watchers.get(el)?.();
  watchers.delete(el);
}
