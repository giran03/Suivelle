import { format, isMac, resolvedModifiers, type Binding } from "../features/shortcuts/bindings";
import "./shortcutKeys.css";

/** One cap per input, without splitting literal plus keys or multiword mouse/physical keys. */
export function ShortcutKeys({ binding }: { binding: Binding }) {
  const modifiers = ["Control", "Alt", "Shift", "Meta"].filter(m => resolvedModifiers(binding.modifiers).includes(m));
  const names: Record<string, string> = { Control: isMac ? "⌃" : "Ctrl", Alt: isMac ? "⌥" : "Alt", Shift: isMac ? "⇧" : "Shift", Meta: isMac ? "⌘" : "Win" };
  const parts = [...modifiers.map(m => names[m]), format({ ...binding, modifiers: [] })];
  return <span className="shortcut-keycaps" title={format(binding)} aria-hidden="true">{parts.map((part, i) => <kbd key={i}>{part}</kbd>)}</span>;
}
