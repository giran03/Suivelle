import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { TONES, type Tone } from "./extensions/tone";
import { pageLinkTarget } from "../../lib/legacy";

type Mode = "marks" | "link" | "color";

/** Only web and mail links are allowed; a bare domain gets https://. */
export function normalizeHref(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  const page = pageLinkTarget(v.toLowerCase());
  if (page && /^[0-9a-f-]{36}$/i.test(page)) return `suivelle://page/${page}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // javascript:, data:, file: ...
  return `https://${v}`;
}

function setTone(editor: Editor, patch: { fg?: Tone | null; bg?: Tone | null }) {
  const cur = editor.getAttributes("tone") as { fg?: Tone | null; bg?: Tone | null };
  const next = { fg: cur.fg ?? null, bg: cur.bg ?? null, ...patch };
  if (!next.fg && !next.bg) editor.chain().focus().unsetMark("tone").run();
  else editor.chain().focus().setMark("tone", next).run();
}

export function SelectionToolbar({ editor }: { editor: Editor }) {
  const [mode, setMode] = useState<Mode>("marks");
  const [href, setHref] = useState("");
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      linkHref: (e.getAttributes("link").href as string | undefined) ?? "",
      fg: (e.getAttributes("tone").fg as Tone | null | undefined) ?? null,
      bg: (e.getAttributes("tone").bg as Tone | null | undefined) ?? null,
    }),
  });

  // Start from the formatting row each time a new selection is made.
  useEffect(() => {
    const reset = () => editor.state.selection.empty && setMode("marks");
    editor.on("selectionUpdate", reset);
    return () => void editor.off("selectionUpdate", reset);
  }, [editor]);

  const keepSelection = (e: React.MouseEvent) => e.preventDefault();
  const mark = (name: "bold" | "italic" | "underline" | "strike" | "code") => () => {
    const c = editor.chain().focus();
    ({ bold: c.toggleBold, italic: c.toggleItalic, underline: c.toggleUnderline, strike: c.toggleStrike, code: c.toggleCode })[name].call(c).run();
  };

  const applyLink = () => {
    const url = normalizeHref(href);
    if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    else if (!href.trim()) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setMode("marks");
  };

  return (
    <BubbleMenu
      editor={editor}
      className="bubble"
      appendTo={() => document.body}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, state }) =>
        e.isEditable &&
        state.selection instanceof TextSelection &&
        !state.selection.empty &&
        !e.isActive("codeBlock") &&
        !e.isActive("table")
      }
    >
      {mode === "link" ? (
        <form
          className="bubble-link"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            value={href}
            placeholder="Paste or type a link"
            aria-label="Link address"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setMode("marks");
                editor.commands.focus();
              }
            }}
          />
          {s.link && (
            <button
              type="button"
              className="bubble-btn text"
              onMouseDown={keepSelection}
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setMode("marks");
              }}
            >
              Remove
            </button>
          )}
          <button type="submit" className="bubble-btn text primary">
            Apply
          </button>
        </form>
      ) : mode === "color" ? (
        <div className="bubble-colors" role="group" aria-label="Colors">
          <div className="swatch-row">
            <span className="swatch-label">Text</span>
            <button type="button" className={`swatch none${!s.fg ? " on" : ""}`} aria-label="Default text color" title="Default" onMouseDown={keepSelection} onClick={() => setTone(editor, { fg: null })} />
            {TONES.map((t) => (
              <button key={t} type="button" className={`swatch fg${s.fg === t ? " on" : ""}`} data-fg={t} aria-label={`${t} text`} title={t} onMouseDown={keepSelection} onClick={() => setTone(editor, { fg: t })}>
                A
              </button>
            ))}
          </div>
          <div className="swatch-row">
            <span className="swatch-label">Fill</span>
            <button type="button" className={`swatch none${!s.bg ? " on" : ""}`} aria-label="No background" title="None" onMouseDown={keepSelection} onClick={() => setTone(editor, { bg: null })} />
            {TONES.map((t) => (
              <button key={t} type="button" className={`swatch bg${s.bg === t ? " on" : ""}`} data-bg={t} aria-label={`${t} background`} title={t} onMouseDown={keepSelection} onClick={() => setTone(editor, { bg: t })} />
            ))}
          </div>
          <button type="button" className="bubble-btn text" onMouseDown={keepSelection} onClick={() => setMode("marks")}>
            Done
          </button>
        </div>
      ) : (
        <div className="bubble-row" role="toolbar" aria-label="Text formatting">
          <button type="button" className={`bubble-btn${s.bold ? " on" : ""}`} aria-label="Bold" aria-pressed={s.bold} title="Bold (Ctrl+B)" onMouseDown={keepSelection} onClick={mark("bold")}>
            <b>B</b>
          </button>
          <button type="button" className={`bubble-btn${s.italic ? " on" : ""}`} aria-label="Italic" aria-pressed={s.italic} title="Italic (Ctrl+I)" onMouseDown={keepSelection} onClick={mark("italic")}>
            <i>I</i>
          </button>
          <button type="button" className={`bubble-btn${s.underline ? " on" : ""}`} aria-label="Underline" aria-pressed={s.underline} title="Underline (Ctrl+U)" onMouseDown={keepSelection} onClick={mark("underline")}>
            <u>U</u>
          </button>
          <button type="button" className={`bubble-btn${s.strike ? " on" : ""}`} aria-label="Strikethrough" aria-pressed={s.strike} title="Strikethrough (Ctrl+Shift+S)" onMouseDown={keepSelection} onClick={mark("strike")}>
            <s>S</s>
          </button>
          <button type="button" className={`bubble-btn${s.code ? " on" : ""}`} aria-label="Inline code" aria-pressed={s.code} title="Inline code (Ctrl+E)" onMouseDown={keepSelection} onClick={mark("code")}>
            <Icon name="code" />
          </button>
          <span className="bubble-sep" aria-hidden="true" />
          <button
            type="button"
            className={`bubble-btn${s.link ? " on" : ""}`}
            aria-label="Link"
            aria-pressed={s.link}
            title="Link"
            onMouseDown={keepSelection}
            onClick={() => {
              setHref(s.linkHref);
              setMode("link");
            }}
          >
            <Icon name="link" />
          </button>
          <button type="button" className={`bubble-btn${s.fg || s.bg ? " on" : ""}`} aria-label="Colors" title="Colors" onMouseDown={keepSelection} onClick={() => setMode("color")}>
            <span className="color-a" data-fg={s.fg ?? undefined} data-bg={s.bg ?? undefined}>
              A
            </span>
          </button>
        </div>
      )}
    </BubbleMenu>
  );
}
