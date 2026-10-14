import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { MenuItem } from "../../components/ContextMenu";
import { READ_ONLY } from "../../lib/access";
import { newId } from "../../lib/ids";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { CanvasBoard, CanvasItem, CanvasOp, Page } from "../../types";
import { type BoardApi, CanvasBoard as Board } from "../database/canvas/CanvasBoard";
import { Tool } from "../database/canvas/CanvasControls";
import { useCanvas } from "../database/canvas/useCanvas";
import { gridSlots } from "../database/canvas/viewport";
import { usePeek } from "../peek/store";
import "./canvas-boards.css";
import { registerBoardDrop, useBoards } from "./store";

const CARD_W = 560;
const CARD_H = 620;
const CanvasPage = lazy(() => import("./CanvasPage").then(m => ({ default: m.CanvasPage })));

/** The open canvas board, filling the main area under its name. */
export function WorkspaceCanvas() {
  const board = useBoards((s) => s.boards.find((b) => b.id === s.activeId));
  if (!board) return <p className="empty">Choose a canvas from the sidebar, or make a new one.</p>;
  return <BoardPage key={board.id} board={board} />;
}

/** What each page card shows, read live from the page itself and refreshed when the window comes back into focus. */
function useCanvasPages(ids: string[]) {
  const [byId, setById] = useState<ReadonlyMap<string, Page | null>>(new Map());
  const [settled, setSettled] = useState(false);
  const key = ids.join(",");

  const read = useCallback(async (wanted: string[]) => {
    const got = await Promise.all(wanted.map((id) => ipc.pageGet(id).catch(() => null)));
    setById((prev) => {
      const next = new Map(prev);
      wanted.forEach((id, n) => next.set(id, got[n]));
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const wanted = key ? key.split(",") : [];
    void read(wanted).then(() => alive && setSettled(true));
    const onFocus = () => void read(wanted);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [key, read]);

  return { byId, settled };
}

function BoardPage({ board }: { board: CanvasBoard }) {
  const canvas = useCanvas(board.id, "board");
  const api = useRef<BoardApi | null>(null);
  const [picker, setPicker] = useState<{ at: { x: number; y: number } | null } | null>(null);

  const pageIds = useMemo(() => (canvas.data?.items ?? []).flatMap((i) => (i.kind === "page" && i.pageId ? [i.pageId] : [])), [canvas.data]);
  const { byId, settled } = useCanvasPages(pageIds);
  const cards = useMemo(() => {
    const live = new Map<string, unknown>();
    for (const [id, p] of byId) if (p && !p.deletedAt) live.set(id, p);
    return live;
  }, [byId]);

  const addPages = useCallback(
    (ids: string[], at?: { x: number; y: number } | null) => {
      if (READ_ONLY || !canvas.data) return;
      const have = new Set(canvas.data.items.map((i) => i.pageId));
      const fresh = [...new Set(ids)].filter((id) => !have.has(id));
      if (!fresh.length) return;
      const c = at ?? api.current?.center() ?? { x: 0, y: 0 };
      const slots = gridSlots(fresh.length, { x: Math.round(c.x - CARD_W / 2), y: Math.round(c.y - CARD_H / 2) }, { w: CARD_W, h: CARD_H });
      let z = api.current?.topZ() ?? 1;
      const ops: CanvasOp[] = fresh.map((id, n) => ({
        op: "upsert_item",
        item: { id: newId(), kind: "page", recordId: null, pageId: id, text: "", attachmentHash: null, x: Math.round(slots[n].x), y: Math.round(slots[n].y), w: CARD_W, h: CARD_H, z: z++, color: null },
      }));
      canvas.commit(ops);
      api.current?.select(ops.map((o) => (o.op === "upsert_item" ? o.item.id : "")));
    },
    [canvas],
  );

  // Pages dragged out of the sidebar and dropped on the board land where they were released.
  useEffect(() => {
    return registerBoardDrop((ids, x, y) => {
      const at = api.current?.worldAt(x, y);
      if (!at) return false;
      addPages(ids, at);
      return true;
    });
  }, [addPages]);

  const renderCard = useCallback((card: unknown, _item: CanvasItem, open: () => void) => <Suspense fallback={<p role="status">Loading page…</p>}><CanvasPage page={card as Page} onOpen={open} /></Suspense>, []);
  const cardLabel = useCallback((card: unknown) => (card as Page).title || "Untitled", []);
  const openCard = useCallback((card: unknown) => void useWorkspace.getState().openPage((card as Page).id), []);
  const cardMenu = useCallback(
    (card: unknown): MenuItem[] => {
      const id = (card as Page).id;
      return [
        { label: "Open page", onSelect: () => void useWorkspace.getState().openPage(id) },
        { label: "Open beside", onSelect: () => usePeek.getState().show(id) },
      ];
    },
    [],
  );
  const boardMenu = useCallback((at: { x: number; y: number }): MenuItem[] => [{ label: "Add page…", onSelect: () => setPicker({ at }) }], []);

  const missing = canvas.data ? canvas.data.items.filter((i) => i.kind === "page" && i.pageId && !cards.has(i.pageId)).length : 0;

  return (
    <div className="board-page">
      <BoardTitle board={board} />
      <Board
        scopeId={board.id}
        canvas={canvas}
        ready={settled}
        cards={cards}
        renderCard={renderCard}
        cardLabel={cardLabel}
        openCard={openCard}
        cardMenu={cardMenu}
        removableCards
        notice={settled && missing > 0 ? `${missing === 1 ? "A page on this canvas is" : `${missing} pages on this canvas are`} in the trash, so ${missing === 1 ? "its card is" : "their cards are"} hidden until restored.` : null}
        emptyHint="Drag pages here from the sidebar, press Add page, or double-click for a note."
        boardMenu={boardMenu}
        apiRef={api}
        tools={
          !READ_ONLY && (
            <>
              <Tool icon="page" label="Add page" on={!!picker} onClick={() => setPicker((p) => (p ? null : { at: null }))} />
              {picker && (
                <PagePicker
                  taken={new Set(pageIds)}
                  onPick={(id) => {
                    addPages([id], picker.at);
                    setPicker(null);
                  }}
                  onClose={() => setPicker(null)}
                />
              )}
            </>
          )
        }
      />
    </div>
  );
}

/** The board's name, saved a moment after typing stops. */
function BoardTitle({ board }: { board: CanvasBoard }) {
  const [name, setName] = useState(board.name);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(name);
  latest.current = name;
  const commit = useCallback(
    (value: string) => {
      window.clearTimeout(timer.current);
      const next = value.trim();
      if (next && next !== useBoards.getState().boards.find((b) => b.id === board.id)?.name) void useBoards.getState().rename(board.id, next);
    },
    [board.id],
  );
  useEffect(() => setName(board.name), [board.name]);
  useEffect(() => () => commit(latest.current), [commit]);
  return (
    <div className="page-title board-title">
      <input
        readOnly={READ_ONLY}
        value={name}
        placeholder="Untitled canvas"
        aria-label="Canvas name"
        maxLength={120}
        onChange={(e) => {
          setName(e.target.value);
          window.clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = window.setTimeout(() => commit(v), 500);
        }}
        onBlur={() => commit(name)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(name);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

interface Choice {
  id: string;
  title: string;
  parent: string | null;
}

/** A search box over the workspace's pages that sits above the tool pill; Enter or a click puts the page on the canvas. */
function PagePicker({ taken, onPick, onClose }: { taken: ReadonlySet<string>; onPick: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = useWorkspace.getState().workspace;
    if (!ws) return;
    let alive = true;
    const id = window.setTimeout(async () => {
      try {
        const next: Choice[] = query.trim()
          ? (await ipc.searchWorkspace({ workspaceId: ws.id, query, titlesOnly: true, limit: 20 })).filter((h) => h.kind === "page").map((h) => ({ id: h.pageId, title: h.pageTitle, parent: h.parentTitle }))
          : (await ipc.pageListRecent(ws.id, 20)).map((p) => ({ id: p.id, title: p.title, parent: null }));
        if (alive) {
          setChoices(next.filter((c) => !taken.has(c.id)).slice(0, 8));
          setAt(0);
        }
      } catch {
        if (alive) setChoices([]);
      }
    }, query ? 120 : 0);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [query, taken]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".cv-tools")) onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  return (
    <div ref={root} className="cv-picker" role="dialog" aria-label="Add a page to the canvas">
      <input
        autoFocus
        type="text"
        value={query}
        placeholder="Find a page to add"
        aria-label="Find a page to add"
        role="combobox"
        aria-expanded="true"
        aria-controls="cv-picker-list"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (choices.length) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
          } else if (e.key === "Enter" && choices[at]) {
            e.preventDefault();
            onPick(choices[at].id);
          }
        }}
      />
      <ul id="cv-picker-list" role="listbox" aria-label="Pages">
        {choices.map((c, n) => (
          <li key={c.id} role="option" aria-selected={n === at}>
            <button type="button" className={n === at ? "on" : undefined} onMouseEnter={() => setAt(n)} onClick={() => onPick(c.id)}>
              <Icon name="page" size={14} />
              <span className="cv-pick-title">{c.title || "Untitled"}</span>
              {c.parent && <span className="cv-pick-parent">{c.parent}</span>}
            </button>
          </li>
        ))}
        {choices.length === 0 && <li className="cv-pick-empty">{query ? "No pages match." : "Every recent page is already here."}</li>}
      </ul>
    </div>
  );
}
