import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Property, RecordLink, SelectOption } from "../../types";
import { Tag } from "./cells";
import { optionsOf } from "./model";
import { describeParsed, parseNaturalDate } from "./naturalDate";
import { SearchField } from "../../components/SearchField";

// ---------------------------------------------------------------------------------------------
// inline text entry
// ---------------------------------------------------------------------------------------------

export type Move = "down" | "right" | "left" | null;

/** Turns what was typed into a value for the property, or an error message. */
export function parseEntry(type: Property["type"], text: string): { value: unknown } | { error: string } {
  if (type === "number") {
    const t = text.trim().replace(/,/g, "");
    if (t === "") return { value: null };
    const n = Number(t);
    return Number.isFinite(n) ? { value: n } : { error: "Enter a number" };
  }
  if (type === "title") return { value: text };
  return { value: text.trim() === "" ? null : text };
}

export function InlineEditor({
  initial,
  type,
  seeded,
  onDone,
}: {
  initial: string;
  type: Property["type"];
  /** The cell was opened by typing; keep the caret after the typed character instead of selecting all. */
  seeded: boolean;
  onDone: (result: { value: unknown } | null, move: Move) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (seeded) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  }, [seeded]);

  const finish = (commit: boolean, move: Move) => {
    if (done.current) return;
    if (!commit) {
      done.current = true;
      onDone(null, move);
      return;
    }
    const parsed = parseEntry(type, ref.current?.value ?? "");
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    done.current = true;
    onDone(parsed, move);
  };

  return (
    <input
      ref={ref}
      className="cell-input"
      defaultValue={initial}
      inputMode={type === "number" ? "decimal" : undefined}
      aria-label="Edit cell"
      aria-invalid={!!error}
      title={error ?? undefined}
      spellCheck={type === "title" || type === "text"}
      onChange={() => error && setError(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(true, e.shiftKey ? null : "down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          finish(true, e.shiftKey ? "left" : "right");
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false, null);
        }
      }}
      // Leaving the cell saves a valid entry and quietly drops an invalid one.
      onBlur={() => {
        // A row scrolling out of the virtual window removes the field; that is not the user leaving it.
        if (done.current || !ref.current?.isConnected) return;
        const parsed = parseEntry(type, ref.current?.value ?? "");
        if ("error" in parsed) finish(false, null);
        else finish(true, null);
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// select / multi-select / status picker
// ---------------------------------------------------------------------------------------------

const GROUPS: { id: NonNullable<SelectOption["group"]>; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "In progress" },
  { id: "done", label: "Complete" },
];

export function OptionPicker({
  prop,
  current,
  multi,
  anchor,
  onChange,
  onCreate,
  onClose,
}: {
  prop: Property;
  current: unknown;
  multi: boolean;
  anchor: Anchor;
  onChange: (value: unknown) => void;
  onCreate: (name: string) => Promise<SelectOption | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const options = optionsOf(prop);
  const selected = useMemo(() => new Set(multi ? (Array.isArray(current) ? (current as string[]) : []) : typeof current === "string" ? [current] : []), [current, multi]);
  const q = query.trim().toLowerCase();
  const shown = options.filter((o) => o.name.toLowerCase().includes(q));
  const canCreate = q.length > 0 && !options.some((o) => o.name.toLowerCase() === q) && prop.type !== "status";
  const rows: ({ kind: "option"; option: SelectOption } | { kind: "create" } | { kind: "clear" })[] = [
    ...(!multi && selected.size > 0 && !q ? [{ kind: "clear" as const }] : []),
    ...shown.map((option) => ({ kind: "option" as const, option })),
    ...(canCreate ? [{ kind: "create" as const }] : []),
  ];

  const pick = async (row: (typeof rows)[number] | undefined) => {
    if (!row) return;
    if (row.kind === "clear") {
      onChange(null);
      return onClose();
    }
    let id: string;
    if (row.kind === "create") {
      const made = await onCreate(query.trim());
      if (!made) return;
      id = made.id;
    } else id = row.option.id;
    if (multi) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange([...next]);
      setQuery("");
    } else {
      onChange(id);
      onClose();
    }
  };

  const grouped = prop.type === "status" && !q;
  let lastGroup: string | undefined;

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Choose ${prop.name}`} className="picker">
      <input
        className="picker-search"
        value={query}
        placeholder={multi ? "Search or create an option" : "Search options"}
        aria-label="Search options"
        role="combobox"
        aria-expanded="true"
        aria-controls="picker-list"
        aria-activedescendant={rows.length ? `picker-opt-${index}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => (i + 1) % Math.max(1, rows.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => (i - 1 + rows.length) % Math.max(1, rows.length));
          } else if (e.key === "Enter") {
            e.preventDefault();
            void pick(rows[index]);
          }
        }}
      />
      <div className="picker-list" id="picker-list" role="listbox" aria-multiselectable={multi}>
        {rows.length === 0 && <p className="picker-empty">No options yet. Type a name to create one.</p>}
        {rows.map((row, i) => {
          const header = grouped && row.kind === "option" && row.option.group !== lastGroup ? GROUPS.find((g) => g.id === row.option.group)?.label : null;
          if (row.kind === "option") lastGroup = row.option.group;
          return (
            <div key={row.kind === "option" ? row.option.id : row.kind}>
              {header && <div className="picker-group">{header}</div>}
              <div
                id={`picker-opt-${i}`}
                role="option"
                aria-selected={row.kind === "option" && selected.has(row.option.id)}
                className={`picker-item${i === index ? " active" : ""}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(row)}
              >
                {row.kind === "option" && (
                  <>
                    <Tag option={row.option} status={prop.type === "status"} />
                    {selected.has(row.option.id) && <Icon name="check" size={14} />}
                  </>
                )}
                {row.kind === "create" && <span>Create “{query.trim()}”</span>}
                {row.kind === "clear" && <span className="picker-muted">Clear</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------
// date editor
// ---------------------------------------------------------------------------------------------

interface DateState {
  start: string;
  end: string;
  hasEnd: boolean;
  time: boolean;
}

const fromValue = (v: unknown): DateState => {
  const { start = "", end = "" } = (v && typeof v === "object" ? v : {}) as { start?: string; end?: string };
  return { start, end, hasEnd: !!end, time: start.includes("T") || end.includes("T") };
};

const withTime = (s: string, time: boolean) => (!s ? "" : time ? (s.includes("T") ? s.slice(0, 16) : `${s.slice(0, 10)}T00:00`) : s.slice(0, 10));

export function DateEditor({ current, anchor, onChange, onClose }: { current: unknown; anchor: Anchor; onChange: (value: unknown) => void; onClose: () => void }) {
  const [s, setS] = useState<DateState>(() => fromValue(current));
  const [error, setError] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const parsed = useMemo(() => (quick.trim() ? parseNaturalDate(quick) : null), [quick]);
  const kind = s.time ? "datetime-local" : "date";

  // A typed phrase fills in the start; a single date is then saved straight away.
  const applyQuick = () => {
    if (!parsed) return;
    const time = s.time || !!parsed.time;
    const start = parsed.time ? `${parsed.date}T${parsed.time}` : withTime(parsed.date, time);
    setQuick("");
    setError(null);
    if (!s.hasEnd) {
      onChange({ start });
      onClose();
    } else setS({ ...s, start, time });
  };

  const commit = () => {
    if (!s.start) {
      setError("Choose a start date");
      return;
    }
    const start = withTime(s.start, s.time);
    const end = s.hasEnd && s.end ? withTime(s.end, s.time) : "";
    if (end && end < start) {
      setError("The end is before the start");
      return;
    }
    onChange(end ? { start, end } : { start });
    onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label="Edit date" className="picker date-editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
      >
        <div className="field date-quick">
          <input
            value={quick}
            placeholder="Type a date: tomorrow, next fri, oct 12 3pm"
            aria-label="Type a date"
            spellCheck={false}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && quick.trim()) {
                // Enter here fills the date; it must not also submit the form with the old value.
                e.preventDefault();
                applyQuick();
              }
            }}
          />
          {quick.trim() && (
            <p className={`date-preview${parsed ? "" : " none"}`} aria-live="polite">
              {parsed ? describeParsed(parsed) : "Not a date yet. Try “tomorrow” or “oct 12”."}
            </p>
          )}
        </div>
        <label className="field">
          <span>{s.hasEnd ? "Start" : "Date"}</span>
          <input type={kind} value={withTime(s.start, s.time)} onChange={(e) => (setS({ ...s, start: e.target.value }), setError(null))} />
        </label>
        {s.hasEnd && (
          <label className="field">
            <span>End</span>
            <input type={kind} value={withTime(s.end, s.time)} onChange={(e) => (setS({ ...s, end: e.target.value }), setError(null))} />
          </label>
        )}
        <label className="check-row">
          <input type="checkbox" checked={s.hasEnd} onChange={(e) => setS({ ...s, hasEnd: e.target.checked })} />
          End date
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s.time} onChange={(e) => setS({ ...s, time: e.target.checked })} />
          Include time
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="picker-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onChange(null);
              onClose();
            }}
          >
            Clear
          </button>
          <button type="submit" className="btn primary">
            Done
          </button>
        </div>
      </form>
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------
// relation picker
// ---------------------------------------------------------------------------------------------

/** Links records of the related database: search by title, toggle to add or remove. */
export function RelationPicker({
  prop,
  current,
  anchor,
  excludeId,
  onChange,
  onClose,
}: {
  prop: Property;
  current: RecordLink[];
  anchor: Anchor;
  /** The record being edited, which cannot link to itself. */
  excludeId: string;
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecordLink[] | null>(null);
  const [index, setIndex] = useState(0);
  const [linked, setLinked] = useState<RecordLink[]>(current);
  const targetId = prop.config.targetDatabaseId;
  const setError = useWorkspace((s) => s.setError);
  const ids = useMemo(() => new Set(linked.map((l) => l.id)), [linked]);

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      ipc
        .recordLookup(targetId, query, 20)
        .then((r) => {
          if (cancelled) return;
          setResults(r.filter((x) => x.id !== excludeId));
          setIndex(0);
        })
        .catch((e) => !cancelled && setError(toAppError(e).message));
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [targetId, query, excludeId, setError]);

  const toggle = (r: RecordLink) => {
    const next = ids.has(r.id) ? linked.filter((l) => l.id !== r.id) : [...linked, r];
    setLinked(next);
    onChange(next.map((l) => l.id));
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Link ${prop.name}`} className="picker">
      {linked.length > 0 && (
        <div className="rel-linked">
          {linked.map((l) => (
            <span key={l.id} className="rel-chip">
              {l.title || "Untitled"}
              <button type="button" className="icon-btn" aria-label={`Unlink ${l.title || "Untitled"}`} onClick={() => toggle(l)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchField
        className="picker-search"
        value={query}
        placeholder="Search records"
        aria-label="Search records"
        role="combobox"
        aria-expanded="true"
        aria-controls="rel-list"
        aria-activedescendant={results?.length ? `rel-opt-${index}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          const n = results?.length ?? 0;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => (i + 1) % Math.max(1, n));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => (i - 1 + n) % Math.max(1, n));
          } else if (e.key === "Enter" && results?.[index]) {
            e.preventDefault();
            toggle(results[index]);
          }
        }}
      />
      <div className="picker-list" id="rel-list" role="listbox" aria-multiselectable="true" aria-busy={results === null}>
        {results?.length === 0 && <p className="picker-empty">{query ? "No records match." : "The related database has no records."}</p>}
        {results?.map((r, i) => (
          <div
            key={r.id}
            id={`rel-opt-${i}`}
            role="option"
            aria-selected={ids.has(r.id)}
            className={`picker-item${i === index ? " active" : ""}`}
            onMouseMove={() => i !== index && setIndex(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(r)}
          >
            <span>{r.title || "Untitled"}</span>
            {ids.has(r.id) && <Icon name="check" size={14} />}
          </div>
        ))}
      </div>
    </Popover>
  );
}
