import { ACTIONS, effective, format, type Scope } from "./bindings";
import { useShortcuts } from "./store";
import { useSettingsDialog } from "../settings/store";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { Icon } from "../../components/Icon";
import { syncDialog } from "../../lib/dialog";

interface SheetState {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

export const useShortcutSheet = create<SheetState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

const GROUPS: { title: string; rows: [string, string[]][] }[] = [
  {
    title: "Markdown shortcuts",
    rows: [
      ["Heading 1, 2, 3", ["#", "##", "###", "+ Space"]],
      ["Bulleted list", ["-", "+ Space"]],
      ["Numbered list", ["1.", "+ Space"]],
      ["To-do", ["[", "]", "+ Space"]],
      ["Quote", [">", "+ Space"]],
      ["Code block", ["```"]],
      ["Divider", ["---"]],
    ],
  },
];

/** A read-only reference sheet; opened with Ctrl/Cmd+/ or "?" outside a text field. */
export function ShortcutSheet() {
  const overrides = useShortcuts(s => s.overrides);
  const names: Record<Scope, string> = { workspace: "Workspace", editor: "Writing", pages: "Page tree", grid: "Database grid", tab: "Tabs", capture: "Quick capture" };
  const groups = [...Object.entries(names).map(([scope, title]) => ({ title, rows: ACTIONS.filter(a => a.scope === scope).map(a => [a.title, effective(a.id, overrides).map(format).length ? effective(a.id, overrides).map(format) : ["Unassigned"]] as [string, string[]]) })), ...GROUPS.filter(g => g.title === "Markdown shortcuts"), { title: "Built-in navigation", rows: [["Move focus / cancel", ["Tab", "Escape"]], ["Navigate trees and grids", ["Arrow keys"]]] as [string, string[]][] }];
  const open = useShortcutSheet((s) => s.open);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="palette shortcuts"
      aria-label="Keyboard shortcuts"
      onClose={() => useShortcutSheet.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useShortcutSheet.getState().hide();
      }}
    >
      {open && (
        <>
          <div className="shortcuts-head">
            <h2>Shortcuts</h2>
            <button type="button" className="btn" onClick={() => { useShortcutSheet.getState().hide(); useSettingsDialog.getState().show("keyboard"); }}>Customize…</button>
            <button className="icon-btn" aria-label="Close" onClick={() => useShortcutSheet.getState().hide()}>
              <Icon name="close" />
            </button>
          </div>
          <div className="shortcuts-body">
            {groups.map((g) => (
              <section key={g.title}>
                <h3>{g.title}</h3>
                <dl>
                  {g.rows.map(([label, keys]) => (
                    <div key={label} className="sc-row">
                      <dt>{label}</dt>
                      <dd>
                        {keys.map((k, i) =>
                          k.startsWith("+ ") ? (
                            <span key={i} className="sc-then">
                              {k.slice(2)}
                            </span>
                          ) : (
                            <kbd key={i} className="kbd">
                              {k}
                            </kbd>
                          ),
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </>
      )}
    </dialog>
  );
}
