import { createContext, useContext, useId, type HTMLAttributes, type ReactNode } from "react";
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
  const last = useTreeStop((s) => s.at[name]);
  const stop = last && keys.includes(last) ? last : (keys[0] ?? null);
  return (
    <TreeCtx.Provider value={{ name, stop }}>
      <ul role="tree" aria-label={label} aria-multiselectable="true" className={className ?? "tree"} onKeyDown={handleTreeKeys}>
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
