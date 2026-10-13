import "../lib/legacy";
import { create } from "zustand";

const KEY = "suivelle.layout";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;

interface Saved {
  width: number | null;
  collapsed: boolean;
  recentOpen: boolean;
}

function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    const width = typeof v.width === "number" ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(v.width))) : null;
    return { width, collapsed: v.collapsed === true, recentOpen: v.recentOpen !== false };
  } catch {
    return { width: null, collapsed: false, recentOpen: true };
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
  /** Writing without the sidebar or toolbar in the way. Lasts for this session only. */
  focus: boolean;
  toggleFocus: () => void;
  setWidth: (width: number | null) => void;
  toggleSidebar: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleRecent: () => void;
}

export const useLayout = create<LayoutState>((set, get) => {
  const save = (patch: Partial<Saved>) => {
    set(patch);
    const { width, collapsed, recentOpen } = get();
    write({ width, collapsed, recentOpen });
  };
  return {
    ...read(),
    focus: false,
    toggleFocus: () => set({ focus: !get().focus }),
    setWidth: (width) => save({ width: width === null ? null : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width))) }),
    // Asking for the sidebar while focused ends focus mode and shows it.
    toggleSidebar: () => (get().focus ? (set({ focus: false }), save({ collapsed: false })) : save({ collapsed: !get().collapsed })),
    setCollapsed: (collapsed) => save({ collapsed }),
    toggleRecent: () => save({ recentOpen: !get().recentOpen }),
  };
});
