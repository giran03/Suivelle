import { useEffect, useRef, useState, type CSSProperties } from "react";
import { exportWorkspaceArchive } from "../transfer/transfer";
import { useTransferDialog } from "../transfer/store";
import { useWorkspaceDialog, type WorkspaceDialogMode } from "./store";
import { EmojiPicker } from "../../components/LazyEmojiPicker";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { WorkspaceStats } from "../../types";
import { WorkspaceList } from "./WorkspaceList";
import { WorkspaceBadge } from "./WorkspaceBadge";
import { workspaceOptions, WORKSPACE_COLORS, WORKSPACE_SYMBOLS } from "./model";
import { syncDialog } from "../../lib/dialog";
import { SearchField } from "../../components/SearchField";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ColorPicker } from "../../components/ColorPicker";
import { rememberColor, rgbToHex } from "../../lib/color";
import { radioKeys } from "../settings/radioKeys";
import "./workspaces.css";

type Mode = WorkspaceDialogMode;

function Body({ mode, selectedId, onSelect, onDirty, onBusy, close, cancel }: { mode: Mode; selectedId: string | undefined; onSelect: (id: string) => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; close: () => void; cancel: () => void }) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const workspace = workspaces.find((w) => w.id === selectedId) ?? null;
  const workspaceBusy = useWorkspace((s) => s.workspaceBusy);
  const options = workspaceOptions(workspace);
  const creating = mode === "create";
  const initial = { image: null as File | null, name: creating ? "" : workspace?.name ?? "", icon: creating ? null : workspace?.icon ?? null, description: creating ? "" : options.description, accent: creating ? "violet" as const : options.accent, sidebarDensity: creating ? "comfortable" : options.sidebarDensity };
  const [draft, setDraft] = useState(initial);
  const fileInput = useRef<HTMLInputElement>(null);
  const [imagePreview, setImagePreview] = useState<string | undefined>();
  useEffect(() => {
    if (!draft.image) { setImagePreview(undefined); return; }
    const url = URL.createObjectURL(draft.image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.image]);
  const imageSelected = !!draft.image || !!draft.icon?.startsWith("image:");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [statsEpoch, setStatsEpoch] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchAnchor, setSearchAnchor] = useState<Anchor | null>(null);
  const [pickerColor, setPickerColor] = useState<string | null>(null);
  const dirty = mode !== "delete" && JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (mode !== "delete" || !workspace) return;
    let cancelled = false;
    setError(null); setStats(null);
    ipc.workspaceStats(workspace.id).then((value) => { if (!cancelled) setStats(value); }).catch((e) => { if (!cancelled) setError(toAppError(e).message); });
    return () => { cancelled = true; };
  }, [mode, workspace?.id, statsEpoch]);
  const locked = busy || workspaceBusy;
  useEffect(() => onBusy(locked), [locked, onBusy]);
  const patch = (p: Partial<typeof draft>) => { setDraft((d) => ({ ...d, ...("icon" in p ? { image: null } : {}), ...p })); setMessage(null); };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); setMessage(null); try { await fn(); } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); } };
  const exportWorkspace = () => run(async () => { if (workspace) { const result = await exportWorkspaceArchive(workspace.id); if (result) setMessage(`Workspace exported to ${result.fileName || "an archive"}.`); } });
  const uploadIcon = () => {
    // A new workspace keeps the chosen file in the draft; the picker itself is not busy work.
    if (creating) { fileInput.current?.click(); return; }
    return run(async () => {
      if (!workspace) return;
      const image = await ipc.attachmentImport(workspace.id, "image");
      if (image) patch({ icon: `image:${image.hash}` });
    });
  };
  const openColorPicker = () => {
    const selected = document.querySelector<HTMLElement>('.ws-color-choice[aria-pressed="true"]');
    const rgb = selected && getComputedStyle(selected).backgroundColor.match(/[\d.]+/g);
    setPickerColor(draft.accent.startsWith("#") ? draft.accent : rgb && rgb.length >= 3 ? rgbToHex(rgb.slice(0, 3).map(Number)) : "#7C3AED");
  };

  if (mode === "delete") return <div className="ws-delete">
    <div className="ws-identity"><WorkspaceBadge workspace={workspace} /><strong>{workspace?.name}</strong></div>
    <p>Deletes this workspace, its pages, records, databases, dashboards and version history. Other workspaces stay available.</p>
    <p className="picker-muted">A verified safety backup of all workspaces is saved first. Restore it from Backups if you need to recover this workspace; restoring replaces all current workspace data.</p>
    {stats ? <p className="ws-delete-counts">{stats.pages.toLocaleString()} pages · {stats.records.toLocaleString()} records · {stats.databases.toLocaleString()} databases · {stats.dashboards.toLocaleString()} dashboards{stats.trashed ? ` · includes ${stats.trashed.toLocaleString()} trashed items` : ""}</p> : !error && <p aria-live="polite">Checking workspace contents…</p>}
    {error && <p className="field-error" role="alert">{error} {!stats && <button className="link" onClick={() => setStatsEpoch((v) => v + 1)}>Try again</button>}</p>}
    {message && <p role="status" className="picker-muted">{message}</p>}
    {workspaces.length <= 1 ? <p className="field-error">Your last workspace cannot be deleted. Create another workspace first.</p> : <form onSubmit={(e) => { e.preventDefault(); if (locked || !stats || confirmation.trim() !== workspace?.name || !workspace) return; void run(async () => { await useWorkspace.getState().deleteWorkspace(workspace.id, confirmation); close(); }); }}>
      <label className="field"><span>Type <strong>{workspace?.name}</strong> to confirm</span><input autoFocus value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={locked} autoComplete="off" /></label>
      <div className="ws-actions"><button type="button" className="btn" disabled={locked} onClick={() => void exportWorkspace()}><Icon name="download" size={14} /> Export a copy…</button><span /><button type="button" className="btn" disabled={locked} onClick={() => useWorkspaceDialog.getState().show("manage")}>Cancel</button><button type="submit" className="btn danger" disabled={locked || !stats || confirmation.trim() !== workspace?.name}>{locked ? "Saving safety backup…" : "Delete workspace"}</button></div>
    </form>}
  </div>;

  return <div className="ws-manager">
    {!creating && <section className="ws-directory ws-icon-rail" aria-label="Workspaces on this computer">
      <h3 className="sr-only">Your workspaces</h3>
      {workspaces.length > 5 && <button type="button" className="icon-btn ws-rail-action" aria-label="Find a workspace" title="Find a workspace" aria-haspopup="dialog" aria-expanded={!!searchAnchor} onClick={(e) => setSearchAnchor(anchorOf(e.currentTarget))}><Icon name="search" size={18} /></button>}
      {searchAnchor && <Popover anchor={searchAnchor} label="Find a workspace" className="ws-rail-search" onClose={() => { setSearchAnchor(null); setSearch(""); }}>
        <SearchField autoFocus type="search" className="ws-search" placeholder="Find a workspace…" aria-label="Find a workspace" value={search} onChange={(e) => setSearch(e.target.value)} />
        {workspaces.every((w) => !w.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="picker-muted" role="status">No matching workspace.</p>}
      </Popover>}
      <WorkspaceList disabled={locked || dirty || !!search} workspaces={workspaces.filter((w) => w.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))}>{(w) => <>
        <button type="button" className={`ws-directory-row${w.id === workspace?.id ? " current" : ""}`} aria-label={w.name} title={dirty ? `${w.name} — save your changes before selecting another workspace` : w.name} disabled={locked || dirty} aria-current={w.id === workspace?.id ? "true" : undefined} onClick={() => onSelect(w.id)}>
          <WorkspaceBadge workspace={w} />
        </button>
      </>}</WorkspaceList>
      <button type="button" className="icon-btn ws-rail-action ws-new" aria-label="New workspace" title="New workspace" disabled={locked || dirty} onClick={() => useWorkspaceDialog.getState().show("create")}><Icon name="plus" size={18} /></button>
      {dirty && <p className="sr-only" role="status">Save your changes before selecting another workspace.</p>}
    </section>}
    <form className="ws-profile" data-unsaved={dirty} onSubmit={(e) => { e.preventDefault(); if (locked || !draft.name.trim()) return; void run(async () => {
      const profile = { description: draft.description.trim(), accent: draft.accent, sidebarDensity: draft.sidebarDensity };
      if (creating) { await useWorkspace.getState().createWorkspace(draft.name.trim(), draft.icon?.trim() || null, profile, draft.image ?? undefined); rememberColor(draft.accent); close(); }
      else if (workspace) { await useWorkspace.getState().updateWorkspaceProfile(workspace.id, draft.name.trim(), draft.icon?.trim() || null, profile); rememberColor(draft.accent); setDraft((d) => ({ ...d, name: d.name.trim(), icon: d.icon?.trim() || null, description: d.description.trim() })); setMessage("Changes saved."); }
    }); }}>
      <fieldset disabled={locked}>
        <div className="ws-profile-heading"><WorkspaceBadge imageSrc={imagePreview} workspace={{ icon: draft.icon, settingsJson: JSON.stringify({ accent: draft.accent }) }} /><div><h3>{creating ? "Make a space of your own" : "Workspace details"}</h3><p className="picker-muted">{creating ? "Keep a project, work or personal notes together." : "Identify this space at a glance."}</p></div></div>
        <label className="field"><span>Name</span><input autoFocus required maxLength={200} value={draft.name} placeholder="e.g. Personal, Studio, Research" onChange={(e) => patch({ name: e.target.value })} /></label>
        <label className="field"><span>Description <small className="picker-muted">Optional</small></span><textarea maxLength={280} rows={2} value={draft.description} placeholder="What belongs in this workspace?" onChange={(e) => patch({ description: e.target.value })} /></label>
        <div className="field"><span>Icon</span><div className="ws-icon-choices" role="group" aria-label="Workspace icon">
          <button type="button" className="ws-icon-choice" aria-label="Use the Suivelle icon" aria-pressed={!draft.icon} onClick={() => patch({ icon: null })}><WorkspaceBadge workspace={null} /></button>
          {WORKSPACE_SYMBOLS.map((symbol) => <button type="button" className="ws-icon-choice" key={symbol} aria-label={`Use ${symbol} icon`} aria-pressed={draft.icon === `symbol:${symbol}`} onClick={() => patch({ icon: `symbol:${symbol}` })}><Icon name={symbol} size={18} /></button>)}
        </div><input className="ws-custom-field" maxLength={64} aria-label="Custom workspace icon" placeholder="Or an emoji or short text" value={draft.image || draft.icon?.startsWith("symbol:") || draft.icon?.startsWith("image:") ? "" : draft.icon ?? ""} onChange={(e) => patch({ icon: e.target.value || null })} />
        <details className="ws-emoji-picker" onToggle={(event) => setEmojiOpen(event.currentTarget.open)}><summary>Choose an emoji</summary>
          {emojiOpen && <EmojiPicker value={draft.icon} disabled={locked} onSelect={(icon) => patch({ icon })} />}
        </details>
        <input ref={fileInput} type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.svg,.apng" hidden onChange={(e) => {
          const file = e.currentTarget.files?.[0]; e.currentTarget.value = "";
          if (!file) return;
          if (!/\.(png|jpe?g|gif|webp|avif|bmp|svg|apng)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) { setError("Choose a supported image up to 10 MB."); return; }
          setError(null); patch({ image: file, icon: null });
        }} />
        <div className="ws-image-upload">{imageSelected && <WorkspaceBadge imageSrc={imagePreview} workspace={{ icon: draft.icon, settingsJson: "{}" }} />}<div><div className="ws-image-actions"><button type="button" className="btn" disabled={locked} onClick={() => void uploadIcon()}><Icon name="image" size={14} />{busy ? "Choosing image…" : imageSelected ? "Replace image…" : "Upload image…"}</button>{imageSelected && <button type="button" className="btn" onClick={() => patch({ icon: null })}>Remove image</button>}</div><p className="picker-muted">{creating ? "Choose an image up to 10 MB. Animated GIF, WebP and APNG keep playing." : "Images fill the icon. Animated GIF, WebP and APNG keep playing."}</p></div></div></div>
        <div className="field"><span>Icon color</span><div className="ws-color-choices" role="group" aria-label="Workspace icon color">{WORKSPACE_COLORS.map((color) => <button type="button" key={color} className="ws-color-choice" style={{ "--workspace-color": `var(--tone-${color})` } as CSSProperties} aria-label={color} aria-pressed={draft.accent === color} onClick={() => patch({ accent: color })}>{draft.accent === color && <Icon name="check" size={14} />}</button>)}<button type="button" className="btn ws-custom-color" aria-label="Choose custom icon color" aria-haspopup="dialog" onClick={openColorPicker}>{draft.accent.startsWith("#") && <span style={{ background: draft.accent }} />}{draft.accent.startsWith("#") ? draft.accent : "Custom…"}</button></div>{imageSelected && <p className="picker-muted ws-color-note">Color applies to symbols; uploaded images keep their original colors.</p>}</div>
        <div className="field"><span id="workspace-spacing-label">Sidebar spacing</span><div className="seg ws-spacing" role="radiogroup" aria-labelledby="workspace-spacing-label" onKeyDown={radioKeys}>{(["compact", "normal", "comfortable"] as const).map((spacing, i) => <button type="button" key={spacing} role="radio" aria-checked={draft.sidebarDensity === spacing} tabIndex={draft.sidebarDensity === spacing ? 0 : -1} className={draft.sidebarDensity === spacing ? "on" : ""} onClick={() => patch({ sidebarDensity: spacing })}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">{[12 - (i + 1) * 3, 12, 12 + (i + 1) * 3].map(y => <path key={y} d={`M5 ${y}h14`} />)}</svg><span>{spacing === "compact" ? "Compact" : spacing === "normal" ? "Normal" : "Comfortable"}</span></button>)}</div></div>
      </fieldset>
      {error && <p className="field-error" role="alert">{error}</p>}{message && <p className="ws-saved" role="status"><Icon name="check" size={14} />{message}</p>}
      <div className="ws-actions"><button className="btn primary" type="submit" disabled={locked || !draft.name.trim() || (!creating && !dirty)}>{locked ? "Saving…" : creating ? "Create workspace" : "Save changes"}</button>{creating && <button type="button" className="btn" disabled={locked} onClick={cancel}>Cancel</button>}</div>
      {!creating && <div className="ws-danger-zone"><h3>Workspace data</h3><p className="picker-muted">Transfer a workspace as a portable archive, or permanently remove this workspace.</p><div className="ws-data-actions"><button type="button" className="btn" disabled={locked || dirty} onClick={() => { close(); useTransferDialog.getState().show("import", "workspace"); }}><Icon name="download" size={14} />Import workspace…</button><button type="button" className="btn" disabled={locked || dirty || !workspace} onClick={() => { close(); useTransferDialog.getState().show("export", "workspace", workspace?.id); }}>Export workspace…</button><button type="button" className="btn danger" disabled={locked || dirty || !workspace || workspaces.length <= 1} onClick={() => useWorkspaceDialog.getState().show("delete")}><Icon name="trash" size={14} />Delete workspace…</button></div>{workspaces.length <= 1 && <p className="picker-muted">The last workspace is protected.</p>}</div>}
      {pickerColor && <ColorPicker initial={pickerColor} onUse={(accent) => patch({ accent })} onClose={() => setPickerColor(null)} preview={(accent) => <WorkspaceBadge workspace={{ icon: draft.icon?.startsWith("image:") ? "symbol:star" : draft.icon, settingsJson: JSON.stringify({ accent }) }} />} />}
    </form>
  </div>;
}

export function WorkspaceDialog() {
  const { open, mode } = useWorkspaceDialog();
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const [selectedId, setSelectedId] = useState(workspaceId);
  const busy = useWorkspace((s) => s.workspaceBusy);
  const ref = useRef<HTMLDialogElement>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  useEffect(() => { if (!open) { setDirty(false); setDiscarding(false); } else { setSelectedId(workspaceId); void useWorkspace.getState().refreshWorkspaces(); } }, [open]);
  useEffect(() => { const dialog = ref.current; if (!dialog) return; syncDialog(dialog, open); }, [open]);
  const close = () => { if (busy || operationBusy) return; if (dirty) setDiscarding(true); else useWorkspaceDialog.getState().hide(); };
  const finish = () => { useWorkspaceDialog.getState().hide(); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".ws-switcher")?.focus()); };
  return <dialog ref={ref} className={`palette ws-dialog${mode === "create" ? " ws-create-dialog" : ""}`} aria-labelledby="ws-dialog-title" aria-busy={busy || operationBusy} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }} onCancel={(e) => { e.preventDefault(); close(); }} onClose={() => useWorkspaceDialog.getState().hide()} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <header className="ws-dialog-head"><h2 id="ws-dialog-title">{mode === "create" ? "New workspace" : mode === "delete" ? "Delete workspace" : "Workspace settings"}</h2><button className="icon-btn" type="button" aria-label="Close workspace settings" disabled={busy || operationBusy} onClick={close}><Icon name="close" /></button></header>
    {discarding && <div className="ws-discard" role="alert"><strong>Discard unsaved changes?</strong><span>Your saved workspace stays unchanged.</span><div><button type="button" className="btn" autoFocus onClick={() => setDiscarding(false)}>Keep editing</button><button type="button" className="btn danger" onClick={finish}>Discard changes</button></div></div>}
    {open && <Body key={`${mode}:${selectedId}`} mode={mode} selectedId={selectedId} onSelect={setSelectedId} onDirty={setDirty} onBusy={setOperationBusy} close={finish} cancel={close} />}
  </dialog>;
}
