import { BackupMirror, HealthSection } from "./HealthSection";
import { DiagnosticsButton } from "../../components/DiagnosticsButton";
import { ShortcutSettings } from "../shortcuts/ShortcutSettings";
import { useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { BrandMark } from "../../components/BrandMark";
import { Icon, type IconName } from "../../components/Icon";
import { CHOICES, parseUiScale, UI_SCALE_MIN, UI_SCALE_MAX, usePreferences, type ChoiceKey, type ShellChoices } from "../../stores/preferences";
import { useWorkspace } from "../../stores/workspace";
import type { ThemeSetting } from "../../types";
import { useBackupsDialog } from "../backup/store";
import { useFilesDialog } from "../files/store";
import { syncDialog } from "../../lib/dialog";
import "./settings.css";
import { UpdatesSection } from "../updates/Updates";
import { ThemeEditor } from "./ThemeEditor";
import { useThemes } from "./themes";
import { radioKeys } from "./radioKeys";
import type { PaletteMode } from "./theme";
import { READ_ONLY } from "../../lib/access";
import { seedGettingStarted } from "../onboarding/gettingStarted";

const PAGES: { id: string; title: string; icon: IconName }[] = [
  { id: "appearance", title: "Appearance", icon: "sun" },
  { id: "layout", title: "Layout and motion", icon: "dashboard" },
  { id: "editor", title: "Editor", icon: "text" },
  { id: "window", title: "Window and startup", icon: "monitor" },
  { id: "keyboard", title: "Shortcuts and input", icon: "keyboard" },
  { id: "data", title: "Data and backups", icon: "layers" },
  { id: "updates", title: "Updates", icon: "download" },
  { id: "about", title: "About", icon: "note" },
];

function SettingsPage({ id, active, children }: { id: string; active: string; children: React.ReactNode }) {
  return <section className="set-panel" data-settings-page={id} id={`settings-panel-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} hidden={id !== active} tabIndex={0}>{children}</section>;
}

function DiscardPrompt({ children, onContinue }: { children: React.ReactNode; onContinue: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (ref.current) syncDialog(ref.current, true); }, []);
  return <dialog ref={ref} className="palette set-discard" role="alertdialog" aria-labelledby="theme-discard-title" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onContinue(); }}>{children}</dialog>;
}

import { useSettingsDialog } from "./store";
export { useSettingsDialog } from "./store";


declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string, IconName?][]; onChange: (v: T) => void }) {
  const tabStop = options.some(([id]) => id === value) ? value : options[0]?.[0];
  return (
    <div className="seg" role="radiogroup" aria-label={label} onKeyDown={radioKeys}>
      {options.map(([id, text, icon]) => (
        <button key={id} role="radio" tabIndex={tabStop === id ? 0 : -1} aria-checked={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          {icon && <Icon name={icon} />}{text}
        </button>
      ))}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/** One reading or layout preference, drawn from the table in the preferences store. */
function ChoiceRow({ k }: { k: ChoiceKey }) {
  const value = usePreferences((s) => s[k]);
  const set = usePreferences((s) => s.set);
  const c = CHOICES[k];
  return (
    <Row title={c.title} hint={c.hint}>
      <Segmented<string> label={c.title} value={value} options={c.options.map((o) => [o.id, o.label])} onChange={(id) => set(k, id)} />
    </Row>
  );
}

function InterfaceSizeRow() {
  const value = usePreferences((s) => s.uiScale);
  const set = usePreferences((s) => s.set);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState(false);
  useEffect(() => { setDraft(value); setError(false); }, [value]);
  const c = CHOICES.uiScale;
  return <Row title={c.title} hint={c.hint}>
    <div className="set-scale">
      <Segmented<string> label={c.title} value={value} options={c.options.map((o) => [o.id, o.label])} onChange={(id) => set("uiScale", id)} />
      <form className="set-scale-custom" noValidate onSubmit={(e) => {
        e.preventDefault();
        const scale = parseUiScale(draft);
        setError(scale === null);
        if (scale !== null) { set("uiScale", scale); setDraft(scale); }
      }}>
        <label htmlFor="custom-ui-scale">Custom</label>
        <div className="set-scale-field">
          <input id="custom-ui-scale" type="number" inputMode="numeric" min={UI_SCALE_MIN} max={UI_SCALE_MAX} step={1}
            aria-label="Custom interface size" aria-invalid={error} aria-describedby="custom-ui-scale-hint" value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(false); }} />
          <span aria-hidden="true">%</span>
        </div>
        <button type="submit" className="btn">Apply size</button>
      </form>
      <p id="custom-ui-scale-hint" className={error ? "field-error" : "set-hint"} role={error ? "alert" : undefined}>
        {error ? `Enter a whole number from ${UI_SCALE_MIN} to ${UI_SCALE_MAX}.` : `${UI_SCALE_MIN}–${UI_SCALE_MAX}%. Press Enter or Apply size.`}
      </p>
    </div>
  </Row>;
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
    </label>
  );
}

function WindowCornersRow() {
  const style = usePreferences((s) => s.windowCorners);
  const setStyle = usePreferences((s) => s.setWindowCorners);
  return <Row title="Window corners" hint="Choose square, subtle or full rounding. Windows 11 only; maximized and snapped windows stay square.">
    <div className="set-window-corners"><Segmented label="Window corners" value={style} options={[["sharp", "Sharp", "corner-sharp"], ["soft", "Soft", "corner-soft"], ["round", "Round", "corner-round"]]} onChange={setStyle} /></div>
  </Row>;
}

/** Starting with the computer, the tray icon, and what closing or minimizing the window does. */
function WindowSection() {
  const shell = usePreferences((s) => s.shell);
  const setShell = usePreferences((s) => s.setShell);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Start-with-computer can be changed outside the app, so ask the system.
    ipc.shellGetBehavior().then((b) => setShell(b)).catch(() => undefined);
  }, [setShell]);

  const change = (patch: Partial<ShellChoices>) => {
    const next = { ...shell, ...patch };
    setError(null);
    ipc
      .shellSetBehavior(next)
      .then(() => setShell(next))
      .catch((err) => setError(toAppError(err).message));
  };
  const trayForced = shell.closeToTray || shell.minimizeToTray;

  return (
    <section>
      <h3>Window and startup</h3>
      <Row title="Start with Windows" hint="Open Suivelle when you sign in.">
        <Switch label="Start with Windows" checked={shell.launchAtStartup} onChange={(on) => change({ launchAtStartup: on })} />
      </Row>
      <Row title="Start minimized to the tray" hint="When it starts with Windows, stay out of the way until you open it.">
        <Switch label="Start minimized to the tray" checked={shell.startMinimized} disabled={!shell.launchAtStartup} onChange={(on) => change({ startMinimized: on })} />
      </Row>
      <Row title="Show a tray icon" hint={trayForced ? "Always shown while closing or minimizing to the tray is on." : "Keep an icon in the notification area."}>
        <Switch label="Show a tray icon" checked={shell.showTray || trayForced} disabled={trayForced} onChange={(on) => change({ showTray: on })} />
      </Row>
      <Row title="Close to the tray" hint="The close button hides the window and keeps Suivelle running. Quit from the tray menu.">
        <Switch label="Close to the tray" checked={shell.closeToTray} onChange={(on) => change({ closeToTray: on })} />
      </Row>
      <Row title="Minimize to the tray" hint="Minimizing hides the window instead of leaving it on the taskbar.">
        <Switch label="Minimize to the tray" checked={shell.minimizeToTray} onChange={(on) => change({ minimizeToTray: on })} />
      </Row>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SettingsBody() {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const [creatingStarter, setCreatingStarter] = useState(false);
  const [starterError, setStarterError] = useState<string | null>(null);
  const legacyTheme = useWorkspace((s) => s.settings.theme);
  const theme = usePreferences((s) => s.theme) ?? legacyTheme;
  const autoBackup = useWorkspace((s) => s.settings.autoBackup);
  const setTheme = usePreferences((s) => s.setTheme);
  const setAutoBackup = useWorkspace((s) => s.setAutoBackup);
  const initialSection = useSettingsDialog((s) => s.section);
  const [page, setPage] = useState<string>(initialSection ?? "appearance");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ page: string; title: string; element: HTMLElement }[]>([]);
  const committed = useThemes((s) => s.config);
  const [draft, setDraft] = useState(committed);
  const [draftMode, setDraftMode] = useState<PaletteMode | null>(null);
  const [preview, setPreview] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const content = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const [horizontalTabs, setHorizontalTabs] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(committed) || draftMode !== null;
  const close = (after?: () => void) => useSettingsDialog.getState().requestClose(after);
  const addGettingStarted = async () => {
    if (!workspaceId || READ_ONLY || creatingStarter) return;
    setCreatingStarter(true);
    setStarterError(null);
    try {
      const created = await seedGettingStarted(workspaceId);
      if (useWorkspace.getState().workspace?.id !== workspaceId) return;
      await useWorkspace.getState().reloadTree();
      close(() => {
        if (useWorkspace.getState().workspace?.id === workspaceId) void useWorkspace.getState().selectPage(created.id);
      });
    } catch (e) {
      setStarterError(toAppError(e).message);
    } finally {
      setCreatingStarter(false);
    }
  };
  const finish = () => { useThemes.getState().setPreview(null); useSettingsDialog.getState().finishClose(afterClose.current); };
  const apply = () => {
    const invalid = content.current?.querySelector<HTMLInputElement>(".theme-color-control input[aria-invalid='true']");
    if (invalid) {
      setSaveError("Correct the invalid hex color before applying your theme."); setPage("appearance"); setQuery("");
      const details = invalid.closest("details"); if (details) details.open = true;
      requestAnimationFrame(() => invalid.focus()); return false;
    }
    try { useThemes.getState().apply(draft); if (draftMode) setTheme(draftMode); setDraftMode(null); setSaveError(null); return true; }
    catch { setSaveError("Could not save the theme on this device. Export your theme, or try Apply again."); return false; }
  };
  useEffect(() => { if (initialSection) setPage(initialSection); }, [initialSection]);
  useEffect(() => {
    const shell = nav.current?.closest(".set-shell");
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setHorizontalTabs(entry.contentRect.width <= 700));
    observer.observe(shell); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    useThemes.getState().setPreview(dirty && preview ? draft : null);
  }, [draft, dirty, preview]);
  useEffect(() => () => useThemes.getState().setPreview(null), []);
  useEffect(() => {
    useSettingsDialog.setState({ closeGuard: dirty ? (after) => { afterClose.current = after; setConfirmClose(true); } : null });
    return () => useSettingsDialog.setState({ closeGuard: null });
  }, [dirty]);
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const terms = query.trim().toLowerCase().split(/\s+/);
    const matches: typeof results = [];
    content.current?.querySelectorAll<HTMLElement>(".set-row, .theme-color-row, .set-panel h3").forEach((element) => {
      if (!terms.every((term) => element.textContent?.toLowerCase().includes(term))) return;
      const owner = element.closest<HTMLElement>("[data-settings-page]")?.dataset.settingsPage;
      const title = element.querySelector(".set-title, label")?.textContent ?? element.textContent;
      if (owner && title) matches.push({ page: owner, title, element });
    });
    setResults(matches.slice(0, 20));
  }, [query]);

  return (
    <>
      <div className="set-head">
        <h2>Settings</h2>
        <button className="icon-btn" aria-label="Close settings" onClick={() => close()}>
          <Icon name="close" />
        </button>
      </div>
      <div className="set-shell">
        <aside className="set-nav">
          <label className="set-search"><Icon name="search" /><input aria-label="Search settings" placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <div ref={nav} role="tablist" aria-label="Settings pages" aria-orientation={horizontalTabs ? "horizontal" : "vertical"} onKeyDown={(e) => {
            const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
            if (!keys.includes(e.key)) return;
            e.preventDefault();
            const index = PAGES.findIndex((item) => item.id === page);
            const next = e.key === "Home" ? 0 : e.key === "End" ? PAGES.length - 1 : (index + (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1) + PAGES.length) % PAGES.length;
            setPage(PAGES[next].id); document.getElementById(`settings-tab-${PAGES[next].id}`)?.focus();
          }}>{PAGES.map((item) => <button type="button" role="tab" id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={page === item.id} tabIndex={page === item.id ? 0 : -1} key={item.id} onClick={() => { setPage(item.id); setQuery(""); }}><Icon name={item.icon} />{item.title}</button>)}</div>
          <p className="set-nav-note">Your workspace.<br />Your way.</p>
        </aside>
      <div className="set-body" ref={content}>
        {query.trim() && <div className="set-search-results" role="region" aria-label="Settings search results"><h3>Search results</h3><p className="set-hint" role="status">{results.length ? `${results.length} matching settings` : "No settings match. Try theme, font, tray, or backup."}</p>{results.map((result, i) => <button className="set-search-result" key={i} onClick={() => { setPage(result.page); setQuery(""); requestAnimationFrame(() => { const details = result.element.closest("details"); if (details) details.open = true; result.element.scrollIntoView({ block: "center" }); (result.element.querySelector<HTMLElement>("input, button, select") ?? result.element).focus(); }); }}><span>{result.title}</span><small>{PAGES.find((item) => item.id === result.page)?.title}</small></button>)}</div>}
        <SettingsPage id="appearance" active={query.trim() ? "search" : page}>
          <h3>Appearance</h3>
          <Row title="Theme mode" hint="For the whole application. System follows your Windows setting.">
            <Segmented<ThemeSetting>
              label="Theme"
              value={theme}
              options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]}
              onChange={(v) => void setTheme(v)}
            />
          </Row>
          <ThemeEditor config={draft} onChange={(config, mode) => { setDraft(config); if (mode) setDraftMode(mode); }} preview={preview} onPreview={setPreview} />
        </SettingsPage>
        <SettingsPage id="layout" active={query.trim() ? "search" : page}>
          <h3>Layout and motion</h3>
          <ChoiceRow k="corners" />
          <WindowCornersRow />
          <ChoiceRow k="lines" />
          <ChoiceRow k="density" />
          <InterfaceSizeRow />
          <ChoiceRow k="motion" />
          <div className="set-reset"><button className="btn ghost" onClick={() => { for (const key of ["corners", "lines", "density", "uiScale", "motion"] as const) usePreferences.getState().set(key, CHOICES[key].fallback); usePreferences.getState().setWindowCorners("soft"); }}>Restore default layout</button></div>
        </SettingsPage>

        <SettingsPage id="editor" active={query.trim() ? "search" : page}>
          <h3>Editor</h3>
          <ChoiceRow k="textSize" />
          <ChoiceRow k="pageWidth" />
          <ChoiceRow k="pageSpacing" />
          <ChoiceRow k="pageFont" />
          <div className="set-preview doc-sample" aria-hidden="true">
            <strong>A page reads like this</strong>
            <p>Notes, plans and wikis share one calm column. Change the size, width, spacing or typeface above and this sample follows.</p>
            <p>A second paragraph shows the space between blocks.</p>
          </div>
          <div className="set-reset">
            <button className="btn ghost" onClick={() => { for (const key of ["textSize", "pageWidth", "pageSpacing", "pageFont"] as const) usePreferences.getState().set(key, CHOICES[key].fallback); }}>
              Restore default reading settings
            </button>
          </div>
        </SettingsPage>

        <SettingsPage id="window" active={query.trim() ? "search" : page}><WindowSection /></SettingsPage>

        <SettingsPage id="data" active={query.trim() ? "search" : page}>
          <h3>Data and backups</h3>
          <Row title="Back up automatically" hint="A verified copy is kept every day.">
            <label className="switch">
              <input type="checkbox" checked={autoBackup} onChange={(e) => void setAutoBackup(e.target.checked)} aria-label="Back up automatically" />
              <span className="switch-track" aria-hidden="true" />
            </label>
          </Row>
          <Row title="Files" hint="See every file in this workspace and clear out the ones nothing uses.">
            <button
              className="btn"
              onClick={() => {
                close(() => useFilesDialog.getState().show());
              }}
            >
              Manage files…
            </button>
          </Row>
          <Row title="Second copy" hint="Also save each automatic backup to another folder, such as an external drive. If it is unavailable, backups continue here.">
            <BackupMirror />
          </Row>
          <Row title="Backups" hint="Create, check or restore a backup.">
            <button
              className="btn"
              onClick={() => {
                close(() => useBackupsDialog.getState().show());
              }}
            >
              Open backups…
            </button>
          </Row>
          <h3>Storage health</h3>
          <p className="set-hint">Everything stored on this computer, across all workspaces.</p>
          <HealthSection active={page === "data" && !query.trim()} />
        </SettingsPage>

        <SettingsPage id="keyboard" active={query.trim() ? "search" : page}>
          <h3>Shortcuts and input</h3>
          <ShortcutSettings active={page === "keyboard" && !query.trim()} />
        </SettingsPage>

        <SettingsPage id="updates" active={query.trim() ? "search" : page}><UpdatesSection /></SettingsPage>
        <SettingsPage id="about" active={query.trim() ? "search" : page}>
          <h3>About</h3>
          <div className="set-about">
            <BrandMark size={48} />
            <div>
              <div className="set-about-name">Suivelle</div>
              <div className="set-about-tag">A universe for your thoughts.</div>
              <div className="set-hint">{VERSION ? `Version ${VERSION}. ` : ""}Your notes and data stay on this computer.</div>
            </div>
          </div>
          <Row title="Getting started" hint="Add a fresh copy of the introductory checklist to your current workspace.">
            <button type="button" className="btn" disabled={!workspaceId || READ_ONLY || creatingStarter} onClick={() => void addGettingStarted()}>
              {creatingStarter ? "Creating…" : "Add Getting started page"}
            </button>
          </Row>
          {starterError && <p className="field-error" role="alert">{starterError}</p>}
          <Row title="Diagnostic report" hint="Versions, storage sizes and the recent log, to attach to a bug report. It never includes your notes.">
            <DiagnosticsButton />
          </Row>
        </SettingsPage>
      </div>
      </div>
      <footer className="set-footer">
        <div><span role="status">{dirty ? "Theme preview · unsaved changes" : "Settings saved"}</span>{saveError && <p className="field-error" role="alert">{saveError}</p>}</div>
        {dirty && <><button className="btn" onClick={() => { setDraft(committed); finish(); }}>Cancel</button><button className="btn primary" onClick={() => apply()}>Apply</button></>}
        {!dirty && <button className="btn" onClick={() => close()}>Done</button>}
      </footer>
      {confirmClose && <DiscardPrompt onContinue={() => setConfirmClose(false)}><h3 id="theme-discard-title">Keep your theme changes?</h3><p>Apply saves your colors. Discard restores the saved theme.</p><div><button autoFocus className="btn" onClick={() => setConfirmClose(false)}>Continue editing</button><button className="btn" onClick={finish}>Discard</button><button className="btn primary" onClick={() => { if (apply()) finish(); else setConfirmClose(false); }}>Apply and close</button></div>{saveError && <p className="field-error" role="alert">{saveError}</p>}</DiscardPrompt>}
    </>
  );
}

/** Preferences, one dialog. Opened from the sidebar, the palette, or Ctrl/Cmd+,. */
export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="palette settings"
      aria-label="Settings"
      onClose={(e) => { if (e.target === e.currentTarget) useSettingsDialog.getState().hide(); }}
      onCancel={(e) => { if (e.target !== e.currentTarget) return; e.preventDefault(); useSettingsDialog.getState().requestClose(); }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useSettingsDialog.getState().hide();
      }}
    >
      {open && <SettingsBody />}
    </dialog>
  );
}
