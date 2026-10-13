import { useGlobalShortcuts } from "./native";
import { ariaKeys, label } from "./bindings";
import { useShortcuts } from "./store";
export function useShortcut(id: string) {
  const overrides = useShortcuts(s => s.overrides);
  const native = useGlobalShortcuts(s => s.state);
  const combined = { ...overrides, ...(native ? { "global-capture": native.config.capture, "global-focus": native.config.focus } : {}) };
  return { label: label(id, combined), aria: ariaKeys(id, combined) };
}
