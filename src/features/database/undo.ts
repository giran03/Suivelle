import { isEmptyValue } from "./model";

export interface CellEdit {
  recordId: string;
  propertyId: string;
  before: unknown;
  after: unknown;
}

/** One undoable action: a single edit, or a whole paste or fill. */
export interface UndoStep {
  edits: CellEdit[];
  /** Records this step created: undoing moves them to the trash, redoing brings them back. */
  created?: { id: string; pageId: string; title: string }[];
}

export const hasContent = (step: UndoStep) => step.edits.length > 0 || (step.created?.length ?? 0) > 0;

export interface History {
  /** The shape of the table this history belongs to; a different one starts it afresh. */
  structure: string;
  undo: UndoStep[];
  redo: UndoStep[];
}

const LIMIT = 100;

export const emptyHistory = (structure: string): History => ({ structure, undo: [], redo: [] });

/** Compares two cell values the way the table does: empty is empty, everything else by content. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Adds a step; a new edit ends the redo trail. */
export function record(h: History, step: UndoStep): History {
  if (!hasContent(step)) return h;
  return { ...h, undo: [...h.undo, step].slice(-LIMIT), redo: [] };
}

export interface Replay {
  /** What to write: the recorded value for every cell that still holds what the step left there. */
  cells: { recordId: string; propertyId: string; value: unknown }[];
  skipped: number;
  /** The edits that will actually be replayed. */
  step: UndoStep;
}

/**
 * Works out what undoing (or redoing) a step should write. A cell is skipped when something else
 * has changed it since, so an undo never overwrites a newer edit. `current` returns undefined
 * when the record is not loaded, which counts as unchanged.
 */
export function planReplay(step: UndoStep, direction: "undo" | "redo", current: (recordId: string, propertyId: string) => { value: unknown } | undefined): Replay {
  const cells: Replay["cells"] = [];
  const kept: CellEdit[] = [];
  let skipped = 0;
  for (const e of step.edits) {
    const expected = direction === "undo" ? e.after : e.before;
    const target = direction === "undo" ? e.before : e.after;
    const now = current(e.recordId, e.propertyId);
    if (now && !sameValue(now.value, expected)) {
      skipped++;
      continue;
    }
    cells.push({ recordId: e.recordId, propertyId: e.propertyId, value: target });
    kept.push(e);
  }
  return { cells, skipped, step: { ...step, edits: kept } };
}

/** The history after the newest undo step was undone (it moves to the redo side). */
export function afterUndo(h: History, step: UndoStep): History {
  return { ...h, undo: h.undo.slice(0, -1), redo: hasContent(step) ? [...h.redo, step] : h.redo };
}

export function afterRedo(h: History, step: UndoStep): History {
  return { ...h, redo: h.redo.slice(0, -1), undo: hasContent(step) ? [...h.undo, step] : h.undo };
}
