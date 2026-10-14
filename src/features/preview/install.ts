import { pageLinkTarget } from "../../lib/legacy";
import { hidePreview, showPreview } from "./store";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 160;
const TARGET = ".ProseMirror .mention:not(.is-gone)[data-page-id], .ProseMirror a[href]";

function targetOf(el: EventTarget | null): { id: string; el: Element } | null {
  if (!(el instanceof Element)) return null;
  const hit = el.closest(TARGET);
  if (!hit) return null;
  const id = hit.getAttribute("data-page-id") ?? pageLinkTarget(hit.getAttribute("href") ?? "");
  return id ? { id, el: hit } : null;
}

/**
 * Hovering an internal page mention or link opens a preview card after a short pause. One
 * delegated listener serves every editor (main, peek, nested). Mouse only: touch has no hover.
 */
export function installPagePreview(): () => void {
  let openTimer = 0;
  let closeTimer = 0;
  let current: Element | null = null;
  const clear = () => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
  };
  const scheduleClose = () => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      current = null;
      hidePreview();
    }, CLOSE_DELAY_MS);
  };
  const over = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if ((e.target as Element | null)?.closest?.("[data-page-preview]")) {
      window.clearTimeout(closeTimer);
      return;
    }
    const t = targetOf(e.target);
    if (!t) {
      if (current) scheduleClose();
      return;
    }
    if (t.el === current) {
      window.clearTimeout(closeTimer);
      return;
    }
    clear();
    current = t.el;
    openTimer = window.setTimeout(() => showPreview(t.id, t.el.getBoundingClientRect()), OPEN_DELAY_MS);
  };
  const dismiss = () => {
    clear();
    current = null;
    hidePreview();
  };
  const key = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
  document.addEventListener("pointerover", over);
  document.addEventListener("pointerdown", dismiss, true);
  document.addEventListener("keydown", key, true);
  document.addEventListener("scroll", dismiss, true);
  window.addEventListener("blur", dismiss);
  return () => {
    clear();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerdown", dismiss, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("scroll", dismiss, true);
    window.removeEventListener("blur", dismiss);
  };
}
