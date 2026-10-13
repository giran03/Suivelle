import { useWorkspaceDialog } from "../workspaces/WorkspaceDialog";
import { READ_ONLY, READ_ONLY_COMMANDS } from "../../lib/access";
import { canBack, canForward } from "../../lib/history";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useBackupsDialog } from "../backup/store";
import { useHistoryPanel } from "../history/store";
import { useTransferDialog } from "../transfer/store";
import { useTemplateGallery } from "../templates/store";
import { useLayout } from "../../stores/layout";
import { useAppearanceUi } from "../pages/pageAppearance";
import { useShortcutSheet } from "../shortcuts/ShortcutSheet";
import { useSettingsDialog } from "../settings/store";
import { useFilesDialog } from "../files/store";
import { useQuickCapture } from "../capture/QuickCapture";
import { duplicatePage, saveAsTemplate } from "../templates/pageTemplates";
import { useFindBar } from "../find/store";
import { useActiveEditor } from "../../stores/activeEditor";
import { modKey } from "./store";

export interface PaletteCommand {
  id: string;
  title: string;
  keywords: string;
  shortcut?: string;
  /** Hidden when it makes no sense right now (for example, no page is open). */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const st = () => useWorkspace.getState();
const hasPage = () => !!st().selectedPage && st().view === "page";

export const INTERNAL_PAGE_LINK = "suivelle://page/";

export const COMMANDS: PaletteCommand[] = [
  { id: "updates", title: "Updates and changelog", keywords: "version release download install restart what's new", run: () => useSettingsDialog.getState().show("updates") },
  { id: "new-workspace", title: "New workspace…", keywords: "create space personal work project", run: () => useWorkspaceDialog.getState().show("create") },
  { id: "import-workspace", title: "Import workspace…", keywords: "archive zip separate space move computer", run: () => useTransferDialog.getState().show("import", "workspace") },
  { id: "export-workspace", title: "Export workspace…", keywords: "archive zip portable save transfer computer", run: () => useTransferDialog.getState().show("export", "workspace") },
  { id: "workspace-settings", title: "Workspace settings…", keywords: "rename icon color description spacing delete", run: () => useWorkspaceDialog.getState().show("manage") },
  { id: "switch-workspace", title: "Switch workspace…", keywords: "open space work personal", run: () => useWorkspaceDialog.getState().show("manage") },
  { id: "new-page", title: "New page", keywords: "create add page", shortcut: `${modKey}+N`, run: () => st().createPage(null) },
  { id: "new-database", title: "New database", keywords: "create add table records tasks", run: () => st().createDatabase(null) },
  { id: "new-dashboard", title: "New dashboard", keywords: "create add charts widgets overview kpi report", run: () => st().createDashboard(null) },
  { id: "new-from-template", title: "New from template…", keywords: "project manager tasks tracker sprint milestone software bugs", run: () => useTemplateGallery.getState().show() },
  {
    id: "new-subpage",
    title: "New page inside this page",
    keywords: "create add subpage child nested",
    when: () => hasPage() && st().selectedPage!.kind === "page",
    run: () => st().createPage(st().selectedPage!.id),
  },
  { id: "history", title: "Page history", keywords: "versions restore previous undo changes", when: () => hasPage() && ["page", "record"].includes(st().selectedPage!.kind), run: () => useHistoryPanel.getState().toggle() },
  { id: "import", title: "Import…", keywords: "markdown csv html text files folder archive notion obsidian", run: () => useTransferDialog.getState().show("import") },
  { id: "export", title: "Export…", keywords: "markdown html csv archive zip save page database workspace", run: () => useTransferDialog.getState().show("export") },
  { id: "backups", title: "Backups…", keywords: "backup restore export import safety copy data", run: () => useBackupsDialog.getState().show() },
  {
    id: "backup-now",
    title: "Back up now",
    keywords: "backup save copy data",
    run: async () => {
      try {
        const b = await ipc.backupCreate();
        st().notify(`Backed up ${b.manifest.pages} ${b.manifest.pages === 1 ? "page" : "pages"}`);
      } catch (e) {
        st().setError(toAppError(e).message);
      }
    },
  },
  { id: "capture", title: "Quick capture…", keywords: "inbox jot note todo add fast thought", shortcut: `${modKey}+Shift+N`, run: () => useQuickCapture.getState().show() },
  { id: "duplicate", title: "Duplicate this page", keywords: "copy clone", when: () => hasPage() && st().selectedPage!.kind === "page", run: () => duplicatePage(st().selectedPage!) },
  { id: "save-template", title: "Save this page as a template", keywords: "template reuse copy blueprint", when: () => hasPage() && st().selectedPage!.kind === "page", run: () => saveAsTemplate(st().selectedPage!) },
  { id: "find", title: "Find in page", keywords: "search text replace within this page", shortcut: `${modKey}+F`, when: () => !!useActiveEditor.getState().editor, run: () => useFindBar.getState().show() },
  { id: "replace", title: "Find and replace in page", keywords: "substitute change text", shortcut: `${modKey}+H`, when: () => !!useActiveEditor.getState().editor?.isEditable, run: () => useFindBar.getState().show({ replace: true }) },
  { id: "files", title: "Manage files…", keywords: "attachments images unused storage space delete cleanup", run: () => useFilesDialog.getState().show() },
  { id: "settings", title: "Settings", keywords: "preferences options theme text size width backup", shortcut: `${modKey}+,`, run: () => useSettingsDialog.getState().show() },
  { id: "shortcuts", title: "Keyboard shortcuts", keywords: "keys hotkeys help cheatsheet reference", shortcut: `${modKey}+/`, run: () => useShortcutSheet.getState().show() },
  { id: "sidebar", title: "Show or hide the sidebar", keywords: "toggle collapse panel navigation", shortcut: `${modKey}+\\`, run: () => useLayout.getState().toggleSidebar() },
  { id: "focus", title: "Focus mode", keywords: "distraction free zen write hide sidebar toolbar", shortcut: `${modKey}+Shift+\\`, run: () => useLayout.getState().toggleFocus() },
  { id: "page-icon", title: "Change page icon…", keywords: "emoji symbol picture avatar", when: hasPage, run: () => useAppearanceUi.getState().show("icon") },
  { id: "page-cover", title: "Change page cover…", keywords: "banner header image gradient picture", when: hasPage, run: () => useAppearanceUi.getState().show("cover") },
  { id: "trash", title: "Open trash", keywords: "deleted restore bin", run: () => st().showTrash() },
  { id: "back", title: "Go back", keywords: "previous history", shortcut: "Alt+←", when: () => canBack(st().history), run: () => st().goBack() },
  { id: "forward", title: "Go forward", keywords: "next history", shortcut: "Alt+→", when: () => canForward(st().history), run: () => st().goForward() },
  {
    id: "favorite",
    title: "Add to favorites",
    keywords: "star pin bookmark",
    when: () => hasPage() && !st().selectedPage!.favorite,
    run: () => st().toggleFavorite(st().selectedPage!),
  },
  {
    id: "unfavorite",
    title: "Remove from favorites",
    keywords: "star unpin bookmark",
    when: () => hasPage() && st().selectedPage!.favorite,
    run: () => st().toggleFavorite(st().selectedPage!),
  },
  {
    id: "copy-link",
    title: "Copy link to this page",
    keywords: "share url reference",
    when: hasPage,
    run: async () => {
      try {
        await navigator.clipboard.writeText(`${INTERNAL_PAGE_LINK}${st().selectedPage!.id}`);
        st().notify("Link copied. Paste it into a page to link here.");
      } catch {
        st().setError("Could not copy to the clipboard.");
      }
    },
  },
  { id: "theme-light", title: "Switch to light theme", keywords: "appearance color mode", run: () => st().setTheme("light") },
  { id: "theme-dark", title: "Switch to dark theme", keywords: "appearance color mode night", run: () => st().setTheme("dark") },
  { id: "theme-system", title: "Use system theme", keywords: "appearance color mode auto", run: () => st().setTheme("system") },
  {
    id: "rebuild-index",
    title: "Rebuild search index",
    keywords: "repair reindex maintenance fix search",
    run: async () => {
      const ws = st().workspace;
      if (!ws) return;
      try {
        st().notify("Rebuilding the search index…");
        const n = await ipc.searchRebuild(ws.id);
        st().notify(`Search index rebuilt (${n.toLocaleString()} items).`);
      } catch (e) {
        st().setError(toAppError(e).message);
      }
    },
  },
];

/** Commands that apply right now and match the query (empty query lists them all). */
export function matchCommands(query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  const available = COMMANDS.filter((c) => (!READ_ONLY || READ_ONLY_COMMANDS.has(c.id)) && (!c.when || c.when()));
  if (!q) return available;
  const words = q.split(/\s+/);
  return available.filter((c) => {
    const hay = `${c.title} ${c.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
