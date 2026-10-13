import { useEffect, useId, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import type { FormulaPreview } from "../../types";
import { formatFormulaValue } from "./model";

const FUNCTIONS: { name: string; sig: string; doc: string }[] = [
  { name: "if", sig: "if(condition, then, else)", doc: "One value or the other." },
  { name: "ifs", sig: "ifs(cond1, value1, cond2, value2, …, else)", doc: "The first condition that holds." },
  { name: "empty", sig: "empty(value)", doc: "True when nothing is set." },
  { name: "length", sig: "length(text or list)", doc: "Characters or items." },
  { name: "contains", sig: "contains(text or list, item)", doc: "Whether it includes the item." },
  { name: "concat", sig: "concat(a, b, …)", doc: "Join values into text." },
  { name: "format", sig: "format(value)", doc: "A value as text." },
  { name: "toNumber", sig: "toNumber(text)", doc: "Text as a number." },
  { name: "round", sig: "round(number, digits)", doc: "Round to digits." },
  { name: "floor", sig: "floor(number)", doc: "Round down." },
  { name: "ceil", sig: "ceil(number)", doc: "Round up." },
  { name: "abs", sig: "abs(number)", doc: "Remove the sign." },
  { name: "min", sig: "min(a, b, …)", doc: "Smallest." },
  { name: "max", sig: "max(a, b, …)", doc: "Largest." },
  { name: "now", sig: "now()", doc: "This moment." },
  { name: "today", sig: "today()", doc: "Today's date." },
  { name: "dateAdd", sig: "dateAdd(date, amount, unit)", doc: "Units: minutes, hours, days, weeks, months, years." },
  { name: "dateSubtract", sig: "dateSubtract(date, amount, unit)", doc: "Same units as dateAdd." },
  { name: "formatDate", sig: "formatDate(date, \"YYYY-MM-DD\")", doc: "Tokens: YYYY MMMM MMM MM DD HH mm." },
];

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
  const area = useRef<HTMLTextAreaElement>(null);
  const helpId = useId();
  const errId = useId();

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

  const insert = (text: string, caretBack = 0) => {
    const el = area.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
    onChange(value.slice(0, at[0]) + text + value.slice(at[1]));
    window.requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = at[0] + text.length - caretBack;
      el.setSelectionRange(pos, pos);
    });
  };

  const error = preview?.error;
  const where = error ? lineColumn(value, error.position) : null;

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
          aria-invalid={!!error}
          aria-describedby={`${helpId} ${error ? errId : ""}`}
          placeholder={'prop("Price") * prop("Quantity")'}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <p id={helpId} className="picker-muted">
        Refer to a property as <code>prop("Name")</code>.
      </p>
      {(error || failure) && (
        <p id={errId} className="field-error" role="alert">
          {failure ?? error?.message}
          {where && ` (line ${where.line}, column ${where.column})`}
        </p>
      )}
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
            <button key={name} type="button" className="chip" onClick={() => insert(`prop("${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`)}>
              {name}
            </button>
          ))}
        </div>
      </details>
      <details className="formula-insert">
        <summary>Functions</summary>
        <ul className="formula-fns">
          {FUNCTIONS.map((f) => (
            <li key={f.name}>
              <button type="button" className="chip" title={f.doc} onClick={() => insert(`${f.name}()`, 1)}>
                {f.sig}
              </button>
              <span className="picker-muted">{f.doc}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = Array.from(text).slice(0, position).join("");
  const lines = before.split("\n");
  return { line: lines.length, column: Array.from(lines[lines.length - 1]).length + 1 };
}
