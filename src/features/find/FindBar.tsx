import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useActiveEditor } from "../../stores/activeEditor";
import { clearFind, getFind, replaceAll, replaceCurrent, setFind, stepFind, revealCurrent } from "../editor/extensions/find";
import "./find.css";

import { useFindBar } from "./store";
export { useFindBar } from "./store";


/** Find (and replace) inside the open page. Ctrl/Cmd+F opens it, Ctrl/Cmd+H opens it with replace. */
export function FindBar() {
  const open = useFindBar((s) => s.open);
  const editor = useActiveEditor((s) => s.editor);
  // The bar belongs to one page's editor: when the page changes it closes.
  useEffect(() => {
    if (open && !editor) useFindBar.getState().hide();
  }, [open, editor]);
  if (!open || !editor) return null;
  return <FindBarBody />;
}

function FindBarBody() {
  const editor = useActiveEditor((s) => s.editor)!;
  const showReplace = useFindBar((s) => s.replace);
  const nonce = useFindBar((s) => s.nonce);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [, tick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const editable = editor.isEditable;

  // Start from whatever text is selected, as people expect.
  useEffect(() => {
    const { from, to, empty } = editor.state.selection;
    const picked = !empty && to - from < 200 ? editor.state.doc.textBetween(from, to, " ") : "";
    if (picked && !picked.includes("\n")) {
      setQuery(picked);
      setFind(editor, { query: picked });
    } else if (query) setFind(editor, { query });
    input.current?.focus();
    input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  // Re-render when the document changes so the count stays right while typing in the page.
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    editor.on("transaction", on);
    return () => {
      editor.off("transaction", on);
    };
  }, [editor]);

  // Closing leaves the page clean: no highlights, and the caret where it was.
  useEffect(
    () => () => {
      clearFind(editor);
    },
    [editor],
  );

  const state = getFind(editor);
  const total = state.matches.length;
  const none = query.length > 0 && total === 0;

  const close = () => {
    useFindBar.getState().hide();
    if (!editor.isDestroyed) editor.commands.focus();
  };

  return (
    <div className="find-bar" role="search" aria-label="Find in page">
      <div className="find-row">
        <Icon name="search" size={14} />
        <input
          ref={input}
          value={query}
          placeholder="Find in page"
          aria-label="Find in page"
          aria-invalid={none}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setFind(editor, { query: e.target.value });
            revealCurrent(editor);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              stepFind(editor, e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <span className={`find-count${none ? " none" : ""}`} aria-live="polite">
          {query ? (total ? `${state.index + 1} of ${total}` : "No results") : ""}
        </span>
        <button
          className={`icon-btn${caseSensitive ? " on" : ""}`}
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => {
            setCaseSensitive(!caseSensitive);
            setFind(editor, { caseSensitive: !caseSensitive });
          }}
        >
          <span className="find-aa">Aa</span>
        </button>
        <button
          className={`icon-btn${wholeWord ? " on" : ""}`}
          aria-label="Whole word"
          aria-pressed={wholeWord}
          title="Whole word"
          onClick={() => {
            setWholeWord(!wholeWord);
            setFind(editor, { wholeWord: !wholeWord });
          }}
        >
          <span className="find-aa find-word">ab</span>
        </button>
        <button className="icon-btn" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!total} onClick={() => stepFind(editor, -1)}>
          <Icon name="arrowUp" size={14} />
        </button>
        <button className="icon-btn" aria-label="Next match" title="Next (Enter)" disabled={!total} onClick={() => stepFind(editor, 1)}>
          <Icon name="arrowDown" size={14} />
        </button>
        {editable && (
          <button
            className={`icon-btn${showReplace ? " on" : ""}`}
            aria-label="Show replace"
            aria-pressed={showReplace}
            title="Replace"
            onClick={() => useFindBar.setState({ replace: !showReplace })}
          >
            <Icon name="edit" size={14} />
          </button>
        )}
        <button className="icon-btn" aria-label="Close find" title="Close (Esc)" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {showReplace && editable && (
        <div className="find-row">
          <Icon name="edit" size={14} />
          <input
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace with"
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                replaceCurrent(editor, replacement);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
          <button className="btn" disabled={!total} onClick={() => replaceCurrent(editor, replacement)}>
            Replace
          </button>
          <button
            className="btn"
            disabled={!total}
            onClick={() => {
              const n = replaceAll(editor, replacement);
              if (n) import("../../stores/workspace").then(({ useWorkspace }) => useWorkspace.getState().notify(`Replaced ${n} ${n === 1 ? "match" : "matches"}`));
            }}
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}
