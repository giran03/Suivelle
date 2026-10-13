import { useEffect, useRef } from "react";
import { create } from "zustand";
import { Icon } from "../../components/Icon";
import { modKey } from "../palette/store";
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

const M = modKey;

const GROUPS: { title: string; rows: [string, string[]][] }[] = [
  {
    title: "Anywhere",
    rows: [
      ["Search pages and commands", [M, "K"]],
      ["New page", [M, "N"]],
      ["Show or hide the sidebar", [M, "\\"]],
      ["Focus mode", [M, "Shift", "\\"]],
      ["Keyboard shortcuts", [M, "/"]],
      ["Quick capture", [M, "Shift", "N"]],
      ["Quick capture from any program", ["Ctrl", "Alt", "N"]],
      ["Find in the page", [M, "F"]],
      ["Find and replace", [M, "H"]],
      ["Open a page in a new tab", ["Alt", "Click"]],
      ["Pick several pages", [M, "Click"]],
      ["Pick a range of pages", ["Shift", "Click"]],
      ["Pick every page in the list", [M, "A"]],
      ["Move the picked pages to trash", ["Delete"]],
      ["Next or previous tab", [M, "Tab"]],
      ["Close the tab", [M, "W"]],
      ["Go back", ["Alt", "←"]],
      ["Go forward", ["Alt", "→"]],
    ],
  },
  {
    title: "Writing",
    rows: [
      ["Insert a block", ["/"]],
      ["Mention a page", ["@"]],
      ["Bold", [M, "B"]],
      ["Italic", [M, "I"]],
      ["Underline", [M, "U"]],
      ["Strikethrough", [M, "Shift", "S"]],
      ["Inline code", [M, "E"]],
      ["Duplicate block", [M, "Shift", "D"]],
      ["Undo", [M, "Z"]],
      ["Redo", [M, "Shift", "Z"]],
    ],
  },
  {
    title: "Markdown shortcuts",
    rows: [
      ["Heading 1, 2, 3", ["#", "##", "###", "+ Space"]],
      ["Bulleted list", ["-", "+ Space"]],
      ["Numbered list", ["1.", "+ Space"]],
      ["To-do", ["[]", "+ Space"]],
      ["Quote", [">", "+ Space"]],
      ["Code block", ["```"]],
      ["Divider", ["---"]],
    ],
  },
  {
    title: "Databases",
    rows: [
      ["Move between cells", ["←", "↑", "↓", "→"]],
      ["Edit the cell", ["Enter"]],
      ["Open the record", ["Shift", "Enter"]],
      ["Clear the cell", ["Delete"]],
      ["Select or unselect the row", [M, "Space"]],
      ["Select every loaded row", [M, "A"]],
      ["Jump to first or last cell", [M, "Home / End"]],
      ["Cell menu", ["Shift", "F10"]],
    ],
  },
];

/** A read-only reference sheet; opened with Ctrl/Cmd+/ or "?" outside a text field. */
export function ShortcutSheet() {
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
            <h2>Keyboard shortcuts</h2>
            <button className="icon-btn" aria-label="Close" onClick={() => useShortcutSheet.getState().hide()}>
              <Icon name="close" />
            </button>
          </div>
          <div className="shortcuts-body">
            {GROUPS.map((g) => (
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
