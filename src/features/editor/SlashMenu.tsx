import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useSlash } from "./extensions/slash";
import { editorDom } from "./editorDom";
import type { BlockKind } from "./blockKinds";

export function KindIcon({ kind }: { kind: BlockKind }) {
  return <span className="kind-icon">{kind.icon ? <Icon name={kind.icon} /> : <span className="kind-glyph">{kind.glyph}</span>}</span>;
}

/** Slash menu: a combobox-style listbox under the caret. Keyboard handling lives in the suggestion plugin. */
export function SlashMenu({ editor }: { editor: Editor }) {
  const open = useSlash((s) => s.open);
  const items = useSlash((s) => s.items);
  const index = useSlash((s) => s.index);
  const query = useSlash((s) => s.query);
  const rect = useSlash((s) => s.rect);
  const choose = useSlash((s) => s.choose);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const anchor = rect?.();
    if (!anchor) return;
    const h = ref.current.offsetHeight;
    const w = ref.current.offsetWidth;
    const below = anchor.bottom + 6;
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8)),
      top: below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 6) : below,
    });
  }, [open, rect, items, query]);

  // Announce the popup to assistive tech on the editor itself, which keeps real focus.
  useLayoutEffect(() => {
    const dom = editorDom(editor);
    if (!dom) return;
    if (!open) {
      ["aria-expanded", "aria-controls", "aria-activedescendant", "aria-haspopup"].forEach((a) => dom.removeAttribute(a));
      return;
    }
    dom.setAttribute("aria-haspopup", "listbox");
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-controls", "slash-listbox");
    if (items.length) dom.setAttribute("aria-activedescendant", `slash-opt-${index}`);
    else dom.removeAttribute("aria-activedescendant");
  }, [editor, open, index, items.length]);

  useLayoutEffect(() => {
    ref.current?.querySelector(`#slash-opt-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  if (!open) return null;

  // Group headings only make sense in catalog order, not in ranked search results.
  const grouped = !query.trim();
  return (
    <div
      ref={ref}
      className="menu slash-menu"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div id="slash-listbox" role="listbox" aria-label="Insert a block">
        {items.length === 0 && <p className="slash-empty">No blocks match “{query}”</p>}
        {items.map((kind, i) => (
          <div key={kind.id}>
            {grouped && (i === 0 || items[i - 1].group !== kind.group) && <div className="slash-group">{kind.group}</div>}
            <div
              id={`slash-opt-${i}`}
              role="option"
              aria-selected={i === index}
              className={`slash-item${i === index ? " active" : ""}`}
              onMouseMove={() => i !== index && useSlash.setState({ index: i })}
              onClick={() => choose?.(kind)}
            >
              <KindIcon kind={kind} />
              <span className="slash-text">
                <span className="slash-title">{kind.title}</span>
                <span className="slash-desc">{kind.description}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
