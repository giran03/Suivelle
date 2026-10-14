import { rememberedWorkspace, rememberWorkspace, rememberedPage, rememberPage, orderedWorkspaces, rememberWorkspaceOrder } from "../features/workspaces/model";
import { create } from "zustand";
import { usePreferences } from "./preferences";
import { flushAllEditors } from "../features/editor/flushRegistry";
import * as hist from "../lib/history";
import { ipc, toAppError } from "../lib/ipc";
import type { Page, PageTitle, Settings, ThemeSetting, Workspace } from "../types";

function parseSettings(json: string): Settings {
  try {
    const s = JSON.parse(json) as Partial<Settings>;
    return { theme: s.theme === "light" || s.theme === "dark" ? s.theme : "system", autoBackup: s.autoBackup !== false, backupKeep: Number.isInteger(s.backupKeep) && s.backupKeep! >= 1 && s.backupKeep! <= 1000 ? s.backupKeep! : 3 };
  } catch {
    return { theme: "system", autoBackup: true, backupKeep: 3 };
  }
}

/** The stored settings object as it is, so changing one setting keeps the others. */
function rawSettings(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface Toast {
  id: number;
  message: string;
  undo?: () => void | Promise<void>;
  /** The button's label when the action is not an undo, such as "Open". */
  action?: string;
}

/** Cached title info for mention chips; `missing` means the page no longer exists. */
export type TitleInfo = PageTitle & { missing?: boolean };

export type View = "page" | "trash" | "canvas";

interface State {
  workspace: Workspace | null;
  workspaces: Workspace[];
  workspaceBusy: boolean;
  refreshWorkspaces: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string, icon: string | null, settings: Record<string, unknown>, image?: File) => Promise<void>;
  reorderWorkspace: (id: string, targetId: string) => void;
  updateWorkspaceProfile: (id: string, name: string, icon: string | null, settings: Record<string, unknown>) => Promise<void>;
  deleteWorkspace: (id: string, confirmation: string) => Promise<void>;
  settings: Settings;
  /** Bumped to remount the open editor after its content changed underneath it (a restored version). */
  editorEpoch: number;
  bumpEditor: () => void;
  setAutoBackup: (on: boolean) => Promise<void>;
  setBackupKeep: (keep: number) => Promise<void>;
  /** Children per parent id ("root" for top level); loaded lazily. */
  children: Record<string, Page[]>;
  expanded: Record<string, boolean>;
  treeExpanding: boolean;
  favorites: Page[];
  trash: Page[];
  view: View;
  selectedPageId: string | null;
  selectedPage: Page | null;
  ancestors: Page[];
  history: hist.History;
  toast: Toast | null;
  error: string | null;
  ready: boolean;
  pageTitles: Record<string, TitleInfo>;
  /** A block to scroll to and highlight once its page has loaded (search results, backlinks). */
  focusTarget: { pageId: string; blockId: string } | null;

  init: () => Promise<void>;
  loadChildren: (parentId: string | null) => Promise<void>;
  reloadTree: () => Promise<void>;
  toggleExpanded: (id: string) => Promise<void>;
  expandAllPages: () => Promise<void>;
  collapseAllPages: () => void;
  revealCurrentPage: () => Promise<string | null>;
  selectPage: (id: string | null, opts?: { fromHistory?: boolean }) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  showTrash: () => Promise<void>;
  createPage: (parentId: string | null, title?: string) => Promise<void>;
  openPage: (id: string, blockId?: string | null) => Promise<void>;
  ensureTitles: (ids: string[]) => Promise<void>;
  refreshTitles: () => Promise<void>;
  notify: (message: string, undo?: Toast["undo"], action?: string) => void;
  createDatabase: (parentId: string | null) => Promise<void>;
  /** Bumped when something other than the open view changed records (a button, an automation). */
  dataEpoch: number;
  bumpData: () => void;
  createDashboard: (parentId: string | null) => Promise<void>;
  /** Builds a template's databases and opens the page that holds them. Resolves to an error message, or null. */
  createFromTemplate: (template: string, sampleData: boolean) => Promise<string | null>;
  renamePage: (id: string, title: string, opts?: { strict?: boolean }) => Promise<void>;
  toggleFavorite: (page: Page) => Promise<void>;
  trashPage: (page: Page) => Promise<void>;
  restorePage: (id: string, opts?: { open?: boolean }) => Promise<void>;
  deletePermanently: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  movePage: (id: string, parentId: string | null, beforeId: string | null, opts?: { silent?: boolean }) => Promise<void>;
  nudgePage: (page: Page, direction: "up" | "down" | "in" | "out") => Promise<void>;
  renameWorkspace: (name: string) => Promise<void>;
  setTheme: (theme: ThemeSetting) => Promise<void>;
  setError: (message: string) => void;
  dismissToast: () => void;
  clearError: () => void;
}

const key = (parentId: string | null) => parentId ?? "root";
let toastSeq = 0;

export const useWorkspace = create<State>((set, get) => {
  const guard = async (fn: () => Promise<void>, strict = false) => {
    const owner = get().workspace?.id;
    try {
      await fn();
    } catch (e) {
      if (get().workspace?.id === owner) set({ error: toAppError(e).message });
      if (strict) throw e;
    }
  };

  const findPage = (id: string): Page | undefined => {
    const s = get();
    for (const list of Object.values(s.children)) {
      const hit = list.find((p) => p.id === id);
      if (hit) return hit;
    }
    return s.favorites.find((p) => p.id === id) ?? (s.selectedPage?.id === id ? s.selectedPage : undefined);
  };

  const siblingsOf = (parentId: string | null) => get().children[key(parentId)] ?? [];

  const loadSelectionContext = async (id: string) => {
    const [page, ancestors] = await Promise.all([ipc.pageGet(id), ipc.pageAncestors(id)]);
    return { page, ancestors };
  };

  /** Loads the lists the sidebar shows: top level, every expanded parent, and favorites. */
  const reloadTree = async () => {
    const ws = get().workspace;
    if (!ws) return;
    const parents = ["root", ...Object.keys(get().expanded).filter((k) => get().expanded[k])];
    const [favorites, ...lists] = await Promise.all([
      ipc.pageListFavorites(ws.id),
      ...parents.map((k) => ipc.pageListChildren(ws.id, k === "root" ? null : k).catch(() => null)),
    ]);
    if (get().workspace?.id !== ws.id) return;
    const next: Record<string, Page[]> = { ...get().children };
    parents.forEach((k, i) => {
      const list = lists[i];
      if (list) next[k] = list;
      else delete next[k]; // parent no longer exists
    });
    set({ children: next, favorites });
  };

  const pushToast = (message: string, undo?: Toast["undo"], action?: string) => set({ toast: { id: ++toastSeq, message, undo, action } });

  let selectionSeq = 0;
  let treeSeq = 0;
  let initialization: Promise<void> | null = null;
  const applyWorkspace = (workspace: Workspace) => {
    selectionSeq++;
    treeSeq++;
    set({ treeExpanding: false });
    set({ workspace, settings: parseSettings(workspace.settingsJson), children: {}, expanded: {}, favorites: [], trash: [], view: "page", selectedPageId: null, selectedPage: null, ancestors: [], history: hist.emptyHistory, pageTitles: {}, focusTarget: null, toast: null, error: null, ready: true, editorEpoch: get().editorEpoch + 1 });
    rememberWorkspace(workspace.id);
  };
  const activate = async (id: string, pageId?: string) => {
    const workspace = await ipc.workspaceGet(id);
    if (!workspace) throw new Error("This workspace no longer exists. Refresh the workspace list.");
    const [roots, favorites] = await Promise.all([ipc.pageListChildren(id, null), ipc.pageListFavorites(id)]);
    const wanted = pageId ?? rememberedPage(id) ?? roots[0]?.id;
    let page: Page | null = null, ancestors: Page[] = [];
    if (wanted) {
      try { const context = await loadSelectionContext(wanted); if (context.page.workspaceId === id && !context.page.deletedAt) { page = context.page; ancestors = context.ancestors; } }
      catch { /* A removed page falls back to the first root. */ }
    }
    if (!page && roots[0]) { const context = await loadSelectionContext(roots[0].id); page = context.page; ancestors = context.ancestors; }
    const lists = await Promise.all(ancestors.map((a) => ipc.pageListChildren(id, a.id)));
    applyWorkspace(workspace);
    set({ children: { root: roots, ...Object.fromEntries(ancestors.map((a, i) => [a.id, lists[i]])) }, favorites, selectedPage: page, selectedPageId: page?.id ?? null, ancestors, expanded: Object.fromEntries(ancestors.map((a) => [a.id, true])), history: page ? hist.push(hist.emptyHistory, page.id) : hist.emptyHistory });
    rememberPage(id, page?.id ?? null);
  };
  const leave = async () => {
    await flushAllEditors(true);
    const page = get().selectedPage;
    if (page && page.kind !== "database" && page.kind !== "dashboard") await ipc.historyCheckpoint(page.id);
  };
  const transition = async (fn: () => Promise<void>) => {
    if (get().workspaceBusy) throw new Error("A workspace operation is already in progress.");
    set({ workspaceBusy: true, error: null });
    try { await fn(); }
    catch (e) { set({ error: toAppError(e).message }); throw e; }
    finally { set({ workspaceBusy: false }); }
  };
  const applyProfile = (updated: Workspace) => set((s) => ({ workspaces: s.workspaces.map((w) => w.id === updated.id ? updated : w), ...(s.workspace?.id === updated.id ? { workspace: updated, settings: parseSettings(updated.settingsJson) } : {}) }));

  return {
    workspace: null,
    workspaces: [],
    workspaceBusy: false,
    refreshWorkspaces: () => guard(async () => { set({ workspaces: orderedWorkspaces(await ipc.workspaceList()) }); }),
    reorderWorkspace: (id, targetId) => {
      const workspaces = [...get().workspaces];
      const from = workspaces.findIndex((w) => w.id === id), to = workspaces.findIndex((w) => w.id === targetId);
      if (get().workspaceBusy || from < 0 || to < 0 || from === to) return;
      const [moved] = workspaces.splice(from, 1);
      workspaces.splice(to, 0, moved);
      rememberWorkspaceOrder(workspaces);
      set({ workspaces });
    },
    switchWorkspace: (id) => transition(async () => { await leave(); await activate(id); }),
    createWorkspace: (name, icon, settings, image) => transition(async () => {
      await leave();
      const workspace = image ? await ipc.workspaceCreateWithImage(name, JSON.stringify(settings), image.name, await image.arrayBuffer()) : await ipc.workspaceCreate(name, icon, JSON.stringify(settings));
      set({ workspaces: [...get().workspaces, workspace] });
      await activate(workspace.id);
      pushToast(`Created “${workspace.name}”`);
    }),
    updateWorkspaceProfile: async (id, name, icon, settings) => {
      const workspace = await ipc.workspaceGet(id);
      if (!workspace) throw new Error("This workspace no longer exists.");
      const updated = await ipc.workspaceUpdate(id, name, { icon, settingsJson: JSON.stringify({ ...rawSettings(workspace.settingsJson), ...settings }) });
      applyProfile(updated);
      pushToast("Workspace settings saved.");
    },
    deleteWorkspace: (id, confirmation) => transition(async () => {
      await leave();
      await ipc.workspaceDelete(id, confirmation);
      const remaining = get().workspaces.filter((w) => w.id !== id);
      set({ workspaces: remaining });
      if (get().workspace?.id === id && remaining[0]) { applyWorkspace(remaining[0]); await activate(remaining[0].id); }
      try { set({ workspaces: orderedWorkspaces(await ipc.workspaceList()) }); } catch { /* Local survivors remain usable. */ }
      pushToast("Workspace deleted. A safety backup is available in Backups.");
    }),
    settings: { theme: "system", autoBackup: true, backupKeep: 3 },
    editorEpoch: 0,
    children: {},
    expanded: {},
    treeExpanding: false,
    favorites: [],
    trash: [],
    view: "page",
    selectedPageId: null,
    selectedPage: null,
    ancestors: [],
    history: hist.emptyHistory,
    toast: null,
    error: null,
    ready: false,
    pageTitles: {},
    focusTarget: null,

    init: () => {
      if (initialization) return initialization;
      initialization = guard(async () => {
        let workspaces = orderedWorkspaces(await ipc.workspaceList());
        if (!workspaces.length) {
          // A brand-new installation opens on a short Getting started checklist.
          const created = await ipc.workspaceCreate("My Workspace");
          workspaces = [created];
          try {
            const { seedGettingStarted } = await import("../features/onboarding/gettingStarted");
            rememberPage(created.id, (await seedGettingStarted(created.id)).id);
          } catch { /* An empty workspace is still a working start. */ }
        }
        set({ workspaces });
        const id = rememberedWorkspace();
        await activate(workspaces.some((w) => w.id === id) ? id! : workspaces[0].id);
      }).finally(() => { initialization = null; });
      return initialization;
    },

    loadChildren: (parentId) =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws) return;
        const pages = await ipc.pageListChildren(ws.id, parentId);
        if (get().workspace?.id !== ws.id) return;
        set((s) => ({ children: { ...s.children, [key(parentId)]: pages } }));
      }),

    reloadTree: () => guard(reloadTree),

    toggleExpanded: async (id) => {
      treeSeq++;
      const open = !get().expanded[id];
      set((s) => ({ expanded: { ...s.expanded, [id]: open }, treeExpanding: false }));
      if (open) await get().loadChildren(id);
    },

    expandAllPages: async () => {
      const ws = get().workspace;
      if (!ws || get().treeExpanding) return;
      const mine = ++treeSeq;
      const current = () => mine === treeSeq && get().workspace?.id === ws.id;
      set({ treeExpanding: true });
      try {
        const roots = get().children.root ?? await ipc.pageListChildren(ws.id, null);
        if (!current()) return;
        set((s) => ({ children: { ...s.children, root: roots } }));
        const queue = roots.filter((p) => p.childCount > 0);
        const seen = new Set<string>();
        // Load in bounded batches, including descendants that have never been opened.
        for (let at = 0; at < queue.length;) {
          const candidates = queue.slice(at, at + 16);
          at += candidates.length;
          const batch = candidates.filter((p) => !seen.has(p.id));
          batch.forEach((p) => seen.add(p.id));
          // Collapsed lists may have changed since they were cached.
          const lists = await Promise.all(batch.map((p) => ipc.pageListChildren(ws.id, p.id)));
          if (!current()) return;
          set((s) => ({
            children: { ...s.children, ...Object.fromEntries(batch.map((p, i) => [p.id, lists[i]])) },
            expanded: { ...s.expanded, ...Object.fromEntries(batch.map((p) => [p.id, true])) },
          }));
          lists.forEach((list) => queue.push(...list.filter((p) => p.childCount > 0 && !seen.has(p.id))));
        }
      } catch (e) {
        if (current()) set({ error: toAppError(e).message });
      } finally {
        if (current()) set({ treeExpanding: false });
      }
    },

    collapseAllPages: () => {
      treeSeq++;
      set({ expanded: {}, treeExpanding: false });
    },

    revealCurrentPage: async () => {
      const { workspace, selectedPage, ancestors, view } = get();
      if (!workspace || !selectedPage || view !== "page") return null;
      const target = selectedPage.kind === "record" ? ancestors.find((p) => p.kind === "database") : selectedPage;
      if (!target) return null;
      const targetIndex = ancestors.findIndex((p) => p.id === target.id);
      const parents = targetIndex < 0 ? ancestors : ancestors.slice(0, targetIndex);
      const mine = ++treeSeq;
      set({ treeExpanding: false });
      try {
        const lists = await Promise.all(parents.map((p) => ipc.pageListChildren(workspace.id, p.id)));
        if (mine !== treeSeq || get().workspace?.id !== workspace.id || get().selectedPageId !== selectedPage.id) return null;
        set((s) => ({
          expanded: { ...s.expanded, ...Object.fromEntries(parents.map((p) => [p.id, true])) },
          children: { ...s.children, ...Object.fromEntries(parents.map((p, i) => [p.id, lists[i]])) },
        }));
        return target.id;
      } catch (e) {
        if (mine === treeSeq && get().workspace?.id === workspace.id) set({ error: toAppError(e).message });
        return null;
      }
    },

    selectPage: (id, opts) =>
      guard(async () => {
        const owner = get().workspace?.id;
        const mine = ++selectionSeq;
        if (!id) {
          if (owner) rememberPage(owner, null);
          set({ selectedPageId: null, selectedPage: null, ancestors: [], view: "page" });
          return;
        }
        // Leaving a page saves a version of it if it changed since the last one.
        const prev = get().selectedPage;
        if (prev && prev.id !== id && prev.kind !== "database" && prev.kind !== "dashboard") {
          void flushAllEditors()
            .then(() => ipc.historyCheckpoint(prev.id))
            .catch(() => undefined);
        }
        const { page, ancestors } = await loadSelectionContext(id);
        if (mine !== selectionSeq || owner !== get().workspace?.id) return;
        if (page.workspaceId !== owner) throw new Error("Open this page from its workspace.");
        if (owner) rememberPage(owner, id);
        // Reveal the page in the tree: expand and load every ancestor.
        const expanded = { ...get().expanded };
        ancestors.forEach((a) => (expanded[a.id] = true));
        set((s) => ({
          selectedPageId: id,
          selectedPage: page,
          ancestors,
          expanded,
          view: "page",
          history: opts?.fromHistory ? s.history : hist.push(s.history, id),
        }));
        if (ancestors.length) await reloadTree();
        // Feeds the recent pages list; failing to record a visit must never block opening.
        void ipc.pageTouch(id).catch(() => undefined);
      }),

    goBack: async () => {
      let h = get().history;
      while (hist.canBack(h)) {
        h = hist.back(h);
        const id = hist.current(h);
        try {
          set({ history: h });
          await get().selectPage(id, { fromHistory: true });
          if (!get().error) return;
          // Target is gone (deleted since); drop it and keep walking.
          set({ error: null, history: hist.remove(get().history, new Set(id ? [id] : [])) });
          h = get().history;
        } catch {
          return;
        }
      }
    },

    goForward: async () => {
      let h = get().history;
      while (hist.canForward(h)) {
        h = hist.forward(h);
        const id = hist.current(h);
        set({ history: h });
        await get().selectPage(id, { fromHistory: true });
        if (!get().error) return;
        set({ error: null, history: hist.remove(get().history, new Set(id ? [id] : [])) });
        h = get().history;
      }
    },

    showTrash: () =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws) return;
        const trash = await ipc.pageListTrash(ws.id);
        if (get().workspace?.id !== ws.id) return;
        set({ trash, view: "trash" });
      }),

    createPage: (parentId, title) =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws) return;
        const page = await ipc.pageCreate(ws.id, parentId, title ?? "");
        if (get().workspace?.id !== ws.id) return;
        if (parentId) set((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
        await reloadTree();
        await get().selectPage(page.id);
      }),

    renamePage: (id, title, opts) =>
      guard(async () => {
        const page = await ipc.pageUpdate({ id, title });
        if (get().workspace?.id !== page.workspaceId) return;
        const patch = (p: Page) => (p.id === id ? { ...p, title: page.title, revision: page.revision } : p);
        set((s) => ({
          children: Object.fromEntries(Object.entries(s.children).map(([k, v]) => [k, v.map(patch)])),
          favorites: s.favorites.map(patch),
          ancestors: s.ancestors.map(patch),
          selectedPage: s.selectedPage?.id === id ? { ...s.selectedPage, ...page } : s.selectedPage,
        }));
        set((st) => (st.pageTitles[id] ? { pageTitles: { ...st.pageTitles, [id]: { ...st.pageTitles[id], title: page.title } } } : st));
        // Favorites are sorted by title, so refresh their order.
        if (get().favorites.some((p) => p.id === id)) await reloadTree();
      }, opts?.strict),

    toggleFavorite: (page) =>
      guard(async () => {
        const updated = await ipc.pageUpdate({ id: page.id, favorite: !page.favorite });
        if (get().workspace?.id !== updated.workspaceId) return;
        set((s) => ({
          selectedPage: s.selectedPage?.id === page.id ? { ...s.selectedPage, favorite: updated.favorite } : s.selectedPage,
        }));
        await reloadTree();
      }),

    trashPage: (page) =>
      guard(async () => {
        const s = get();
        const affectsSelection =
          s.selectedPageId === page.id || s.ancestors.some((a) => a.id === page.id);
        await flushAllEditors(); // pending edits must reach the page before it moves to the trash
        await ipc.pageDelete(page.id);
        if (get().workspace?.id !== s.workspace?.id) return;
        await reloadTree();
        if (affectsSelection) {
          const fallback = page.parentPageId ?? get().children.root?.[0]?.id ?? null;
          await get().selectPage(fallback);
        }
        set((st) => ({ history: hist.remove(st.history, new Set([page.id])) }));
        void get().refreshTitles();
        pushToast(`Moved “${page.title || "Untitled"}” to trash`, () => get().restorePage(page.id, { open: true }));
      }),

    restorePage: (id, opts) =>
      guard(async () => {
        const page = await ipc.pageRestore(id);
        if (get().workspace?.id !== page.workspaceId) return;
        const ws = get().workspace;
        if (ws) set({ trash: await ipc.pageListTrash(ws.id) });
        await reloadTree();
        void get().refreshTitles();
        if (opts?.open) await get().selectPage(page.id);
        else pushToast(`Restored “${page.title || "Untitled"}”`);
      }),

    deletePermanently: (id) =>
      guard(async () => {
        await ipc.pageDeletePermanent(id);
        const ws = get().workspace;
        if (ws) set({ trash: await ipc.pageListTrash(ws.id) });
        void get().refreshTitles();
      }),

    emptyTrash: () =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws) return;
        await ipc.trashEmpty(ws.id);
        if (get().workspace?.id !== ws.id) return;
        set({ trash: [] });
        void get().refreshTitles();
      }),

    movePage: (id, parentId, beforeId, opts) =>
      guard(async () => {
        // Remember where the page was so the toast can put it back.
        const origin = findPage(id);
        const fromParent = origin?.parentPageId ?? null;
        const fromSiblings = siblingsOf(fromParent);
        const fromIndex = fromSiblings.findIndex((p) => p.id === id);
        const fromNext = fromIndex >= 0 ? (fromSiblings[fromIndex + 1]?.id ?? null) : null;
        const moved = await ipc.pageMove(id, parentId, beforeId);
        if (get().workspace?.id !== moved.workspaceId) return;
        if (origin && !opts?.silent && (fromParent !== parentId || fromNext !== beforeId)) {
          pushToast(`Moved “${origin.title || "Untitled"}”`, () => get().movePage(id, fromParent, fromNext, { silent: true }));
        }
        if (parentId) set((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
        await reloadTree();
        const sel = get().selectedPageId;
        if (sel && (sel === moved.id || get().ancestors.some((a) => a.id === moved.id))) {
          const { page, ancestors } = await loadSelectionContext(sel);
          set({ selectedPage: page, ancestors });
        }
      }),

    nudgePage: async (page, direction) => {
      const siblings = siblingsOf(page.parentPageId);
      const i = siblings.findIndex((p) => p.id === page.id);
      if (i < 0) return;
      const move = get().movePage;
      if (direction === "up" && i > 0) await move(page.id, page.parentPageId, siblings[i - 1].id);
      else if (direction === "down" && i < siblings.length - 1) {
        await move(page.id, page.parentPageId, siblings[i + 2]?.id ?? null);
      } else if (direction === "in" && i > 0) await move(page.id, siblings[i - 1].id, null);
      else if (direction === "out" && page.parentPageId) {
        const parent = findPage(page.parentPageId);
        if (!parent) return;
        const uncles = siblingsOf(parent.parentPageId);
        const pi = uncles.findIndex((p) => p.id === parent.id);
        await move(page.id, parent.parentPageId, uncles[pi + 1]?.id ?? null);
      }
    },

    renameWorkspace: (name) =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws || !name.trim() || name.trim() === ws.name) return;
        applyProfile(await ipc.workspaceUpdate(ws.id, name));
      }),

    setTheme: async (theme) => usePreferences.getState().setTheme(theme),

    setAutoBackup: (on) => guard(async () => {
      const workspaces = await ipc.backupSetAuto(on);
      const workspace = workspaces.find((w) => w.id === get().workspace?.id);
      set({ workspaces });
      if (workspace) applyProfile(workspace);
    }),

    setBackupKeep: async (keep) => {
      const workspaces = await ipc.backupSetAuto(undefined, keep);
      const workspace = workspaces.find((w) => w.id === get().workspace?.id);
      set({ workspaces });
      if (workspace) applyProfile(workspace);
    },

    bumpEditor: () => set((s) => ({ editorEpoch: s.editorEpoch + 1 })),

    openPage: (id, blockId = null) => guard(async () => {
      const page = await ipc.pageGet(id);
      if (page.workspaceId !== get().workspace?.id) await get().switchWorkspace(page.workspaceId);
      // Scoped to the page so the editor that is still on screen cannot consume it early.
      set({ focusTarget: blockId ? { pageId: id, blockId } : null });
      if (get().selectedPageId !== id || get().view !== "page") await get().selectPage(id);
    }),

    ensureTitles: async (ids) => {
      const known = get().pageTitles;
      const want = [...new Set(ids)].filter((id) => !known[id]);
      if (!want.length) return;
      const owner = get().workspace?.id;
      try {
        const found = await ipc.pageTitles(want.slice(0, 200));
        if (get().workspace?.id !== owner) return;
        const next: Record<string, TitleInfo> = {};
        for (const t of found) next[t.id] = t;
        for (const id of want) if (!next[id]) next[id] = { id, title: "", icon: null, deleted: false, missing: true };
        set((s) => ({ pageTitles: { ...s.pageTitles, ...next } }));
      } catch {
        // Chips fall back to a neutral label; try again next time they mount.
      }
    },

    refreshTitles: async () => {
      const ids = Object.keys(get().pageTitles);
      if (!ids.length) return;
      const owner = get().workspace?.id;
      try {
        const found = await ipc.pageTitles(ids.slice(0, 200));
        if (get().workspace?.id !== owner) return;
        const next: Record<string, TitleInfo> = {};
        for (const t of found) next[t.id] = t;
        for (const id of ids) if (!next[id]) next[id] = { id, title: "", icon: null, deleted: false, missing: true };
        set({ pageTitles: next });
      } catch {
        // keep the old cache
      }
    },

    notify: (message, undo, action) => pushToast(message, undo, action),
    dataEpoch: 0,
    bumpData: () => set((s) => ({ dataEpoch: s.dataEpoch + 1 })),

    createDatabase: (parentId) =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws) return;
        const created = await ipc.databaseCreate(ws.id, parentId);
        if (get().workspace?.id !== ws.id) return;
        if (parentId) set((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
        await reloadTree();
        await get().selectPage(created.page.id);
      }),

    createDashboard: (parentId) =>
      guard(async () => {
        const ws = get().workspace;
        if (!ws) return;
        const created = await ipc.dashboardCreate(ws.id, parentId);
        if (get().workspace?.id !== ws.id) return;
        if (parentId) set((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
        await reloadTree();
        await get().selectPage(created.page.id);
      }),

    createFromTemplate: async (template, sampleData) => {
      const ws = get().workspace;
      if (!ws) return "Open a workspace first.";
      try {
        const made = await ipc.templateCreate(ws.id, template, sampleData);
        if (get().workspace?.id !== ws.id) return null;
        // Templates may add durable project/task relation IDs to the workspace settings.
        // Refresh them before another appearance change can save an older settings object.
        const updated = await ipc.workspaceGet(ws.id).catch(() => null);
        if (get().workspace?.id !== ws.id) return null;
        if (updated) set(s => ({ workspace: updated, workspaces: s.workspaces.map(w => w.id === updated.id ? updated : w) }));
        await reloadTree();
        await get().selectPage(made.pageId);
        return null;
      } catch (e) {
        return toAppError(e).message;
      }
    },

    setError: (message) => set({ error: message }),
    dismissToast: () => set({ toast: null }),
    clearError: () => set({ error: null }),
  };
});
