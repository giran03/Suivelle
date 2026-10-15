import { useShortcuts } from "../shortcuts/store";
import { forgetSearch, saveSearch, savedSearches, type SavedSearch } from "./savedSearches";
import { useEffect, useMemo, useRef, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page, SearchHit } from "../../types";
import { matchCommands } from "./commands";
import { Marked } from "./marked";
import { usePalette } from "./store";
import { SearchField } from "../../components/SearchField";

type Section = "Saved searches" | "Recent" | "Pages" | "In pages" | "Commands";

interface Row {
  key: string;
  section: Section;
  kind: "page" | "block" | "command" | "create";
  title: string;
  /** Title/sub text may carry search-match markers. */
  sub?: string;
  hint?: string;
  /** Runs inside the palette (a saved search fills the box) instead of closing it. */
  keep?: boolean;
  run: () => void | Promise<void>;
}

const DAY_FILTERS = [
  { days: null, label: "Any time" },
  { days: 1, label: "Today" },
  { days: 7, label: "Past week" },
  { days: 30, label: "Past month" },
] as const;

const MAX_BLOCK_HITS = 12;
const MAX_PER_PAGE = 2;

const label = (t: string) => t || "Untitled";

export function PaletteBody() {
  const shortcutOverrides = useShortcuts(s => s.overrides);
  const ws = useWorkspace((s) => s.workspace);
  const currentId = useWorkspace((s) => s.selectedPageId);
  const [query, setQuery] = useState("");
  const [titlesOnly, setTitlesOnly] = useState(false);
  const [dayIdx, setDayIdx] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recents, setRecents] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim();

  // Recent pages and saved searches for the empty state.
  useEffect(() => {
    if (!ws) return;
    ipc.pageListRecent(ws.id, 9).then(setRecents).catch(() => setRecents([]));
    setSaved(savedSearches(ws.id));
  }, [ws]);

  // Search as you type. Older responses are ignored; the previous results stay visible meanwhile.
  useEffect(() => {
    if (!ws || !q) {
      seq.current++;
      setHits([]);
      setBusy(false);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await ipc.searchWorkspace({
          workspaceId: ws.id,
          query: q,
          titlesOnly,
          modifiedWithinDays: DAY_FILTERS[dayIdx].days,
          limit: 30,
        });
        if (mine !== seq.current) return;
        setHits(result);
        setError(null);
        setActive(0);
      } catch (e) {
        if (mine === seq.current) setError(toAppError(e).message);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [ws, q, titlesOnly, dayIdx]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const open = (pageId: string, blockId: string | null = null) => () => useWorkspace.getState().openPage(pageId, blockId);
    if (!q) {
      for (const s of saved) {
        const filters = [s.titlesOnly ? "titles only" : "", s.dayIdx ? DAY_FILTERS[s.dayIdx]?.label.toLowerCase() : ""].filter(Boolean).join(", ");
        out.push({ key: `saved-${s.query}`, section: "Saved searches", kind: "command", title: s.query, sub: filters || undefined, keep: true, run: () => { setQuery(s.query); setTitlesOnly(s.titlesOnly); setDayIdx(Math.min(s.dayIdx, DAY_FILTERS.length - 1)); } });
      }
      for (const p of recents.filter((r) => r.id !== currentId).slice(0, 8)) {
        out.push({ key: `recent-${p.id}`, section: "Recent", kind: "page", title: label(p.title), run: open(p.id) });
      }
    } else {
      for (const h of hits.filter((x) => x.kind === "page")) {
        out.push({ key: `page-${h.pageId}`, section: "Pages", kind: "page", title: h.snippet, sub: h.parentTitle ? label(h.parentTitle) : undefined, run: open(h.pageId) });
      }
      const perPage = new Map<string, number>();
      for (const h of hits.filter((x) => x.kind === "block")) {
        const n = perPage.get(h.pageId) ?? 0;
        if (n >= MAX_PER_PAGE || out.filter((r) => r.section === "In pages").length >= MAX_BLOCK_HITS) continue;
        perPage.set(h.pageId, n + 1);
        out.push({ key: `block-${h.blockId}`, section: "In pages", kind: "block", title: label(h.pageTitle), sub: h.snippet, run: open(h.pageId, h.blockId) });
      }
    }
    for (const c of matchCommands(q)) {
      out.push({ key: `cmd-${c.id}`, section: "Commands", kind: "command", title: c.title, hint: c.shortcut, run: c.run });
    }
    if (q && !READ_ONLY) {
      out.push({ key: "create", section: "Commands", kind: "create", title: `Create page “${q}”`, run: () => useWorkspace.getState().createPage(null, q) });
    }
    return out;
  }, [shortcutOverrides, q, hits, recents, currentId, saved]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, rows.length - 1))), [rows.length]);
  useEffect(() => {
    list.current?.querySelector(`#pal-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (!row.keep) usePalette.getState().hide();
    void row.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + rows.length) % Math.max(1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[active]);
    }
  };

  const hasMatches = rows.some((r) => r.section === "Pages" || r.section === "In pages");
  let prev: Section | null = null;

  return (
    <>
      <div className="palette-head">
        <Icon name="search" />
        <SearchField
          wrapClassName="sf-grow"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search pages and text, or type a command"
          aria-label="Search pages and commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? `pal-${active}` : undefined}
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {q && (
        <div className="palette-filters" role="group" aria-label="Search filters">
          <button type="button" className="chip" onClick={() => setDayIdx((i) => (i + 1) % DAY_FILTERS.length)} aria-label={`Modified: ${DAY_FILTERS[dayIdx].label}. Change`}>
            Modified: {DAY_FILTERS[dayIdx].label}
          </button>
          <button type="button" className={`chip${titlesOnly ? " on" : ""}`} aria-pressed={titlesOnly} onClick={() => setTitlesOnly((v) => !v)}>
            Titles only
          </button>
          {ws && (saved.some((s) => s.query === q)
            ? <button type="button" className="chip on" aria-pressed="true" title="Remove from saved searches" onClick={() => setSaved(forgetSearch(ws.id, q))}>Saved</button>
            : <button type="button" className="chip" title="Show this search when the palette opens" onClick={() => setSaved(saveSearch(ws.id, { query: q, titlesOnly, dayIdx }))}>Save search</button>)}
        </div>
      )}

      <div className="palette-list" ref={list} role="listbox" id="palette-list" aria-label="Results" aria-busy={busy}>
        {error && (
          <p className="palette-note error-text" role="alert">
            {error}
          </p>
        )}
        {q && !busy && !error && !hasMatches && <p className="palette-note">No pages or text match “{q}”.</p>}
        {!q && rows.every((r) => r.section !== "Recent" && r.section !== "Saved searches") && <p className="palette-note">Search pages and text, or run a command.</p>}
        {rows.map((row, i) => {
          const header = row.section !== prev ? row.section : null;
          prev = row.section;
          return (
            <div key={row.key}>
              {header && <div className="palette-group">{header}</div>}
              <div
                id={`pal-${i}`}
                role="option"
                aria-selected={i === active}
                className={`palette-item${i === active ? " active" : ""}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => activate(row)}
              >
                <span className="pi-icon">{row.kind !== "command" && <Icon name={row.kind === "create" ? "plus" : "page"} />}</span>
                <span className="pi-text">
                  <span className="pi-title">
                    <Marked text={row.title} />
                  </span>
                  {row.sub && (
                    <span className="pi-sub">
                      <Marked text={row.sub} />
                    </span>
                  )}
                </span>
                {row.hint && <kbd className="kbd">{row.hint}</kbd>}
              </div>
            </div>
          );
        })}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {q && !busy ? `${rows.filter((r) => r.section === "Pages" || r.section === "In pages").length} results` : ""}
      </p>
      <div className="palette-foot" aria-hidden="true">
        <span>
          <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move
        </span>
        <span>
          <kbd className="kbd">Enter</kbd> open
        </span>
        <span>
          <kbd className="kbd">Esc</kbd> close
        </span>
      </div>
    </>
  );
}

