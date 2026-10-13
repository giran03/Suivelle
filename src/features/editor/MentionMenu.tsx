import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useMentionMenu } from "./extensions/mention";
import { editorDom } from "./editorDom";

/** "@" menu: recent pages first, then title matches. Keyboard handling lives in the suggestion plugin. */
export function MentionMenu({ editor }: { editor: Editor }) {
  const open = useMentionMenu((s) => s.open);
  const items = useMentionMenu((s) => s.items);
  const index = useMentionMenu((s) => s.index);
  const query = useMentionMenu((s) => s.query);
  const rect = useMentionMenu((s) => s.rect);
  const choose = useMentionMenu((s) => s.choose);
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

  useLayoutEffect(() => {
    const dom = editorDom(editor);
    if (!dom) return;
    if (!open) {
      if (dom.getAttribute("aria-controls") === "mention-listbox") {
        ["aria-expanded", "aria-controls", "aria-activedescendant", "aria-haspopup"].forEach((a) => dom.removeAttribute(a));
      }
      return;
    }
    dom.setAttribute("aria-haspopup", "listbox");
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-controls", "mention-listbox");
    if (items.length) dom.setAttribute("aria-activedescendant", `mention-opt-${index}`);
    else dom.removeAttribute("aria-activedescendant");
  }, [editor, open, index, items.length]);

  useLayoutEffect(() => {
    ref.current?.querySelector(`#mention-opt-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className="menu slash-menu"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div id="mention-listbox" role="listbox" aria-label="Link to a page">
        {!query.trim() && items.length > 0 && <div className="slash-group">Recent pages</div>}
        {items.length === 0 && <p className="slash-empty">{query.trim() ? `No pages match “${query}”` : "Type to find a page to link"}</p>}
        {items.map((item, i) => (
          <div
            key={item.id}
            id={`mention-opt-${i}`}
            role="option"
            aria-selected={i === index}
            className={`slash-item${i === index ? " active" : ""}`}
            onMouseMove={() => i !== index && useMentionMenu.setState({ index: i })}
            onClick={() => choose?.(item)}
          >
            <span className="kind-icon">
              <Icon name="page" />
            </span>
            <span className="slash-text">
              <span className="slash-title">{item.title || "Untitled"}</span>
              {item.parentTitle && <span className="slash-desc">in {item.parentTitle}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
