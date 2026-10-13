import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { useActiveEditor } from "../../stores/activeEditor";
import { Icon } from "../../components/Icon";
import { collectHeadings } from "../editor/extensions/tableOfContents";
import { useOutline } from "./store";
import "./outline.css";

/** Words, characters and an estimated reading time (230 words a minute) for the page's text. */
export function textStats(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return { words, characters: text.replace(/\s/g, "").length, minutes: words ? Math.max(1, Math.round(words / 230)) : 0 };
}

const pageText = (editor: Editor) => editor.state.doc.textBetween(0, editor.state.doc.content.size, " ", " ");

/** The headings of the open page with the current section marked, plus word count. */
export function OutlinePanel() {
  const editor = useActiveEditor((s) => s.editor);
  const open = useOutline((s) => s.open);
  const [, redraw] = useState(0);
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    if (!editor || !open) return;
    let timer: number | undefined;
    const refresh = () => { window.clearTimeout(timer); timer = window.setTimeout(() => redraw((n) => n + 1), 200); };
    const onTransaction = ({ transaction }: { transaction: Editor["state"]["tr"] }) => { if (transaction.docChanged) refresh(); };
    editor.on("transaction", onTransaction);
    // The section in view: the last heading that has scrolled past the top of the page area.
    const scroller = editor.view.dom.closest(".main-scroll");
    const onScroll = () => {
      if (editor.isDestroyed) return;
      const top = (scroller?.getBoundingClientRect().top ?? 0) + 96;
      let index = -1;
      collectHeadings(editor).forEach((h, i) => {
        const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null;
        if (dom && dom.getBoundingClientRect().top <= top) index = i;
      });
      setCurrent(index);
    };
    onScroll();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.clearTimeout(timer); editor.off("transaction", onTransaction); scroller?.removeEventListener("scroll", onScroll); };
  }, [editor, open]);

  if (!open || !editor || editor.isDestroyed) return null;
  const headings = collectHeadings(editor);
  const stats = textStats(pageText(editor));
  const top = headings.length ? Math.min(...headings.map((h) => h.level)) : 1;
  const go = (pos: number) => {
    (editor.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: "start", behavior: "smooth" });
    editor.chain().setTextSelection(pos + 1).focus(undefined, { scrollIntoView: false }).run();
  };

  return <aside className="outline-panel" aria-label="Page outline">
    <div className="outline-head">
      <span>Outline</span>
      <button type="button" className="icon-btn" aria-label="Hide outline" title="Hide outline" onClick={() => useOutline.getState().toggle()}><Icon name="close" size={14} /></button>
    </div>
    {headings.length === 0
      ? <p className="outline-empty">Headings you add appear here.</p>
      : <nav className="outline-list">{headings.map((h, i) =>
          <button key={`${h.pos}:${i}`} type="button" className={`outline-item${i === current ? " current" : ""}`} aria-current={i === current ? "location" : undefined}
            style={{ paddingInlineStart: 8 + (h.level - top) * 14 }} onClick={() => go(h.pos)}>{h.text || "Untitled"}</button>)}
        </nav>}
    <p className="outline-stats" aria-live="polite">
      {stats.words.toLocaleString()} {stats.words === 1 ? "word" : "words"} · {stats.characters.toLocaleString()} characters{stats.minutes ? ` · ${stats.minutes} min read` : ""}
    </p>
  </aside>;
}
