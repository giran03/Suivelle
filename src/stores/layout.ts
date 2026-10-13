import "../lib/legacy";
import { create } from "zustand";

const KEY = "suivelle.layout";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;

interface Saved {
  width: number | null;
  collapsed: boolean;
  hidden: boolean;
  recentOpen: boolean;
}

function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    const width = typeof v.width === "number" ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(v.width))) : null;
    return { width, collapsed: v.collapsed === true, hidden: v.hidden === true, recentOpen: v.recentOpen !== false };
  } catch {
    return { width: null, collapsed: false, hidden: false, recentOpen: true };
  }
}

function write(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* Convenience only: the layout still works for this session. */
  }
}

interface LayoutState extends Saved {
  /** Narrow navigation is temporary; it never overwrites the desktop preference. */
  compact: boolean;
  compactOpen: boolean;
  setCompact: (compact: boolean) => void;
  /** Writing without the sidebar or toolbar in the way. Lasts for this session only. */
  focus: boolean;
  toggleFocus: () => void;
  setWidth: (width: number | null) => void;
  toggleSidebar: () => void;
  toggleSidebarVisibility: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleRecent: () => void;
}

export const useLayout = create<LayoutState>((set, get) => {
  const save = (patch: Partial<Saved>) => {
    set(patch);
    const { width, collapsed, hidden, recentOpen } = get();
    write({ width, collapsed, hidden, recentOpen });
  };
  return {
    ...read(),
    compact: typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 760px)").matches,
    compactOpen: false,
    setCompact: (compact) => set({ compact, compactOpen: false }),
    focus: false,
    toggleFocus: () => set({ focus: !get().focus }),
    setWidth: (width) => save({ width: width === null ? null : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width))) }),
    // Asking for the sidebar while focused ends focus mode and shows it.
    toggleSidebar: () => {
      if (get().compact) set({ focus: false, compactOpen: get().focus || !get().compactOpen });
      else if (get().focus || get().hidden) { set({ focus: false }); save({ collapsed: false, hidden: false }); }
      else save({ collapsed: !get().collapsed });
    },
    // Hiding preserves whether navigation was expanded or an icon rail.
    toggleSidebarVisibility: () => {
      if (get().compact) get().toggleSidebar();
      else if (get().focus) { set({ focus: false }); save({ hidden: false }); }
      else save({ hidden: !get().hidden });
    },
    setCollapsed: (collapsed) => save({ collapsed }),
    toggleRecent: () => save({ recentOpen: !get().recentOpen }),
  };
});

export const sidebarRail = (s: LayoutState) => !s.focus && !s.hidden && !s.compact && s.collapsed;

/** Fully hidden, rather than collapsed into the desktop rail. */
export const sidebarInvisible = (s: LayoutState) => s.focus || (s.compact ? !s.compactOpen : s.hidden);
export const sidebarHidden = (s: LayoutState) => sidebarInvisible(s) || (!s.compact && s.collapsed);
