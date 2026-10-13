import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { ACTIONS, bindingError, conflicts, effective, overlaps, sanitize, signature, type Binding, type Overrides } from "./bindings";
const KEY = "suivelle.shortcuts";
const read = () => { try { return sanitize(JSON.parse(localStorage.getItem(KEY) ?? "null")); } catch { return {}; } };
interface State { overrides: Overrides; recording: boolean; setRecording: (recording: boolean) => void; assign: (id: string, bindings: Binding[], replace?: boolean) => void; reset: (id?: string) => void; error: string | null }
export const useShortcuts = create<State>((set, get) => {
  const save = (overrides: Overrides) => {
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, overrides })); set({ overrides, error: null }); }
    catch { throw new Error("Could not save shortcuts on this device. The previous bindings remain active."); }
  };
  return { overrides: read(), recording: false, error: null,
    setRecording: recording => set({ recording }),
    assign: (id, bindings, replace = false) => {
      if (!ACTIONS.some(a => a.id === id)) throw new Error("Unknown shortcut action.");
      if (bindings.length > 12 || new Set(bindings.map(signature)).size !== bindings.length) throw new Error("Use at most 12 distinct bindings for an action.");
      const next = { ...get().overrides };
      for (const b of bindings) {
        const error = bindingError(id, b); if (error) throw new Error(error);
        const collisions = conflicts(id, b, next);
        if (collisions.length && !replace) throw new Error(`Already assigned to ${collisions.map(a => a.title).join(", ")}.`);
        for (const a of collisions) next[a.id] = effective(a.id, next).filter(existing => !overlaps(existing, b));
      }
      next[id] = bindings;
      save(next);
    },
    reset: id => { const next = { ...get().overrides }; if (id) delete next[id]; else { save({}); return; }
      // Restoring defaults must not silently introduce a collision with another customization.
      for (const b of effective(id, next)) if (conflicts(id, b, next).length) throw new Error("These defaults conflict with another assignment. Restore all defaults or resolve that assignment first.");
      save(next);
    },
  };
});
export function installShortcutSync() {
  const changed = (e: StorageEvent) => { if (e.key === KEY) { try { useShortcuts.setState({ overrides: sanitize(JSON.parse(e.newValue ?? "null")) }); } catch { /* keep the last valid state */ } } };
  window.addEventListener("storage", changed);
  let disposed = false, receiving = false;
  let stopNative: (() => void) | undefined;
  const sender = crypto.randomUUID();
  const desktop = "__TAURI_INTERNALS__" in window;
  if (desktop) void listen<{ sender: string; value: unknown }>("shortcuts-local", event => {
    if (event.payload.sender === sender) return;
    receiving = true;
    useShortcuts.setState({ overrides: sanitize(event.payload.value) });
    receiving = false;
  }).then(stop => { if (disposed) stop(); else stopNative = stop; }).catch(() => undefined);
  const stopStore = useShortcuts.subscribe((state, previous) => {
    if (desktop && !receiving && state.overrides !== previous.overrides) void emit("shortcuts-local", { sender, value: { version: 1, overrides: state.overrides } }).catch(() => undefined);
  });
  return () => { disposed = true; window.removeEventListener("storage", changed); stopNative?.(); stopStore(); };
}
