import { ShortcutKeys } from "../../components/ShortcutKeys";
import { useShortcutSheet } from "./ShortcutSheet";
import { useSettingsDialog } from "../settings/store";
import { useEffect, useRef, useState } from "react";
import { ACTIONS, bindingError, conflicts, effective, format, fromEvent, key, resolvedModifiers, signature, type Binding, type Modifier, type Scope } from "./bindings";
import { useShortcuts } from "./store";
import { useGlobalShortcuts, loadGlobalShortcuts, saveGlobalBindings, resetGlobalBindings, setRecordingNative, enableGlobalBinding } from "./native";
import "./shortcuts.css";

const SCOPES: Scope[] = ["workspace", "editor", "pages", "grid", "tab", "capture", "global"];
const NAMES: Record<Scope, string> = { workspace: "Anywhere in the workspace", editor: "Writing", pages: "Page tree", grid: "Database grid", tab: "Tabs", capture: "Quick capture", global: "From any program" };
const BUTTONS = ["Primary", "Middle", "Secondary", "Back", "Forward"];
interface Edit { id: string; index: number | null; candidate: Binding | null }

export function ShortcutSettings({ active = true }: { active?: boolean }) {
  const overrides = useShortcuts(s => s.overrides);
  const native = useGlobalShortcuts(s => s.state);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope | "all">("all");
  const [filter, setFilter] = useState("all");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [mode, setMode] = useState<"logical" | "physical">("logical");
  const [error, setError] = useState<string | null>(null);
  const [recordReady, setRecordReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastInput, setLastInput] = useState("Focus here, then press a key or mouse button.");
  const zone = useRef<HTMLDivElement>(null);
  const combined = { ...overrides, ...(native ? { "global-capture": native.config.capture, "global-focus": native.config.focus } : {}) };
  useEffect(() => { void loadGlobalShortcuts(); }, []);
  useEffect(() => { if (!active) { setEdit(null); useShortcuts.getState().setRecording(false); void setRecordingNative(false); } }, [active]);
  useEffect(() => {
    useShortcuts.getState().setRecording(!!edit);
    let mounted = true;
    const prepare = () => {
      setRecordReady(false);
      void setRecordingNative(true).then(() => { if (mounted) setRecordReady(true); }).catch(e => { if (mounted) setError(String(e)); });
    };
    if (edit) { zone.current?.focus(); prepare(); }
    else void setRecordingNative(false).catch(e => setError(String(e)));
    const focus = () => { if (edit) prepare(); };
    const blur = () => { if (edit) { setRecordReady(false); void setRecordingNative(false); } };
    window.addEventListener("focus", focus); window.addEventListener("blur", blur);
    return () => { mounted = false; window.removeEventListener("focus", focus); window.removeEventListener("blur", blur); useShortcuts.getState().setRecording(false); void setRecordingNative(false); };
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
    if (!diagnostic && !recordReady) return;
    const b = fromEvent(event.nativeEvent, mode);
    if (!b) { setLastInput("Hold modifiers with a key or button. Composition and modifier-only presses are not shortcut triggers."); return; }
    if (diagnostic) setLastInput(format(b));
    else setEdit(current => current ? { ...current, candidate: b } : null);
  };
  const save = (replace: boolean) => perform(async () => {
    if (!edit?.candidate) return;
    const current = effective(edit.id, combined);
    const next = edit.index === null ? [...current, edit.candidate] : current.map((b, i) => i === edit.index ? edit.candidate! : b);
    if (new Set(next.map(signature)).size !== next.length) throw new Error("This action already has that binding.");
    if (ACTIONS.find(a => a.id === edit.id)?.scope === "global") await saveGlobalBindings(edit.id, next, replace);
    else useShortcuts.getState().assign(edit.id, next, replace);
    setEdit(null);
  });
  const candidateError = edit?.candidate ? bindingError(edit.id, edit.candidate) : null;
  const collisions = edit?.candidate ? conflicts(edit.id, edit.candidate, combined) : [];
  const nativeError = useGlobalShortcuts(s => s.error);
  const nativeAvailable = "__TAURI_INTERNALS__" in window;
  return <div className="shortcut-settings">
    <p className="set-hint">Bindings apply across workspaces on this device. Text entry, focus navigation and cancellation keep their normal behavior.</p>
    <div className="shortcut-filters">
      <input type="search" aria-label="Search shortcuts" placeholder="Search actions or bindings…" value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label="Shortcut context" value={scope} onChange={e => setScope(e.target.value as Scope | "all")}><option value="all">All contexts</option>{SCOPES.map(s => <option key={s} value={s}>{NAMES[s]}</option>)}</select>
      <select aria-label="Shortcut filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All bindings</option><option value="custom">Customized</option><option value="unassigned">Unassigned</option><option value="conflicts">Conflicts</option></select>
      <button type="button" className="btn" disabled={busy || !!edit} onClick={() => useSettingsDialog.getState().requestClose(() => useShortcutSheet.getState().show())}>View reference</button>
      <button type="button" className="btn" disabled={busy || !!edit} onClick={() => perform(async () => { if (nativeAvailable) await resetGlobalBindings(); useShortcuts.getState().reset(); })}>Restore all defaults</button>
    </div>
    {(error || nativeError) && <p className="field-error" role="alert">{error || nativeError}</p>}
    {!nativeAvailable && <p className="set-hint">System-wide shortcuts are available in the desktop app.</p>}
    {native && Object.entries(native.errors).map(([id, message]) => message && <p key={id} className="field-error" role="status">{id === "capture" ? "Global capture" : id === "focus" ? "Global focus" : "Global shortcut settings"}: {message}</p>)}
    {edit && <section className="shortcut-recorder" aria-label="Edit binding">
      <h4>{ACTIONS.find(a => a.id === edit.id)?.title}</h4>
      <div ref={zone} className="shortcut-capture" tabIndex={0} role="application" aria-label="Record a shortcut. Press a key or mouse button here. Escape cancels." onKeyDown={e => record(e)} onMouseDown={e => record(e)} onAuxClick={e => { e.preventDefault(); e.stopPropagation(); }} onClick={e => { e.preventDefault(); e.stopPropagation(); }} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}>
        <span role="status" aria-live="polite">{!recordReady ? "Preparing input recording…" : edit.candidate ? format(edit.candidate) : "Press a key or mouse button here"}</span>
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
      <div className="shortcut-edit-actions"><button type="button" className="btn primary" disabled={busy || !recordReady || !edit.candidate || !!candidateError || !!collisions.length} onClick={() => save(false)}>Save binding</button>{!!collisions.length && <button type="button" className="btn" disabled={busy || !!candidateError} onClick={() => save(true)}>Replace conflicting assignments</button>}{edit.index !== null && <button type="button" className="btn" disabled={busy} onClick={() => perform(async () => { const next = effective(edit.id, combined).filter((_, index) => index !== edit.index); if (ACTIONS.find(a => a.id === edit.id)?.scope === "global") await saveGlobalBindings(edit.id, next); else useShortcuts.getState().assign(edit.id, next); setEdit(null); })}>Remove binding</button>}<button type="button" className="btn" disabled={busy} onClick={() => setEdit(null)}>Cancel</button></div>
    </section>}
    <div className="shortcut-list">
      {SCOPES.filter(s => scope === "all" || scope === s).map(s => {
        const actions = ACTIONS.filter(a => {
          const bindings = effective(a.id, combined);
          const custom = s === "global" ? JSON.stringify(bindings) !== JSON.stringify(a.defaults) : overrides[a.id] !== undefined;
          return a.scope === s && `${a.title} ${bindings.map(format).join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || filter === "custom" && custom || filter === "unassigned" && !bindings.length || filter === "conflicts" && bindings.some(b => conflicts(a.id, b, combined).length));
        });
        return actions.length ? <section key={s}><h4>{NAMES[s]}</h4>{actions.map(a => {
          const bindings = effective(a.id, combined);
          const enabled = !!bindings.length && (s !== "global" || !!native?.config[a.id === "global-capture" ? "captureEnabled" : "focusEnabled"]);
          const locked = busy || !!edit || s === "global" && (!nativeAvailable || !native);
          return <div className="shortcut-row" key={a.id}>
          <div className="shortcut-action"><span>{a.title}</span>{s === "global" && <small role="status">{!nativeAvailable ? "Desktop only" : !native ? "Loading…" : !native.config[a.id === "global-capture" ? "captureEnabled" : "focusEnabled"] ? "Disabled" : !bindings.length ? "No shortcut assigned" : native.active[a.id === "global-capture" ? "capture" : "focus"] ? "Active" : "Unavailable"}</small>}</div>
          <div className="shortcut-bindings">{effective(a.id, combined).map((b, i) => <button type="button" className="shortcut-chip" key={i} disabled={busy || !!edit || s === "global" && !nativeAvailable} aria-label={`Change ${format(b)} for ${a.title}`} title={`Change ${format(b)} for ${a.title}`} onClick={() => { setError(null); setEdit({ id: a.id, index: i, candidate: b }); }}><ShortcutKeys binding={b} /></button>)}{!effective(a.id, combined).length && <span className="set-hint">Unassigned</span>}</div>
          <div className="shortcut-row-actions">
            {s === "global" ? <button type="button" className="btn shortcut-toggle" disabled={locked} aria-label={`${enabled ? "Disable" : "Enable"} ${a.title}`} title={enabled ? "Turn off this shortcut and keep its keys" : bindings.length ? "Turn on this shortcut" : "Enable with the default keys"} onClick={() => perform(() => enableGlobalBinding(a.id, !enabled))}>{enabled ? "Disable" : "Enable"}</button> : bindings.length > 0 && <button type="button" className="btn" disabled={locked} onClick={() => perform(() => useShortcuts.getState().assign(a.id, []))}>Disable</button>}
            <button type="button" className="btn" disabled={locked} onClick={() => { setError(null); setEdit({ id: a.id, index: null, candidate: null }); }}>Add</button>
            <button type="button" className="btn" disabled={locked} title="Restore the default keys" onClick={() => perform(async () => { if (s === "global") await saveGlobalBindings(a.id, a.defaults); else useShortcuts.getState().reset(a.id); })}>Reset</button>
          </div>
        </div>; })}</section> : null;
      })}
    </div>
    <section className="shortcut-diagnostic"><h4>Test input</h4><p className="set-hint">Only inputs received by the app can be bound. Fn and device-specific buttons may be handled by your keyboard or mouse driver.</p><div className="shortcut-capture" tabIndex={0} role="application" aria-label="Test keyboard and mouse input" onFocus={() => { useShortcuts.getState().setRecording(true); void setRecordingNative(true).catch(e => setError(String(e))); }} onBlur={() => { useShortcuts.getState().setRecording(false); void setRecordingNative(false); }} onKeyDown={e => record(e, true)} onMouseDown={e => record(e, true)} onAuxClick={e => e.preventDefault()} onContextMenu={e => e.preventDefault()}><output aria-live="polite">{lastInput}</output></div></section>
  </div>;
}
