import { useShortcutScope } from "../shortcuts/runtime";
import { selectPageGesture, usePageSelection, pickedRoots } from "./pageSelection";
import { copyHierarchyPages, pasteHierarchyPages } from "./pageClipboard";
import { trashPages } from "./pageBatch";
import { openInNewTab } from "../tabs/tabs";
import { READ_ONLY } from "../../lib/access";
import { createContext, useContext, useId, useRef, type HTMLAttributes, type ReactNode } from "react";
import { create } from "zustand";
import { handleTreeKeys } from "./treeKeys";

/** Which row of each tree last held focus, so that Tab comes back to it: a tree is one tab stop. */
const useTreeStop = create<{ at: Record<string, string>; set: (tree: string, key: string) => void }>((set) => ({
  at: {},
  set: (tree, key) => set((s) => (s.at[tree] === key ? s : { at: { ...s.at, [tree]: key } })),
}));

const TreeCtx = createContext<{ name: string; stop: string | null }>({ name: "", stop: null });

/**
 * A list of pages as an ARIA tree. `keys` are the keys of the rows on screen, top to bottom: the row that
 * last had focus is the tab stop, or the first row when it is gone. Arrow keys, Home, End, type-ahead, Enter
 * and the context-menu key are handled here; see treeKeys.ts.
 */
export function Tree({ name, label, keys, className, children }: { name: string; label: string; keys: string[]; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const page = (target: Element, event: KeyboardEvent | MouseEvent) => {
    const row = target.closest<HTMLElement>('[role="treeitem"]');
    if (!row || (!("key" in event) && !target.closest(".title"))) return null;
    return row.dataset.key ?? null;
  };
  useShortcutScope(ref, "pages", {
    "page-new-tab": (t, e) => { const id = page(t, e); if (!id) return false; void openInNewTab(id); },
    "page-pick": (t, e) => { const id = page(t, e); if (!id) return false; selectPageGesture(t, id, "toggle"); },
    "page-range": (t, e) => { const id = page(t, e); if (!id) return false; selectPageGesture(t, id, "range"); },
    "page-select-all": () => { usePageSelection.setState({ ids: keys, anchor: keys[0] ?? null }); },
    "page-copy": (t, e) => { if (READ_ONLY) return false; return copyHierarchyPages(page(t, e) ?? undefined); },
    "page-paste": (t, e) => { if (READ_ONLY) return false; return pasteHierarchyPages(page(t, e) ?? undefined); },
    "page-trash": () => { const pages = pickedRoots(); if (READ_ONLY || !pages.length) return false; void trashPages(pages).then(() => ref.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus()); },
  });
  const last = useTreeStop((s) => s.at[name]);
  const stop = last && keys.includes(last) ? last : (keys[0] ?? null);
  return (
    <TreeCtx.Provider value={{ name, stop }}>
      <ul ref={ref} role="tree" aria-label={label} aria-multiselectable="true" className={className ?? "tree"} onKeyDown={handleTreeKeys}>
        {children}
      </ul>
    </TreeCtx.Provider>
  );
}

interface ItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  itemKey: string;
  /** Spoken name; the buttons inside the row are for the pointer and hidden from assistive technology. */
  label: string;
  level: number;
  index: number;
  count: number;
  /** Set only for rows that have children. */
  expanded?: boolean;
  selected: boolean;
  /** Picked with Ctrl+click or Shift+click (the open page is `selected`). */
  picked?: boolean;
  /** The rows nested under this one, shown while it is expanded. */
  group?: { style?: React.CSSProperties; children: ReactNode } | null;
  ref?: React.Ref<HTMLDivElement>;
}

/** One row of a Tree. Keep the row's own buttons out of the tab order (tabIndex -1) and aria-hidden. */
export function TreeItem({ itemKey, label, level, index, count, expanded, selected, picked, group, onFocus, children, ...rest }: ItemProps) {
  const groupId = useId();
  const { name, stop } = useContext(TreeCtx);
  return (
    <li role="none">
      <div
        {...rest}
        role="treeitem"
        data-key={itemKey}
        aria-label={label}
        aria-level={level}
        aria-setsize={count}
        aria-posinset={index + 1}
        aria-expanded={expanded}
        aria-owns={group ? groupId : undefined}
        aria-selected={selected || !!picked}
        aria-current={selected ? "page" : undefined}
        tabIndex={stop === itemKey ? 0 : -1}
        onFocus={(e) => {
          onFocus?.(e);
          // A click on one of the row's buttons leaves focus on the row, where the arrow keys work.
          if (e.target !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
          useTreeStop.getState().set(name, itemKey);
        }}
      >
        {children}
      </div>
      {group && (
        <ul id={groupId} role="group" style={group.style}>
          {group.children}
        </ul>
      )}
    </li>
  );
}
