import { Icon, type IconName } from "../../components/Icon";
import { ShortcutKeys } from "../../components/ShortcutKeys";
import { useShortcutSheet } from "./ShortcutSheet";
import { useSettingsDialog } from "../settings/store";
import { useEffect, useRef, useState } from "react";
import { ACTIONS, bindingError, conflicts, effective, format, fromEvent, key, resolvedModifiers, signature, type Binding, type Modifier, type Scope } from "./bindings";
import { useShortcuts } from "./store";
import "./shortcuts.css";

const SCOPES: Scope[] = ["workspace", "editor", "pages", "grid", "map", "tab", "capture"];
const NAMES: Record<Scope, string> = { workspace: "Anywhere in the workspace", editor: "Writing", pages: "Page tree", grid: "Database grid", map: "Node Map", tab: "Tabs", capture: "Quick capture" };
const SCOPE_ICONS: Record<Scope, IconName> = { workspace: "dashboard", editor: "edit", pages: "page", grid: "table", map: "nodeMap", tab: "layers", capture: "bolt" };
const NOTES: Record<Scope, string> = {
  workspace: "Search, navigation, sidebar, settings and everything that works on any page.",
  editor: "Formatting and block commands while you write.",
  pages: "Moving around and reordering in the page tree.",
  grid: "Selecting and editing cells in a database.",
  map: "Searching and moving around the Node Map.",
  tab: "Closing and reordering the tab you are on.",
  capture: "Adding to a page without leaving what you are doing.",
};
const FILTERS = [["all", "All bindings"], ["custom", "Customized"], ["unassigned", "Unassigned"], ["conflicts", "Conflicts"]] as const;
const BUTTONS = ["Primary", "Middle", "Secondary", "Back", "Forward"];
interface Edit { id: string; index: number | null; candidate: Binding | null }

export function ShortcutSettings({ active = true }: { active?: boolean }) {
  const overrides = useShortcuts(s => s.overrides);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope | "all">("all");
  const [filter, setFilter] = useState("all");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [mode, setMode] = useState<"logical" | "physical">("logical");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastInput, setLastInput] = useState("Focus here, then press a key or mouse button.");
  const zone = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!active) { setEdit(null); useShortcuts.getState().setRecording(false); } }, [active]);
  useEffect(() => {
    useShortcuts.getState().setRecording(!!edit);
    if (edit) zone.current?.focus();
    return () => useShortcuts.getState().setRecording(false);
  }, [edit?.id, edit?.index]);
  const perform = async (fn: () => void | Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const record = (event: React.KeyboardEvent | React.MouseEvent, diagnostic = false) => {
    if ("key" in event && event.key === "Tab") return;
    if (!diagnostic && "key" in event && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEdit(null); return; }
    event.preventDefault(); event.stopPropagation();
    const b = fromEvent(event.nativeEvent, mode);
    if (!b) { setLastInput("Hold modifiers with a key or button. Composition and modifier-only presses are not shortcut triggers."); return; }
    if (diagnostic) setLastInput(format(b));
    else setEdit(current => current ? { ...current, candidate: b } : null);
  };
  const save = (replace: boolean) => perform(async () => {
    if (!edit?.candidate) return;
    const current = effective(edit.id, overrides);
    const next = edit.index === null ? [...current, edit.candidate] : current.map((b, i) => i === edit.index ? edit.candidate! : b);
    if (new Set(next.map(signature)).size !== next.length) throw new Error("This action already has that binding.");
    useShortcuts.getState().assign(edit.id, next, replace);
    setEdit(null);
  });
  const candidateError = edit?.candidate ? bindingError(edit.id, edit.candidate) : null;
  const collisions = edit?.candidate ? conflicts(edit.id, edit.candidate, overrides) : [];
  const customCount = Object.keys(overrides).length;
  const sections = SCOPES.filter(sc => scope === "all" || scope === sc).map(sc => ({
    scope: sc,
    actions: ACTIONS.filter(a => {
      const bindings = effective(a.id, overrides);
      const custom = overrides[a.id] !== undefined;
      return a.scope === sc && `${a.title} ${bindings.map(format).join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || filter === "custom" && custom || filter === "unassigned" && !bindings.length || filter === "conflicts" && bindings.some(b => conflicts(a.id, b, overrides).length));
    }),
  })).filter(x => x.actions.length);
  return <div className="shortcut-settings">
    <p className="set-hint">Bindings apply across workspaces on this device. Text entry, focus navigation and cancellation keep their normal behavior.</p>
    <div className="shortcut-filters">
      <input type="search" aria-label="Search shortcuts" placeholder="Search actions or bindings…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="shortcut-bar-actions">
        <button type="button" className="btn small" disabled={busy || !!edit} onClick={() => useSettingsDialog.getState().requestClose(() => useShortcutSheet.getState().show())}>View reference</button>
        <button type="button" className="btn small" disabled={busy || !!edit || !customCount} title={customCount ? `${customCount} changed` : "You haven't changed any shortcuts"} onClick={() => perform(() => useShortcuts.getState().reset())}>Restore all defaults</button>
      </div>
    </div>
    <div className="shortcut-cats" role="tablist" aria-label="Shortcut contexts">
      {(["all", ...SCOPES] as const).map(s => <button type="button" key={s} role="tab" aria-selected={scope === s} className={`shortcut-cat-chip${scope === s ? " active" : ""}`} onClick={() => setScope(s)}>
        {s !== "all" && <Icon name={SCOPE_ICONS[s]} size={14} />}<span>{s === "all" ? "All" : NAMES[s]}</span>
      </button>)}
    </div>
    <div className="shortcut-cats shortcut-subfilter" role="radiogroup" aria-label="Shortcut filter">
      {FILTERS.map(([id, label]) => <button type="button" key={id} role="radio" aria-checked={filter === id} className={`shortcut-cat-chip${filter === id ? " active" : ""}`} onClick={() => setFilter(id)}>{label}</button>)}
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {edit && <section className="shortcut-recorder" aria-label="Edit binding">
      <h4>{ACTIONS.find(a => a.id === edit.id)?.title}</h4>
      <div ref={zone} className="shortcut-capture" tabIndex={0} role="application" aria-label="Record a shortcut. Press a key or mouse button here. Escape cancels." onKeyDown={e => record(e)} onMouseDown={e => record(e)} onAuxClick={e => { e.preventDefault(); e.stopPropagation(); }} onClick={e => { e.preventDefault(); e.stopPropagation(); }} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}>
        <span role="status" aria-live="polite">{edit.candidate ? format(edit.candidate) : "Press a key or mouse button here"}</span>
      </div>
      <div className="shortcut-manual">
        <label>Keyboard identity<select value={mode} onChange={e => { setMode(e.target.value as typeof mode); setEdit({ ...edit, candidate: null }); }}><option value="logical">Logical key</option><option value="physical">Physical key</option></select></label>
        <label>Input type<select value={edit.candidate?.kind ?? "key"} onChange={e => setEdit({ ...edit, candidate: e.target.value === "mouse" ? { kind: "mouse", button: 3, modifiers: [] } : key("k") })}><option value="key">Keyboard</option><option value="mouse">Mouse button</option></select></label>
        {edit.candidate?.kind === "mouse" ? <label>Mouse button<select value={edit.candidate.button} onChange={e => setEdit({ ...edit, candidate: { ...edit.candidate as Extract<Binding, { kind: "mouse" }>, button: Number(e.target.value) } })}>{Array.from({ length: Math.max(32, (edit.candidate?.kind === "mouse" ? Math.min(edit.candidate.button + 1, 33) : 32)) }, (_, i) => <option key={i} value={i}>{BUTTONS[i] ?? `Button ${i + 1} (if detected)`}</option>)}{edit.candidate.button >= 33 && <option value={edit.candidate.button}>Detected button {edit.candidate.button + 1}</option>}</select></label> : <label>Key<input aria-label="Manual shortcut key" placeholder={mode === "physical" ? "KeyK, Digit1, Escape…" : "k, Enter, Escape…"} value={edit.candidate?.kind === "key" ? edit.candidate.key : ""} onChange={e => setEdit({ ...edit, candidate: { kind: "key", key: e.target.value, mode, modifiers: edit.candidate?.modifiers ?? [] } })} /></label>}
        {(["Control", "Shift", "Alt", "Meta"] as Modifier[]).map(m => <label className="shortcut-modifier" key={m}><input type="checkbox" checked={edit.candidate ? resolvedModifiers(edit.candidate.modifiers).includes(m) : false} onChange={e => { const b = edit.candidate ?? key("k"); setEdit({ ...edit, candidate: { ...b, modifiers: e.target.checked ? [...resolvedModifiers(b.modifiers) as Modifier[], m] : (resolvedModifiers(b.modifiers) as Modifier[]).filter(x => x !== m) } }); }} />{m === "Control" ? "Ctrl" : m === "Meta" ? "Win / Cmd" : m}</label>)}
      </div>
      <p className="set-hint">Click inside the recording field to bind a mouse button. Use the selectors for keys such as Escape. Extended mouse buttons work only when the device delivers them to the app.</p>
      {candidateError && <p className="field-error" role="status">{candidateError}</p>}
      {!!collisions.length && <p className="field-error" role="status">Also assigned to {collisions.map(c => `${c.title} (${NAMES[c.scope]})`).join(", ")}.</p>}
      <div className="shortcut-edit-actions"><button type="button" className="btn primary" disabled={busy || !edit.candidate || !!candidateError || !!collisions.length} onClick={() => save(false)}>Save binding</button>{!!collisions.length && <button type="button" className="btn" disabled={busy || !!candidateError} onClick={() => save(true)}>Replace conflicting assignments</button>}{edit.index !== null && <button type="button" className="btn" disabled={busy} onClick={() => perform(() => { useShortcuts.getState().assign(edit.id, effective(edit.id, overrides).filter((_, index) => index !== edit.index)); setEdit(null); })}>Remove binding</button>}<button type="button" className="btn" disabled={busy} onClick={() => setEdit(null)}>Cancel</button></div>
    </section>}
    <div className="shortcut-list">
      {sections.map(({ scope: s, actions }) => <section key={s} className="shortcut-sec">
        <h4 className="shortcut-sec-title"><Icon name={SCOPE_ICONS[s]} size={15} /><span>{NAMES[s]}</span><span className="shortcut-sec-count">{actions.length}</span></h4>
        <p className="shortcut-sec-note">{NOTES[s]}</p>
        <div className="shortcut-card">{actions.map(a => {
          const bindings = effective(a.id, overrides);
          const custom = overrides[a.id] !== undefined;
          const locked = busy || !!edit;
          return <div className={`shortcut-row${custom ? " custom" : ""}`} key={a.id} data-action-id={a.id}>
            <div className="shortcut-action"><span>{a.title}</span>{custom && <span className="shortcut-tag">Edited</span>}</div>
            <div className="shortcut-bindings">{bindings.length === 0 && <span className="shortcut-none">Not set</span>}{bindings.map((b, i) => <button type="button" className="shortcut-chip" key={i} disabled={locked} aria-label={`Change ${format(b)} for ${a.title}`} title={`Change ${format(b)} for ${a.title}`} onClick={() => { setError(null); setEdit({ id: a.id, index: i, candidate: b }); }}><ShortcutKeys binding={b} /></button>)}</div>
            <div className="shortcut-row-actions">
              {bindings.length > 0 && <button type="button" className="btn small ghost" disabled={locked} onClick={() => perform(() => useShortcuts.getState().assign(a.id, []))}>Disable</button>}
              <button type="button" className="btn small ghost" disabled={locked} onClick={() => { setError(null); setEdit({ id: a.id, index: null, candidate: null }); }}>Add</button>
              {custom && <button type="button" className="btn small ghost" disabled={locked} title="Restore the default keys" onClick={() => perform(() => useShortcuts.getState().reset(a.id))}>Reset</button>}
            </div>
          </div>;
        })}</div>
      </section>)}
      {!sections.length && <p className="shortcut-empty">No shortcuts match.</p>}
    </div>
    <details className="shortcut-diagnostic"><summary>Test input</summary><p className="set-hint">Only inputs received by the app can be bound. Fn and device-specific buttons may be handled by your keyboard or mouse driver.</p><div className="shortcut-capture" tabIndex={0} role="application" aria-label="Test keyboard and mouse input" onFocus={() => useShortcuts.getState().setRecording(true)} onBlur={() => useShortcuts.getState().setRecording(false)} onKeyDown={e => record(e, true)} onMouseDown={e => record(e, true)} onAuxClick={e => e.preventDefault()} onContextMenu={e => e.preventDefault()}><output aria-live="polite">{lastInput}</output></div></details>
  </div>;
}
