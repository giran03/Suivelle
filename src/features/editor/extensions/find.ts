import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: FindMatch[];
  /** The highlighted match, or -1 when there are none. */
  index: number;
  decorations: DecorationSet;
}

export const findKey = new PluginKey<FindState>("find");

const MAX_MATCHES = 5000;
/** Stands in for inline atoms (a mention, a line break) so text offsets still line up with positions. */
const LEAF = "￼";

const EMPTY: FindState = { query: "", caseSensitive: false, wholeWord: false, matches: [], index: -1, decorations: DecorationSet.empty };

/** Every occurrence of `query` inside a single text block. Blocks that are atoms (media, embedded databases) are skipped. */
const WORD = /[\p{L}\p{N}_]/u;

export function findMatches(doc: PMNode, query: string, caseSensitive: boolean, wholeWord = false): FindMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (out.length >= MAX_MATCHES) return false;
    if (!node.isTextblock) return !node.isAtom;
    const text = node.textBetween(0, node.content.size, undefined, LEAF);
    const hay = caseSensitive ? text : text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1 && out.length < MAX_MATCHES) {
      const end = at + needle.length;
      // A whole-word match is not glued to a letter, digit or underscore on either side.
      const whole = !wholeWord || (!WORD.test(text[at - 1] ?? "") && !WORD.test(text[end] ?? ""));
      // The block's content starts one position after the block itself.
      if (whole) out.push({ from: pos + 1 + at, to: pos + 1 + end });
      at = hay.indexOf(needle, whole ? end : at + 1);
    }
    return false;
  });
  return out;
}

function build(doc: PMNode, query: string, caseSensitive: boolean, wholeWord: boolean, wanted: number, prevFrom?: number): FindState {
  const matches = findMatches(doc, query, caseSensitive, wholeWord);
  let index = -1;
  if (matches.length) {
    if (wanted >= 0) index = wanted % matches.length;
    else if (prevFrom !== undefined) index = Math.max(0, matches.findIndex((m) => m.from >= prevFrom)) || 0;
    else index = 0;
    if (index < 0) index = 0;
  }
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "find-match find-current" : "find-match" })),
  );
  return { query, caseSensitive, wholeWord, matches, index, decorations };
}

type Meta = { query?: string; caseSensitive?: boolean; wholeWord?: boolean; index?: number; clear?: boolean };

function selectMatch(doc: PMNode, prev: FindState, wanted: number): FindState {
  if (!prev.matches.length) return prev;
  const index = ((wanted % prev.matches.length) + prev.matches.length) % prev.matches.length;
  if (index === prev.index) return prev;
  let decorations = prev.decorations;
  for (const i of [prev.index, index]) {
    const match = prev.matches[i];
    if (!match) continue;
    const old = decorations.find(match.from, match.to).filter((d) => d.from === match.from && d.to === match.to);
    decorations = decorations.remove(old).add(doc, [Decoration.inline(match.from, match.to, {
      class: i === index ? "find-match find-current" : "find-match",
    })]);
  }
  return { ...prev, index, decorations };
}

export const FindExtension = Extension.create({
  name: "find",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(findKey) as Meta | undefined;
            if (meta?.clear) return EMPTY;
            if (meta) {
              if (!tr.docChanged && meta.index !== undefined && meta.query === undefined && meta.caseSensitive === undefined && meta.wholeWord === undefined) {
                return selectMatch(next.doc, prev, meta.index);
              }
              const query = meta.query ?? prev.query;
              const cs = meta.caseSensitive ?? prev.caseSensitive;
              const ww = meta.wholeWord ?? prev.wholeWord;
              // A new query or option starts from the first match; stepping asks for a specific one.
              const restart = (meta.query !== undefined && meta.query !== prev.query) || meta.caseSensitive !== undefined || meta.wholeWord !== undefined;
              return build(next.doc, query, cs, ww, restart ? 0 : (meta.index ?? -1), undefined);
            }
            if (tr.docChanged && prev.query) {
              const current = prev.matches[prev.index];
              return build(next.doc, prev.query, prev.caseSensitive, prev.wholeWord, -1, current ? tr.mapping.map(current.from) : undefined);
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export const getFind = (stateOrEditor: EditorState | Editor): FindState => {
  const state = "state" in stateOrEditor ? stateOrEditor.state : stateOrEditor;
  return findKey.getState(state) ?? EMPTY;
};

const send = (editor: Editor, meta: Meta) => editor.view.dispatch(editor.state.tr.setMeta(findKey, meta));

export function setFind(editor: Editor, meta: { query?: string; caseSensitive?: boolean; wholeWord?: boolean }) {
  send(editor, meta);
}

export function clearFind(editor: Editor) {
  if (!editor.isDestroyed) send(editor, { clear: true });
}

/** Brings the current match into view without moving the caret out of the way of typing. */
export function revealCurrent(editor: Editor) {
  const s = getFind(editor);
  const m = s.matches[s.index];
  if (!m) return;
  const dom = editor.view.domAtPos(m.from).node;
  const el = dom.nodeType === 1 ? (dom as Element) : dom.parentElement;
  el?.scrollIntoView({ block: "center", behavior: "auto" });
}

export function stepFind(editor: Editor, dir: 1 | -1) {
  const s = getFind(editor);
  if (!s.matches.length) return;
  send(editor, { index: (s.index + dir + s.matches.length) % s.matches.length });
  revealCurrent(editor);
}

export function replaceCurrent(editor: Editor, replacement: string): boolean {
  const s = getFind(editor);
  const m = s.matches[s.index];
  if (!m || !editor.isEditable) return false;
  editor.view.dispatch(editor.state.tr.insertText(replacement, m.from, m.to));
  revealCurrent(editor);
  return true;
}

/** Replaces every match in one step, so a single undo puts them all back. */
export function replaceAll(editor: Editor, replacement: string): number {
  const s = getFind(editor);
  if (!s.matches.length || !editor.isEditable) return 0;
  const tr = editor.state.tr;
  for (let i = s.matches.length - 1; i >= 0; i--) tr.insertText(replacement, s.matches[i].from, s.matches[i].to);
  editor.view.dispatch(tr);
  return s.matches.length;
}
