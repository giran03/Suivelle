import { readProfile } from "./motion";

/** How long the close animation runs at full motion; motion.css (--modal-close-dur) plays the same time. */
const CLOSE_MS = 150;

const closing = new WeakMap<HTMLDialogElement, number>();
const watched = new WeakSet<HTMLDialogElement>();

/**
 * Escape closes a dialog natively and at once. Take it over so every dialog leaves the same way as the ones the app
 * closes itself, unless the dialog's own handler (which runs first) already dealt with it.
 */
function onCancel(this: HTMLDialogElement, e: Event): void {
  if (e.target !== this || e.defaultPrevented) return;
  e.preventDefault();
  closeDialog(this);
}

/** Closes a modal dialog after its exit animation, once however many times it is asked. */
export function closeDialog(d: HTMLDialogElement): void {
  if (!d.open || closing.has(d)) return;
  const ms = Math.round(CLOSE_MS * readProfile().time);
  d.classList.add("is-closing");
  closing.set(
    d,
    window.setTimeout(() => {
      closing.delete(d);
      d.classList.remove("is-closing");
      if (d.open) d.close();
    }, ms),
  );
}

/** Opens or closes a dialog to match `open`: the entrance plays from CSS, the exit through closeDialog. */
export function syncDialog(d: HTMLDialogElement, open: boolean): void {
  if (!watched.has(d)) {
    watched.add(d);
    d.addEventListener("cancel", onCancel);
  }
  if (open) {
    // Asked to open again while it was leaving: stay open and take the exit back.
    const timer = closing.get(d);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      closing.delete(d);
      d.classList.remove("is-closing");
    }
    if (!d.open) d.showModal();
  } else if (d.open) {
    closeDialog(d);
  }
}
