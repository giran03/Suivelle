/** Structured inputs shared by recording, routing, conflict checks and labels. */
export type Modifier = "Primary" | "Control" | "Shift" | "Alt" | "Meta";
export type Binding = { kind: "key"; key: string; mode?: "logical" | "physical"; location?: number; displayKey?: string; modifiers: Modifier[] } | { kind: "mouse"; button: number; modifiers: Modifier[] };
export type Scope = "workspace" | "editor" | "pages" | "grid" | "tab" | "capture" | "global";
export interface Action { id: string; title: string; scope: Scope; defaults: Binding[]; repeat?: boolean; readonly?: boolean }
export const MODIFIERS: Modifier[] = ["Primary", "Control", "Shift", "Alt", "Meta"];
export const key = (value: string, ...modifiers: Modifier[]): Binding => ({ kind: "key", key: value, modifiers });
export const mouse = (button: number, ...modifiers: Modifier[]): Binding => ({ kind: "mouse", button, modifiers });
const action = (id: string, title: string, scope: Scope, ...defaults: Binding[]): Action => ({ id, title, scope, defaults });
export const ACTIONS: Action[] = [
  action("search", "Search pages and commands", "workspace", key("k", "Primary")),
  action("new-page", "New page", "workspace", key("n", "Primary")),
  action("sidebar", "Collapse or expand the sidebar", "workspace", key("\\", "Primary")),
  action("focus", "Focus mode", "workspace", key("\\", "Primary", "Shift")),
  action("shortcuts", "Shortcut reference", "workspace", key("/", "Primary"), key("?", "Shift")),
  action("capture", "Quick capture", "workspace", key("n", "Primary", "Shift")),
  action("find", "Find in page", "workspace", key("f", "Primary")),
  action("replace", "Find and replace", "workspace", key("h", "Primary")),
  action("settings", "Settings", "workspace", key(",", "Primary")),
  action("back", "Go back", "workspace", key("ArrowLeft", "Alt")),
  action("forward", "Go forward", "workspace", key("ArrowRight", "Alt")),
  action("next-tab", "Next tab", "workspace", key("Tab", "Primary")),
  action("previous-tab", "Previous tab", "workspace", key("Tab", "Primary", "Shift")),
  action("close-tab", "Close current tab", "workspace", key("w", "Primary")),
  action("bold", "Bold", "editor", key("b", "Primary")),
  action("italic", "Italic", "editor", key("i", "Primary")),
  action("underline", "Underline", "editor", key("u", "Primary")),
  action("strike", "Strikethrough", "editor", key("s", "Primary", "Shift")),
  action("inline-code", "Inline code", "editor", key("e", "Primary")),
  action("undo", "Undo", "editor", key("z", "Primary")),
  action("redo", "Redo", "editor", key("z", "Primary", "Shift"), key("y", "Primary")),
  action("copy-plain", "Copy as plain text", "editor", key("c", "Primary", "Shift")),
  action("paste-plain", "Paste as plain text", "editor", key("v", "Primary", "Shift")),
  action("insert-above", "Insert a text block above", "editor", key("Enter", "Primary")),
  action("duplicate-block", "Duplicate block", "editor", key("d", "Primary", "Shift")),
  action("move-block-up", "Move block up", "editor", key("ArrowUp", "Alt", "Shift")),
  action("move-block-down", "Move block down", "editor", key("ArrowDown", "Alt", "Shift")),
  action("heading-1", "Heading 1", "editor", key("1", "Primary", "Alt")),
  action("heading-2", "Heading 2", "editor", key("2", "Primary", "Alt")),
  action("heading-3", "Heading 3", "editor", key("3", "Primary", "Alt")),
  action("paragraph", "Text block", "editor", key("0", "Primary", "Alt")),
  action("bullet-list", "Bulleted list", "editor", key("*", "Primary", "Shift")),
  action("ordered-list", "Numbered list", "editor", key("&", "Primary", "Shift")),
  action("task-list", "To-do list", "editor", key("(", "Primary", "Shift")),
  action("code-block", "Code block", "editor", key("c", "Primary", "Alt")),
  action("page-new-tab", "Open page in a new tab", "pages", mouse(0, "Alt"), mouse(1)),
  action("page-pick", "Select or unselect page", "pages", mouse(0, "Primary"), key("Enter", "Primary"), key(" ", "Primary")),
  action("page-range", "Select a range of pages", "pages", mouse(0, "Shift"), mouse(0, "Primary", "Shift"), key("Enter", "Shift"), key(" ", "Shift")),
  action("page-select-all", "Select all pages in tree", "pages", key("a", "Primary")),
  action("page-copy", "Copy selected pages", "pages", key("c", "Primary")),
  action("page-paste", "Paste pages", "pages", key("v", "Primary")),
  action("page-trash", "Trash selected pages", "pages", key("Delete")),
  action("tab-close", "Close this tab", "tab", mouse(1)),
  action("tab-move-left", "Move tab left", "tab", key("PageUp", "Primary", "Shift")),
  action("tab-move-right", "Move tab right", "tab", key("PageDown", "Primary", "Shift")),
  action("grid-select-row", "Select or unselect row", "grid", key(" ", "Primary")),
  action("grid-select-range", "Select range of rows", "grid", key(" ", "Primary", "Shift")),
  action("grid-select-all", "Select all loaded rows", "grid", key("a", "Primary")),
  action("grid-open", "Open record", "grid", key("Enter", "Shift")),
  action("grid-edit", "Edit cell", "grid", key("Enter"), key("F2")),
  action("grid-clear", "Clear cell", "grid", key("Delete"), key("Backspace")),
  action("grid-menu", "Cell menu", "grid", key("F10", "Shift"), key("ContextMenu")),
  action("capture-save", "Save quick capture", "capture", key("Enter")),
  action("global-capture", "Quick capture from any program", "global", key("n", "Control", "Alt")),
  action("global-focus", "Focus Suivelle from any program", "global", key("s", "Control", "Alt")),
];
export type Overrides = Record<string, Binding[]>;
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
export function resolvedModifiers(modifiers: Modifier[], mac = isMac): string[] {
  return [...new Set(modifiers.map(m => m === "Primary" ? mac ? "Meta" : "Control" : m))].sort();
}
export function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== "object") return false;
  const b = value as Binding;
  if (!Array.isArray(b.modifiers) || b.modifiers.some(m => !MODIFIERS.includes(m)) || new Set(b.modifiers).size !== b.modifiers.length || resolvedModifiers(b.modifiers).length !== b.modifiers.length) return false;
  if (b.kind === "mouse") return Number.isInteger(b.button) && b.button >= 0 && b.button <= 32767;
  return b.kind === "key" && typeof b.key === "string" && b.key.length > 0 && b.key.length <= 64 && !["Control", "Shift", "Alt", "Meta", "Dead", "Unidentified"].includes(b.key)
    && (b.mode === undefined || b.mode === "logical" || b.mode === "physical") && (b.location === undefined || [0, 1, 2, 3].includes(b.location)) && (b.displayKey === undefined || typeof b.displayKey === "string" && b.displayKey.length > 0 && b.displayKey.length <= 64);
}
export function effective(id: string, overrides: Overrides): Binding[] { return overrides[id] ?? ACTIONS.find(a => a.id === id)?.defaults ?? []; }
export function signature(b: Binding): string {
  return `${b.kind}:${b.kind === "mouse" ? b.button : `${b.mode ?? "logical"}:${b.key.toLowerCase()}:${b.location ?? "any"}`}:${resolvedModifiers(b.modifiers).join("+")}`;
}
export function overlaps(a: Binding, b: Binding): boolean {
  if (a.kind !== b.kind || resolvedModifiers(a.modifiers).join() !== resolvedModifiers(b.modifiers).join()) return false;
  if (a.kind === "mouse" && b.kind === "mouse") return a.button === b.button;
  if (a.kind !== "key" || b.kind !== "key") return false;
  if (a.location !== undefined && b.location !== undefined && a.location !== b.location) return false;
  if ((a.mode ?? "logical") === (b.mode ?? "logical")) return a.key.toLowerCase() === b.key.toLowerCase();
  const physical = a.mode === "physical" ? a : b;
  const logical = a.mode === "physical" ? b : a;
  // Recording supplies the actual layout identity; unknown manual codes remain conservative.
  return physical.displayKey ? physical.displayKey.toLowerCase() === logical.key.toLowerCase() : true;
}
export function conflicts(id: string, candidate: Binding, overrides: Overrides): Action[] {
  const scope = ACTIONS.find(a => a.id === id)?.scope;
  return ACTIONS.filter(a => a.id !== id && (a.scope === scope || (a.scope !== "global" && scope !== "global" && (a.scope === "workspace" || scope === "workspace"))) && effective(a.id, overrides).some(b => overlaps(b, candidate)));
}
export function bindingError(id: string, b: Binding): string | null {
  if (!validBinding(b)) return "Choose a valid input and modifiers.";
  const scope = ACTIONS.find(a => a.id === id)?.scope;
  if (scope === "workspace" && b.kind === "mouse" && b.button <= 2 && b.modifiers.length === 0) return "Unmodified primary, secondary and middle clicks need a specific context. Add a modifier for a workspace action.";
  if (scope === "global" && (b.kind !== "key" || b.mode === "physical" || b.location !== undefined || !b.modifiers.length)) return "System-wide shortcuts require a keyboard key with modifiers, without a physical-key or side restriction.";
  if (b.kind === "key" && b.modifiers.length === 0 && ["Tab", "Escape"].includes(b.key)) return "Tab and Escape remain available for focus navigation and cancellation. Add a modifier.";
  return null;
}
export function sanitize(value: unknown): Overrides {
  if (!value || typeof value !== "object") return {};
  const record = value as { version?: number; overrides?: unknown };
  if (record.version !== 1 || !record.overrides || typeof record.overrides !== "object") return {};
  const result: Overrides = {};
  for (const [id, values] of Object.entries(record.overrides)) {
    if (id === "__proto__" || id === "constructor" || !Array.isArray(values) || values.length > 12) continue;
    if (values.every(validBinding)) result[id] = values.map(b => ({ ...b, modifiers: [...b.modifiers] }));
  }
  return result;
}
export type InputEvent = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> & Partial<Pick<KeyboardEvent, "key" | "code" | "location" | "repeat" | "isComposing" | "keyCode" | "getModifierState">> & { button?: number };
export function fromEvent(e: InputEvent, mode: "logical" | "physical" = "logical"): Binding | null {
  if (e.isComposing || e.keyCode === 229 || e.getModifierState?.("AltGraph")) return null;
  const modifiers: Modifier[] = [];
  if (e.ctrlKey) modifiers.push("Control"); if (e.metaKey) modifiers.push("Meta"); if (e.shiftKey) modifiers.push("Shift"); if (e.altKey) modifiers.push("Alt");
  const b: Binding = e.key !== undefined ? { kind: "key", key: mode === "physical" ? e.code ?? "" : e.key, mode, ...(mode === "physical" ? { displayKey: e.key } : {}), ...(e.location === 3 ? { location: 3 } : {}), modifiers } : { kind: "mouse", button: e.button ?? -1, modifiers };
  return validBinding(b) ? b : null;
}
export function matches(b: Binding, e: InputEvent): boolean {
  const input = fromEvent(e, b.kind === "key" ? b.mode : undefined);
  if (!input || b.kind !== input.kind || resolvedModifiers(b.modifiers).join() !== resolvedModifiers(input.modifiers).join()) return false;
  if (b.kind === "mouse" && input.kind === "mouse") return b.button === input.button;
  return b.kind === "key" && input.kind === "key" && b.key.toLowerCase() === input.key.toLowerCase() && (b.location === undefined || b.location === e.location);
}
export function resolve(e: InputEvent, scope: Scope, overrides: Overrides): Action | undefined {
  const eligible = ACTIONS.filter(a => a.scope === scope && (!e.repeat || a.repeat) && effective(a.id, overrides).some(b => !bindingError(a.id, b) && matches(b, e)));
  return eligible.length === 1 ? eligible[0] : undefined;
}
const BUTTONS = ["Primary click", "Middle click", "Secondary click", "Mouse Back", "Mouse Forward"];
const KEY_LABELS: Record<string, string> = { " ": "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down" };
export function format(b: Binding): string {
  const mods = ["Control", "Alt", "Shift", "Meta"].filter(m => resolvedModifiers(b.modifiers).includes(m)).map(m => ({ Control: "Ctrl", Meta: isMac ? "Cmd" : "Win", Shift: "Shift", Alt: "Alt" })[m]);
  const trigger = b.kind === "mouse" ? BUTTONS[b.button] ?? `Mouse button ${b.button + 1}` : `${b.mode === "physical" ? "Physical " : ""}${KEY_LABELS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key)}${b.location === 3 ? " (numpad)" : ""}`;
  return [...mods, trigger].join("+");
}
export function label(id: string, overrides: Overrides): string { return effective(id, overrides).map(format).join(" / "); }
export function ariaKeys(id: string, overrides: Overrides): string | undefined {
  return effective(id, overrides).filter((b): b is Extract<Binding, { kind: "key" }> => b.kind === "key" && b.mode !== "physical").map(b => [...resolvedModifiers(b.modifiers), b.key === " " ? "Space" : b.key === "+" ? "Plus" : b.key].join("+")).join(" ") || undefined;
}
