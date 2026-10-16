import { key } from "../shortcuts/bindings";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment } from "@tiptap/pm/model";
import type { MenuItem } from "../../components/ContextMenu";
import { toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { TURN_INTO, canTurnInto, turnSelectedBlocksInto } from "./blockKinds";
import { BlockRangeSelection, blockRange } from "./blockSelection";
import { imagePresentation } from "./imageModel";
import { canSyncSelection, syncSelectedBlocks } from "./synced";

const MERGEABLE_INLINE = {
  quote: "Merge into one quote",
  callout: "Merge into one callout",
  paragraph: "Merge into one paragraph",
} as const;

export type MergeableInlineType = keyof typeof MERGEABLE_INLINE;

export function mergeSelectedInlineBlocks(
  editor: Editor,
  typeName: MergeableInlineType,
) {
  const { selection, doc, schema } = editor.state;
  if (!editor.isEditable || !(selection instanceof BlockRangeSelection))
    return false;
  const blocks = blockRange(doc, selection.from, selection.to);
  if (
    blocks.length < 2 ||
    !blocks.every((b) => b.node.type.name === typeName)
  )
    return false;
  const hardBreak = schema.nodes.hardBreak;
  let content = Fragment.empty;
  blocks.forEach((b, i) => {
    if (i > 0 && hardBreak)
      content = content.append(Fragment.from(hardBreak.create()));
    content = content.append(b.node.content);
  });
  const first = blocks[0].node;
  const merged = first.type.create({ ...first.attrs }, content);
  const from = selection.from;
  const tr = closeHistory(editor.state.tr).replaceWith(
    from,
    selection.to,
    merged,
  );
  tr.setSelection(
    BlockRangeSelection.create(tr.doc, from, from + merged.nodeSize),
  );
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function mergeSelectedQuotes(editor: Editor) {
  return mergeSelectedInlineBlocks(editor, "quote");
}

export function duplicateSelectedBlocks(editor: Editor) {
  const { selection } = editor.state;
  if (!editor.isEditable || !(selection instanceof BlockRangeSelection))
    return false;
  const tr = closeHistory(editor.state.tr).replaceRange(
    selection.to,
    selection.to,
    selection.content(),
  );
  tr.setSelection(
    BlockRangeSelection.create(
      tr.doc,
      tr.mapping.map(selection.to, -1),
      tr.mapping.map(selection.to, 1),
    ),
  );
  editor.view.dispatch(tr);
  return true;
}

export function moveSelectedBlocks(editor: Editor, direction: -1 | 1) {
  const { selection, doc } = editor.state;
  if (!editor.isEditable || !(selection instanceof BlockRangeSelection))
    return false;
  const blocks = blockRange(doc, selection.from, selection.to);
  const $from = doc.resolve(selection.from),
    $to = doc.resolve(selection.to);
  if (!$from.sameParent($to)) return false;
  const parent = $from.parent;
  const index = doc.resolve(selection.from).index();
  const adjacentIndex = direction < 0 ? index - 1 : index + blocks.length;
  if (adjacentIndex < 0 || adjacentIndex >= parent.childCount) return false;
  const adjacent = parent.child(adjacentIndex);
  const nodes = blocks.map((b) => b.node);
  const from =
    direction < 0 ? selection.from - adjacent.nodeSize : selection.from;
  const to = direction < 0 ? selection.to : selection.to + adjacent.nodeSize;
  const nextFrom = direction < 0 ? from : from + adjacent.nodeSize;
  const tr = closeHistory(editor.state.tr).replaceWith(
    from,
    to,
    direction < 0 ? [...nodes, adjacent] : [adjacent, ...nodes],
  );
  tr.setSelection(
    BlockRangeSelection.create(
      tr.doc,
      nextFrom,
      nextFrom + selection.to - selection.from,
    ),
  );
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Only expose actions shared by all whole blocks in this selection. */
export function selectedBlockItems(editor: Editor): MenuItem[] {
  const selection = editor.state.selection;
  if (!(selection instanceof BlockRangeSelection)) return [];
  const bookmark = selection.getBookmark();
  const restore = () => {
    if (editor.isDestroyed) return false;
    const selection = bookmark.resolve(editor.state.doc);
    if (!(selection instanceof BlockRangeSelection)) return false;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
    return true;
  };
  const action = (fn: () => void) => () => {
    if (editor.isEditable && restore()) fn();
  };
  const copy = async (cut: boolean) => {
    if ((cut && !editor.isEditable) || !restore()) return;
    if (document.execCommand(cut ? "cut" : "copy")) return;
    const doc = editor.state.doc,
      selection = editor.state.selection;
    const { dom, text } = editor.view.serializeForClipboard(
      selection.content(),
    );
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      if (
        cut &&
        editor.isEditable &&
        !editor.isDestroyed &&
        editor.state.doc === doc &&
        restore()
      )
        editor.view.dispatch(closeHistory(editor.state.tr).deleteSelection());
    } catch (error) {
      useWorkspace.getState().setError(toAppError(error).message);
    }
  };
  const blocks = blockRange(editor.state.doc, selection.from, selection.to);
  const convertible = blocks.length > 0 && blocks.every((b) => canTurnInto(b.node));
  const mergeType =
    blocks.length > 1
      ? (Object.keys(MERGEABLE_INLINE) as MergeableInlineType[]).find((t) =>
          blocks.every((b) => b.node.type.name === t),
        )
      : undefined;
  const $from = selection.$from,
    $to = selection.$to;
  const sameParent = $from.sameParent($to);
  return [
    ...(editor.isEditable && editor.can().undo()
      ? [
          {
            label: "Undo", shortcut: "undo",
            onSelect: action(() => {
              editor.commands.undo();
            }),
          },
        ]
      : []),
    ...(editor.isEditable && editor.can().redo()
      ? [
          {
            label: "Redo", shortcut: "redo",
            onSelect: action(() => {
              editor.commands.redo();
            }),
          },
        ]
      : []),
    {
      label: "Copy blocks", shortcut: [key("c", "Primary")],
      separated:
        editor.isEditable && (editor.can().undo() || editor.can().redo()),
      onSelect: () => void copy(false),
    },
    ...(editor.isEditable
      ? [
          { label: "Cut blocks", shortcut: [key("x", "Primary")], onSelect: () => void copy(true) },
          {
            label: "Duplicate blocks", shortcut: "duplicate-block",
            separated: true,
            onSelect: action(() => {
              duplicateSelectedBlocks(editor);
            }),
          },
          ...(sameParent && $from.index() > 0
            ? [
                {
                  label: "Move up", shortcut: "move-block-up",
                  onSelect: action(() => {
                    moveSelectedBlocks(editor, -1);
                  }),
                },
              ]
            : []),
          ...(sameParent && $to.index() < $from.parent.childCount
            ? [
                {
                  label: "Move down", shortcut: "move-block-down",
                  onSelect: action(() => {
                    moveSelectedBlocks(editor, 1);
                  }),
                },
              ]
            : []),
          ...(blocks.every((b) => b.node.type.name === "image")
            ? (["left", "center", "right"] as const).map((align, index) => ({
                label: `Align ${align}`,
                separated: index === 0,
                onSelect: action(() => {
                  const tr = closeHistory(editor.state.tr);
                  for (const b of blockRange(
                    tr.doc,
                    tr.selection.from,
                    tr.selection.to,
                  ))
                    tr.setNodeAttribute(b.pos, "presentation", {
                      ...imagePresentation(b.node.attrs.presentation),
                      align,
                    });
                  editor.view.dispatch(tr);
                }),
              }))
            : []),
          ...(mergeType
            ? [
                {
                  label: MERGEABLE_INLINE[mergeType],
                  separated: true,
                  onSelect: action(() => {
                    mergeSelectedInlineBlocks(editor, mergeType);
                  }),
                },
              ]
            : []),
          {
            label: "Turn into synced block",
            separated: true,
            disabled: !canSyncSelection(editor),
            onSelect: action(() => void syncSelectedBlocks(editor)),
          },
          ...TURN_INTO.map((k, i) => ({
            label: `Turn into ${k.title}`,
            shortcut: k.shortcut,
            separated: i === 0,
            disabled: !convertible,
            onSelect: action(() => {
              turnSelectedBlocksInto(editor, k.id);
            }),
          })),
          {
            label: "Delete blocks", shortcut: [key("Delete"), key("Backspace")],
            danger: true,
            separated: true,
            onSelect: action(() => {
              editor.view.dispatch(
                closeHistory(editor.state.tr)
                  .deleteSelection()
                  .scrollIntoView(),
              );
            }),
          },
        ]
      : []),
    {
      label: "Select all blocks",
      separated: true,
      onSelect: () => {
        editor.view.dispatch(
          editor.state.tr.setSelection(
            BlockRangeSelection.create(
              editor.state.doc,
              0,
              editor.state.doc.content.size,
            ),
          ),
        );
        editor.view.focus();
      },
    },
  ];
}
