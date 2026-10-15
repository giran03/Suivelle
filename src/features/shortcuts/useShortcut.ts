import { ariaKeys, label } from "./bindings";
import { useShortcuts } from "./store";
export function useShortcut(id: string) {
  const overrides = useShortcuts(s => s.overrides);
  return { label: label(id, overrides), aria: ariaKeys(id, overrides) };
}
