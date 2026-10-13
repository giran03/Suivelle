import { useEffect, type RefObject } from "react";
import { ACTIONS, resolve, effective, matches, type Scope } from "./bindings";
import { installShortcutSync, useShortcuts } from "./store";
export type Handlers = Record<string, (target: Element, event: KeyboardEvent | MouseEvent) => boolean | void>;
const scopes = new WeakMap<Element, { scope: Scope; handlers: Handlers }>();
export function registerScope(element: Element, scope: Scope, handlers: Handlers) {
  scopes.set(element, { scope, handlers });
  return () => { scopes.delete(element); };
}
export function useShortcutScope(ref: RefObject<HTMLElement | null>, scope: Scope, handlers: Handlers) {
  useEffect(() => { if (ref.current) return registerScope(ref.current, scope, handlers); });
}
export function inputAction(e: KeyboardEvent | MouseEvent, scope: Scope) { return resolve(e, scope, useShortcuts.getState().overrides)?.id; }
export function defaultManaged(e: KeyboardEvent, scope: Scope) {
  const { overrides } = useShortcuts.getState();
  if (e.repeat) return ACTIONS.some(a => a.scope === scope && !a.repeat && [...a.defaults, ...effective(a.id, overrides)].some(b => matches(b, e)));
  return Object.keys(overrides).some(id => effective(id, {}).some(b => matches(b, e)) && !effective(id, overrides).some(b => matches(b, e)) && resolve(e, scope, {})?.id === id);
}

/** One router owns gesture consumption. Feature scopes supply target-aware actions. */
export function installInputRouter(workspace: Handlers, enabled: () => boolean) {
  let consumed: { button: number; target: Element; until: number } | null = null;
  const route = (event: KeyboardEvent | MouseEvent) => {
    if (useShortcuts.getState().recording || !enabled() || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('[role="menu"]')) return; // Context menus execute shortcuts against their captured item.
    const keyEvent = "key" in event;
    const modal = target.closest("dialog[open], [data-popover]");
    const openModal = document.querySelector("dialog[open], [data-popover]");
    if (openModal && !modal) return;
    let handled = false;
    let scopeFound: Scope | undefined;
    for (let el: Element | null = target; el; el = el.parentElement) {
      const local = scopes.get(el); if (!local) continue;
      scopeFound = local.scope;
      const id = inputAction(event, local.scope);
      if (id && local.handlers[id]) {
        handled = local.handlers[id](target, event) !== false || local.scope === "editor";
        if (handled) break;
      }
      // Inputs inside the editor/grid keep their text-entry behavior.
      if (keyEvent && target.closest("input, textarea") && local.scope !== "capture") return;
      break;
    }
    if (!handled && ((!modal && !openModal) || (keyEvent && inputAction(event, "workspace") === "search" && modal?.classList.contains("palette") && !modal.classList.contains("settings")))) {
      const id = inputAction(event, "workspace");
      const typing = target.closest("input, textarea, [contenteditable='true']");
      const bareKey = keyEvent && !(event.ctrlKey || event.metaKey || event.altKey);
      if (id && workspace[id] && !(typing && bareKey)) handled = workspace[id](target, event) !== false;
    }
    // Prevent old editor extension bindings after a user removes or changes them.
    if (!handled && keyEvent && scopeFound === "editor" && defaultManaged(event as KeyboardEvent, "editor")) handled = true;
    if (!handled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!keyEvent) consumed = { button: (event as MouseEvent).button, target, until: Date.now() + 1500 };
  };
  const followup = (event: MouseEvent) => {
    if (!consumed || consumed.until < Date.now() || event.button !== consumed.button) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target === consumed.target || target.contains(consumed.target) || consumed.target.contains(target))) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "click" || event.type === "auxclick") consumed = null;
    }
  };
  const clear = () => { consumed = null; };
  window.addEventListener("keydown", route, true);
  const down = "PointerEvent" in window ? "pointerdown" : "mousedown";
  window.addEventListener(down, route, true);
  for (const name of ["mousedown", "click", "auxclick", "contextmenu"] as const) window.addEventListener(name, followup, true);
  window.addEventListener("blur", clear); window.addEventListener("pointercancel", clear); document.addEventListener("visibilitychange", clear);
  const stopSync = installShortcutSync();
  return () => {
    window.removeEventListener("keydown", route, true); window.removeEventListener(down, route, true);
    for (const name of ["mousedown", "click", "auxclick", "contextmenu"] as const) window.removeEventListener(name, followup, true);
    window.removeEventListener("blur", clear); window.removeEventListener("pointercancel", clear); document.removeEventListener("visibilitychange", clear); stopSync();
  };
}
