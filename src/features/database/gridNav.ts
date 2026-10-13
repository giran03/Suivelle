export interface Cell {
  row: number;
  col: number;
}

export interface Bounds {
  rows: number;
  cols: number;
  pageSize?: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Where the active cell goes for a navigation key; null when the key is not navigation. */
export function moveCell(cell: Cell, key: string, b: Bounds, mods: { ctrl?: boolean; shift?: boolean } = {}): Cell | null {
  const lastRow = Math.max(0, b.rows - 1);
  const lastCol = Math.max(0, b.cols - 1);
  const page = b.pageSize ?? 10;
  switch (key) {
    case "ArrowUp":
      return { ...cell, row: clamp(cell.row - 1, 0, lastRow) };
    case "ArrowDown":
      return { ...cell, row: clamp(cell.row + 1, 0, lastRow) };
    case "ArrowLeft":
      return { ...cell, col: clamp(cell.col - 1, 0, lastCol) };
    case "ArrowRight":
      return { ...cell, col: clamp(cell.col + 1, 0, lastCol) };
    case "Tab": {
      const dir = mods.shift ? -1 : 1;
      let { row, col } = cell;
      col += dir;
      if (col > lastCol) {
        col = 0;
        row = Math.min(lastRow, row + 1);
      } else if (col < 0) {
        col = lastCol;
        row = Math.max(0, row - 1);
      }
      return { row, col };
    }
    case "Home":
      return mods.ctrl ? { row: 0, col: 0 } : { ...cell, col: 0 };
    case "End":
      return mods.ctrl ? { row: lastRow, col: lastCol } : { ...cell, col: lastCol };
    case "PageUp":
      return { ...cell, row: clamp(cell.row - page, 0, lastRow) };
    case "PageDown":
      return { ...cell, row: clamp(cell.row + page, 0, lastRow) };
    default:
      return null;
  }
}

/** A key press that should start editing by typing over the cell. */
export function isTypingKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export const pageOf = (row: number, size: number) => Math.floor(row / size);

/** Which page indexes must be fetched to cover rows [first, last], skipping loaded and requested ones. */
export function missingPages(first: number, last: number, size: number, total: number, have: ReadonlySet<number>): number[] {
  if (total <= 0) return [];
  const from = pageOf(clamp(first, 0, total - 1), size);
  const to = pageOf(clamp(last, 0, total - 1), size);
  const out: number[] = [];
  for (let p = from; p <= to; p++) if (!have.has(p)) out.push(p);
  return out;
}

export const cursorFor = (page: number, size: number): string | null => (page === 0 ? null : `o:${page * size}`);
