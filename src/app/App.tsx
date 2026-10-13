import { installGlobalShortcutSync } from "../features/shortcuts/native";
import { installInputRouter } from "../features/shortcuts/runtime";
import { COMMANDS } from "../features/palette/commands";
import { useFilesDialog } from "../features/files/store";
import { UpdatesRoot } from "../features/updates/Updates";
import { isPreparing, useUpdates } from "../features/updates/store";
import { READ_ONLY, READ_ONLY_COMMANDS } from "../lib/access";
import { safeModeReason } from "../lib/safeMode";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useWorkspaceDialog } from "../features/workspaces/store";
import { useOutline } from "../features/outline/store";
import { useExplore } from "../features/explore/store";
import { usePeek } from "../features/peek/store";
import { installReminderToasts } from "../features/explore/events";
import { installTrayRecent } from "../features/session/trayRecent";
import { installDeepLinks } from "../features/session/deepLinks";
import { registerFlusher } from "../features/editor/flushRegistry";
import { AppContextMenu } from "../components/AppContextMenu";
import { Titlebar } from "../components/Titlebar";
import { Toast } from "../components/Toast";
import { Palette } from "../features/palette/Palette";
import { useBackupsDialog } from "../features/backup/store";
import { useHistoryPanel } from "../features/history/store";
import { usePalette } from "../features/palette/store";
import { Sidebar } from "../features/pages/Sidebar";
import { Topbar } from "../features/pages/Topbar";
import { TrashView } from "../features/pages/TrashView";
import { BrandMark } from "../components/BrandMark";
import { Icon } from "../components/Icon";
import { ErrorBoundary } from "./ErrorBoundary";
import { useShortcut } from "../features/shortcuts/useShortcut";
import { useTemplateGallery } from "../features/templates/store";
import { useTransferDialog } from "../features/transfer/store";
import { PageCover, PageIconRow } from "../features/pages/PageHeader";
import { SidebarResizer } from "../features/pages/SidebarResizer";
import { installSessionPersistence } from "../features/session/persist";
import { installFileDropGuard } from "../features/session/fileDropGuard";
import { ShortcutSheet } from "../features/shortcuts/ShortcutSheet";
import { useSettingsDialog } from "../features/settings/store";
import { QuickCapture } from "../features/capture/QuickCapture";
import { installCaptureWindowBridge } from "../features/capture/window";
import { ipc, toAppError } from "../lib/ipc";
import { useFindBar } from "../features/find/store";
import { TabBar } from "../features/tabs/TabBar";
import { closeTab, cycleTab, installTabs, useTabs } from "../features/tabs/tabs";
import { installMotion } from "../features/motion/install";
import { installTooltips } from "../features/tooltip/tooltip";
import { useAppIcon } from "../lib/appIcon";
import { useAppearance } from "../lib/appearance";
import { usePreferences } from "../stores/preferences";
import { sidebarHidden, sidebarRail, useLayout } from "../stores/layout";
import { useWorkspace } from "../stores/workspace";
import { Loading } from "../components/Loading";
import { PageTransferDialog, usePageTransfer } from "../features/pages/PageTransferDialog";

// The editor (TipTap, KaTeX, syntax highlighting) is the heavy part; load it after the shell is up.
const RecordProperties = lazy(() => import("../features/database/RecordProperties").then((m) => ({ default: m.RecordProperties })));
const Editor = lazy(() => import("../features/editor/Editor").then((m) => ({ default: m.Editor })));

const SettingsDialog = lazy(() => import("../features/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const WorkspaceDialog = lazy(() => import("../features/workspaces/WorkspaceDialog").then((m) => ({ default: m.WorkspaceDialog })));
const PeekPanel = lazy(() => import("../features/peek/PeekPanel").then((m) => ({ default: m.PeekPanel })));
const ExploreDialog = lazy(() => import("../features/explore/ExploreDialog").then((m) => ({ default: m.ExploreDialog })));
const OutlinePanel = lazy(() => import("../features/outline/OutlinePanel").then((m) => ({ default: m.OutlinePanel })));
const BackupsDialog = lazy(() => import("../features/backup/BackupsDialog").then((m) => ({ default: m.BackupsDialog })));
const TransferDialog = lazy(() => import("../features/transfer/TransferDialog").then((m) => ({ default: m.TransferDialog })));
const HistoryPanel = lazy(() => import("../features/history/HistoryPanel").then((m) => ({ default: m.HistoryPanel })));
const TemplateGallery = lazy(() => import("../features/templates/TemplateGallery").then((m) => ({ default: m.TemplateGallery })));
const FilesDialog = lazy(() => import("../features/files/FilesDialog").then((m) => ({ default: m.FilesDialog })));
const FindBar = lazy(() => import("../features/find/FindBar").then((m) => ({ default: m.FindBar })));
const DatabaseView = lazy(() => import("../features/database/DatabaseView").then((m) => ({ default: m.DatabaseView })));
const DashboardView = lazy(() => import("../features/dashboard/DashboardView").then((m) => ({ default: m.DashboardView })));

/** Load a feature on first use, then keep its shell so dialog exit and focus restoration still run. */
/** Shown when the workspace opened read-only because its check or upgrade failed. */
function SafeModeBanner() {
  const reason = safeModeReason();
  if (!reason) return null;
  return <div className="safe-mode-banner" role="alert">
    <p><strong>Opened read-only to protect your data.</strong> {reason}. Nothing has been changed. Save a copy with Export, or restore an earlier backup.</p>
    <div className="safe-mode-actions">
      <button type="button" className="btn" onClick={() => useTransferDialog.getState().show("export", "workspace")}>Export workspace…</button>
      <button type="button" className="btn" onClick={() => useBackupsDialog.getState().show()}>Backups…</button>
    </div>
  </div>;
}

function OnDemand({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(open);
  useEffect(() => { if (open) setLoaded(true); }, [open]);
  return loaded || open ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/** True while focus is somewhere the user types, where single-key shortcuts must not fire. */


function PageTitle() {
  const page = useWorkspace((s) => s.selectedPage);
  const renamePage = useWorkspace((s) => s.renamePage);
  const [title, setTitle] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const id = page?.id;
  const draft = useRef(title);
  draft.current = title;

  useEffect(() => setTitle(page?.title ?? ""), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const unregister = registerFlusher(async () => {
      window.clearTimeout(timer.current);
      if (id && draft.current !== useWorkspace.getState().selectedPage?.title) await renamePage(id, draft.current, { strict: true });
    });
    return () => { window.clearTimeout(timer.current); unregister(); };
  }, [id, renamePage]);
  if (!page) return null;

  const commit = (t: string) => {
    if (READ_ONLY) return;
    window.clearTimeout(timer.current);
    if (t !== page.title) void renamePage(page.id, t);
  };

  return (
    <>
    <PageCover page={page} />
    <div className="page-title" data-context-page={page.id}>
      <PageIconRow page={page} />
      <input
        readOnly={READ_ONLY}
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        maxLength={500}
        onChange={(e) => {
          setTitle(e.target.value);
          window.clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = window.setTimeout(() => commit(v), 500);
        }}
        onBlur={() => commit(title)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(title);
            document.querySelector<HTMLElement>(".doc")?.focus();
          }
        }}
      />
    </div>
    </>
  );
}

function Content() {
  const searchBinding = useShortcut("search");
  const newPageBinding = useShortcut("new-page");
  const view = useWorkspace((s) => s.view);
  const selectedPageId = useWorkspace((s) => s.selectedPageId);
  const kind = useWorkspace((s) => s.selectedPage?.kind ?? "page");
  const hasPages = useWorkspace((s) => (s.children.root?.length ?? 0) > 0);
  const ready = useWorkspace((s) => s.ready);
  const createPage = useWorkspace((s) => s.createPage);
  const epoch = useWorkspace((s) => s.editorEpoch);

  if (view === "trash") return <TrashView />;
  if (selectedPageId && kind === "dashboard") {
    return (
      <>
        <PageTitle />
        <DashboardView key={selectedPageId} pageId={selectedPageId} />
      </>
    );
  }
  if (selectedPageId && kind === "database") {
    return (
      <>
        <PageTitle />
        <DatabaseView key={selectedPageId} pageId={selectedPageId} />
      </>
    );
  }
  if (selectedPageId) {
    return (
      <>
        <PageTitle />
        <Suspense fallback={null}>
          {kind === "record" && <RecordProperties key={`props-${selectedPageId}`} pageId={selectedPageId} />}
          <Editor key={`${selectedPageId}:${epoch}`} pageId={selectedPageId} />
        </Suspense>
      </>
    );
  }
  if (!ready) return null;
  return hasPages ? (
    <p className="empty">Select a page from the sidebar{searchBinding.label ? `, or press ${searchBinding.label} to search.` : "."}</p>
  ) : (
    <div className="empty-start">
      <ConstellationArt />
      <h1>Welcome to Suivelle</h1>
      <p className="empty-tagline">A universe for your thoughts.</p>
      <p>Pages nest inside pages. Create notes, docs and plans, and connect them as your workspace grows.</p>
      <button className="btn primary" onClick={() => void createPage(null)}>
        <Icon name="page" />
        Create a new page
        <Icon name="forward" />
      </button>
      <div className="empty-actions">
        <button className="btn" onClick={() => void useWorkspace.getState().createDatabase(null)}>
          <Icon name="table" />
          New database
        </button>
        <button className="btn" onClick={() => void useWorkspace.getState().createDashboard(null)}>
          <Icon name="dashboard" />
          New dashboard
        </button>
        <button className="btn" onClick={() => useTemplateGallery.getState().show()}>
          <Icon name="layers" />
          From template
        </button>
        <button className="btn" onClick={() => useTransferDialog.getState().show()}>
          <Icon name="download" />
          Import
        </button>
        <button className="btn" onClick={() => useTransferDialog.getState().show("import", "workspace")}>
          <Icon name="layers" />
          Import workspace…
        </button>
      </div>
      <p className="empty-hint">
        {newPageBinding.label && <><kbd className="kbd">{newPageBinding.label}</kbd> new page </>}{searchBinding.label && <><kbd className="kbd">{searchBinding.label}</kbd> search</>}
      </p>
    </div>
  );
}

/** A quiet constellation around the mark: a few stars joined by hairlines, nothing that moves or glows. */
function ConstellationArt() {
  return (
    <div className="empty-art" aria-hidden="true">
      <svg viewBox="0 0 260 168" width="260" height="168" fill="none">
        <g stroke="var(--border-strong)" strokeWidth="1">
          <path d="M20 118 L62 70 L104 96" />
          <path d="M156 92 L196 52 L240 74" />
          <path d="M196 52 L214 126" />
        </g>
        <g fill="var(--text-muted)">
          <circle cx="20" cy="118" r="2.5" />
          <circle cx="62" cy="70" r="3" />
          <circle cx="104" cy="96" r="2" />
          <circle cx="156" cy="92" r="2" />
          <circle cx="196" cy="52" r="3.5" />
          <circle cx="240" cy="74" r="2.5" />
          <circle cx="214" cy="126" r="2" />
        </g>
      </svg>
      <span className="empty-mark"><BrandMark size={64} tile={false} /></span>
    </div>
  );
}

export function App() {
  const updatePreparing = useUpdates((s) => isPreparing(s.phase));
  const SettingsDialogOpen = useSettingsDialog((s) => s.open);
  const BackupsDialogOpen = useBackupsDialog((s) => s.open);
  const WorkspaceDialogOpen = useWorkspaceDialog((s) => s.open);
  const outlineOpen = useOutline((s) => s.open);
  const exploreOpen = useExplore((s) => !!s.panel);
  const peekOpen = usePeek((s) => !!s.pageId);
  const TransferDialogOpen = useTransferDialog((s) => s.open);
  const HistoryPanelOpen = useHistoryPanel((s) => s.open);
  const TemplateGalleryOpen = useTemplateGallery((s) => s.open);
  const FilesDialogOpen = useFilesDialog((s) => s.open);
  const FindBarOpen = useFindBar((s) => s.open);

  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const workspaceBusy = useWorkspace((s) => s.workspaceBusy);
  const init = useWorkspace((s) => s.init);
  const legacyTheme = useWorkspace((s) => s.settings.theme);
  const workspaceReady = useWorkspace((s) => s.ready);
  const appTheme = usePreferences((s) => s.theme);
  const theme = appTheme ?? legacyTheme;
  const error = useWorkspace((s) => s.error);
  const clearError = useWorkspace((s) => s.clearError);
  const isDatabase = useWorkspace((s) => s.view === "page" && (s.selectedPage?.kind === "database" || s.selectedPage?.kind === "dashboard"));

  useEffect(() => void init(), [init]);
  useEffect(() => {
    if (workspaceReady) usePreferences.getState().adoptTheme(legacyTheme);
  }, [workspaceReady, legacyTheme]);
  useEffect(() => {
    usePalette.getState().hide();
    useHistoryPanel.getState().hide();
    useBackupsDialog.getState().hide();
    useTransferDialog.getState().hide();
    useTemplateGallery.getState().hide();
    usePageTransfer.getState().hide();
  }, [workspaceId]);
  useEffect(() => installSessionPersistence(), []);
  useEffect(() => installFileDropGuard(), []);
  useEffect(() => installTabs(), []);
  useEffect(() => installReminderToasts(), []);
  useEffect(() => installTrayRecent(), []);
  useEffect(() => installDeepLinks(), []);

  // The global shortcut opens a separate jot window; saves use this workspace and editor.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    installCaptureWindowBridge()
      .then((un) => {
        if (cancelled) { un(); return; }
        stop = un;
        void ipc.shortcutsMigrate(usePreferences.getState().globalCapture).then(state => {
          usePreferences.getState().setGlobalCapture(state.config.captureEnabled);
        }).catch(() => undefined);
      })
      .catch(() => undefined); // not running inside the desktop app
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  // Keep the desktop shell in step with this device's window choices, and show what is really set.
  useEffect(() => {
    void ipc
      .shellGetBehavior().then(shell => { usePreferences.getState().setShell(shell); })
      .catch(() => undefined); // not running inside the desktop app
  }, []);
  const sidebarWidth = useLayout((s) => s.width);
  const collapsed = useLayout(sidebarHidden);
  const rail = useLayout(sidebarRail);
  const compact = useLayout((s) => s.compact);
  const focus = useLayout((s) => s.focus);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => useLayout.getState().setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    // Keep keyboard focus on a visible control when either panel is hidden.
    const active = document.activeElement;
    if (collapsed && active?.closest(".sidebar")) document.querySelector<HTMLButtonElement>(rail ? ".sidebar-collapse" : ".sidebar-toggle")?.focus();
    else if (compact && !collapsed) document.querySelector<HTMLButtonElement>(".sidebar-collapse")?.focus();
  }, [collapsed, compact, rail]);
  useEffect(() => useWorkspace.subscribe((state, previous) => {
    if (state.selectedPageId !== previous.selectedPageId || state.view !== previous.view) {
      useLayout.setState({ compactOpen: false });
    }
  }), []);
  useAppearance();
  useEffect(() => installTooltips(), []);
  useEffect(() => installGlobalShortcutSync(), []);
  useEffect(() => installMotion(), []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
  useAppIcon(theme);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useWorkspace.getState();
      if (isPreparing(useUpdates.getState().phase) || s.workspaceBusy || (document.querySelector("dialog[open]") && !usePalette.getState().open)) return;
      if (e.key === "Escape" && useLayout.getState().compact && !sidebarHidden(useLayout.getState()) && !document.querySelector("dialog[open], [data-popover]")) {
        e.preventDefault();
        useLayout.setState({ compactOpen: false });

      }
    };
    const run = (id: string) => {
      const command = COMMANDS.find(c => c.id === id);
      if (!command || (command.when && !command.when())) return false;
      if (READ_ONLY && !READ_ONLY_COMMANDS.has(id)) return false;
      void Promise.resolve(command.run()).catch(e => useWorkspace.getState().setError(toAppError(e).message));
      return true;
    };
    const stop = installInputRouter({
      ...Object.fromEntries(COMMANDS.map(c => [c.id, () => run(c.id)])),
      search: () => { usePalette.getState().toggle(); },
      "next-tab": () => { if (useTabs.getState().ids.length < 2) return false; void cycleTab(1); },
      "previous-tab": () => { if (useTabs.getState().ids.length < 2) return false; void cycleTab(-1); },
      "close-tab": () => { const s = useWorkspace.getState(); if (!s.selectedPageId || useTabs.getState().ids.length < 2) return false; void closeTab(s.selectedPageId); },
    }, () => !isPreparing(useUpdates.getState().phase) && !useWorkspace.getState().workspaceBusy);
    window.addEventListener("keydown", onKey, true);
    return () => { stop(); window.removeEventListener("keydown", onKey, true); };
  }, []);

  return (
    <div className="app-frame">
    <Titlebar />
    <div
      className="shell"
      key={workspaceId}
      inert={workspaceBusy || updatePreparing}
      aria-busy={workspaceBusy || updatePreparing}
      data-collapsed={collapsed && !rail ? "" : undefined}
      data-rail={rail ? "" : undefined}
      data-focus={focus ? "" : undefined}
      data-compact={compact ? "" : undefined}
      style={sidebarWidth ? ({ "--sidebar-w": `min(${sidebarWidth}px, 45vw)` } as React.CSSProperties) : undefined}
    >
      <Sidebar />
      {!collapsed && !focus && <SidebarResizer />}
      <main>
        <SafeModeBanner />
        <Topbar />
        <TabBar />
        <div className="main-scroll" data-fill={isDatabase ? "" : undefined}>
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button onClick={clearError}>Dismiss</button>
            </div>
          )}
          <ErrorBoundary label="This view could not be shown.">
            <Suspense fallback={<Loading label="Loading page…" />}><Content /></Suspense>
          </ErrorBoundary>
        </div>
        <OnDemand open={FindBarOpen}><FindBar /></OnDemand>
        <Toast />
      </main>
      <AppContextMenu />
      <Palette />
      <OnDemand open={TemplateGalleryOpen}><TemplateGallery /></OnDemand>
      <OnDemand open={BackupsDialogOpen}><BackupsDialog /></OnDemand>
      <PageTransferDialog />
      <OnDemand open={TransferDialogOpen}><TransferDialog /></OnDemand>
      <OnDemand open={HistoryPanelOpen}><HistoryPanel /></OnDemand>
      <ShortcutSheet />
      <OnDemand open={SettingsDialogOpen}><SettingsDialog /></OnDemand>
      <OnDemand open={FilesDialogOpen}><FilesDialog /></OnDemand>
      <QuickCapture />
    </div>
    <OnDemand open={WorkspaceDialogOpen}><WorkspaceDialog /></OnDemand>
    <OnDemand open={outlineOpen}><OutlinePanel /></OnDemand>
    <OnDemand open={exploreOpen}><ExploreDialog /></OnDemand>
    <OnDemand open={peekOpen}><PeekPanel /></OnDemand>
    <UpdatesRoot />
    {workspaceBusy && <div className="workspace-pending" role="status"><Loading variant="orbit" label="Saving changes and preparing workspace…" /></div>}
    </div>
  );
}
