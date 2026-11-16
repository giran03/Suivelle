import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import type { FormulaPreview } from "../../types";
import {
  FORMULA_FUNCTIONS,
  activeParam,
  completionAt,
  errorSpan,
  functionAtCursor,
  quoteName,
  signatureParams,
  suggestFunctions,
  suggestProperties,
  type Completion,
} from "./formulaFunctions";
import { formatFormulaValue } from "./model";

type Suggestion = { key: string; label: string; detail: string };

const FUNCTION_GROUPS = Array.from(new Set(FORMULA_FUNCTIONS.map((f) => f.group)));

/** Expression field with a live result: errors point at the problem, samples show real records. */
export function FormulaEditor({
  databaseId,
  propertyId,
  value,
  onChange,
}: {
  databaseId: string;
  /** The formula being edited, so it is left out of what it can refer to. */
  propertyId?: string;
  value: string;
  onChange: (expression: string) => void;
}) {
  const [preview, setPreview] = useState<FormulaPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const helpId = useId();
  const errId = useId();
  const hintId = useId();
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      ipc
        .formulaPreview(databaseId, value, propertyId)
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setFailure(null);
        })
        .catch((e) => !cancelled && setFailure(toAppError(e).message));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [databaseId, propertyId, value]);

  const propertyNames = preview?.properties;
  const completion = useMemo<Completion | null>(() => completionAt(value, caret), [value, caret]);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!completion) return [];
    if (completion.kind === "property") {
      return suggestProperties(propertyNames ?? [], completion.prefix).map((n) => ({ key: n, label: n, detail: "property" }));
    }
    const found = suggestFunctions(completion.prefix);
    // Nothing to add once a whole name is followed by its parenthesis.
    if (found.length === 1 && found[0].name === completion.prefix && value[completion.to] === "(") return [];
    return found.map((f) => ({ key: f.name, label: f.signature, detail: f.description }));
  }, [completion, propertyNames, value]);
  const open = focused && !dismissed && suggestions.length > 0;
  const current = Math.min(active, Math.max(0, suggestions.length - 1));

  const place = (text: string, pos: number) => {
    onChange(text);
    setCaret(pos);
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const insert = (text: string, caretBack = 0) => {
    const el = area.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
    place(value.slice(0, at[0]) + text + value.slice(at[1]), at[0] + text.length - caretBack);
  };

  const accept = (index: number) => {
    const item = suggestions[index];
    if (!completion || !item) return;
    if (completion.kind === "property") {
      const quoted = quoteName(item.key);
      const text = value.slice(0, completion.from) + quoted + (completion.closed ? "" : '"') + value.slice(completion.to);
      place(text, completion.from + quoted.length + 1);
    } else {
      const call = value[completion.to] === "(" ? item.key : `${item.key}()`;
      place(value.slice(0, completion.from) + call + value.slice(completion.to), completion.from + item.key.length + 1);
    }
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(current);
    } else if (e.key === "Escape") {
      // Keep Escape from closing the panel that holds the editor.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
    }
  };

  const error = preview?.error;
  const where = error ? lineColumn(value, error.position) : null;
  const call = focused ? functionAtCursor(value, caret) : null;

  const selectError = () => {
    if (!error) return;
    const span = errorSpan(value, error.position);
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(span.start, span.end);
    setCaret(span.start);
  };

  return (
    <div className="formula-editor">
      <label className="field">
        <span>Formula</span>
        <textarea
          ref={area}
          className="formula-input"
          value={value}
          rows={4}
          spellCheck={false}
          maxLength={2000}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${current}` : undefined}
          aria-invalid={!!error}
          aria-describedby={`${helpId} ${call ? hintId : ""} ${error ? errId : ""}`.trim()}
          placeholder={'prop("Price") * prop("Quantity")'}
          onChange={(e) => {
            setCaret(e.target.selectionStart);
            setDismissed(false);
            setActive(0);
            onChange(e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
      </label>
      {open && (
        <ul id={listId} className="picker-list formula-suggest" role="listbox" aria-label="Suggestions">
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className={`picker-item${i === current ? " active" : ""}`}
              // Keep the caret in the textarea while picking.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(i);
              }}
            >
              <code>{s.label}</code>
              <span className="picker-muted">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {call && (
        <p id={hintId} className="formula-hint">
          <code>
            {call.fn.name}(
            {signatureParams(call.fn.signature).map((p, i, all) => (
              <Fragment key={i}>
                {i === activeParam(call.fn.signature, call.argIndex) ? <strong>{p}</strong> : p}
                {i < all.length - 1 && ", "}
              </Fragment>
            ))}
            )
          </code>
          <span className="picker-muted">{call.fn.description}</span>
        </p>
      )}
      <p id={helpId} className="picker-muted">
        Refer to a property as <code>prop("Name")</code>.
      </p>
      {(error || failure) && (
        <p id={errId} className="field-error" role="alert">
          {failure ?? error?.message}
          {!failure && where && ` (line ${where.line}, column ${where.column})`}
        </p>
      )}
      {error && !failure && <ErrorLine text={value} position={error.position} onSelect={selectError} />}
      {preview && !error && (
        <div className="formula-preview" aria-live="polite">
          <div className="picker-group">Result{preview.resultType && preview.resultType !== "any" ? ` · ${preview.resultType === "bool" ? "true/false" : preview.resultType}` : ""}</div>
          {preview.samples.length === 0 ? (
            <p className="picker-muted">Add records to see results.</p>
          ) : (
            <ul>
              {preview.samples.map((s, i) => (
                <li key={i}>
                  <span className="formula-sample-title">{s.title || "Untitled"}</span>
                  <span className="formula-sample-value">{formatFormulaValue(s.value) || "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <details className="formula-insert">
        <summary>Properties</summary>
        <div className="formula-chips">
          {(preview?.properties ?? []).map((name) => (
            <button key={name} type="button" className="chip" onClick={() => insert(`prop("${quoteName(name)}")`)}>
              {name}
            </button>
          ))}
        </div>
      </details>
      <details className="formula-insert">
        <summary>Functions</summary>
        <ul className="formula-fns">
          {FUNCTION_GROUPS.map((group) => (
            <Fragment key={group}>
              <li className="picker-group">{group}</li>
              {FORMULA_FUNCTIONS.filter((f) => f.group === group).map((f) => (
                <li key={f.name}>
                  <button type="button" className="chip" title={f.description} onClick={() => insert(`${f.name}()`, 1)}>
                    {f.signature}
                  </button>
                  <span className="picker-muted">{f.description}</span>
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
      </details>
    </div>
  );
}

const CONTEXT = 40;

/** The failing line with the problem marked; pressing it selects that spot in the formula. */
function ErrorLine({ text, position, onSelect }: { text: string; position: number; onSelect: () => void }) {
  const span = errorSpan(text, position);
  const from = span.start - span.lineStart;
  const to = span.end - span.lineStart;
  const cutBefore = Math.max(0, from - CONTEXT);
  const before = span.line.slice(cutBefore, from);
  const mark = span.line.slice(from, to);
  const after = span.line.slice(to, to + CONTEXT);
  return (
    <button type="button" className="formula-error-line" onClick={onSelect} title="Select this in the formula">
      <code>
        {cutBefore > 0 && "…"}
        {before}
        <mark>{mark}</mark>
        {after}
        {to + CONTEXT < span.line.length && "…"}
      </code>
    </button>
  );
}

function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = Array.from(text).slice(0, position).join("");
  const lines = before.split("\n");
  return { line: lines.length, column: Array.from(lines[lines.length - 1]).length + 1 };
}
