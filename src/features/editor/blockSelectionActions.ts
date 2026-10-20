import { key } from "../shortcuts/bindings";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { MenuItem } from "../../components/ContextMenu";
import { toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { TURN_INTO, canTurnInto, mergeSelectedBlocksInto, turnSelectedBlocksInto } from "./blockKinds";
import { BlockRangeSelection, blockRange } from "./blockSelection";
import { imagePresentation } from "./imageModel";
import { imageCopyItem } from "./imageActions";
import { copyPlainText, selectedPlainText } from "./plainText";
import { canSyncSelection, syncSelectedBlocks } from "./synced";

export function mergeSelectedQuotes(editor: Editor) {
  return mergeSelectedBlocksInto(editor, "quote");
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

/** Shared bulk actions, plus merge targets that accept mixed block types. */
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
  const imageCopies = blocks.flatMap(({ node, pos }) => {
    const item = imageCopyItem(editor, pos, node);
    return item ? [{ ...item, title: item.label, imageName: node.attrs.name || "Image" }] : [];
  });
  const convertible = blocks.length > 0 && blocks.every((b) => canTurnInto(b.node));
  let keepLineBreaks = true;
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
    {
      label: "Copy text", shortcut: "copy-plain",
      disabled: !selectedPlainText(editor),
      onSelect: () => { if (restore()) copyPlainText(editor); },
    },
    ...(imageCopies.length === 1 ? [imageCopies[0]] : imageCopies.length > 1 ? [{
      label: "Copy image…", onSelect: () => {},
      children: imageCopies.map((item, index) => ({ ...item, label: `Copy image ${index + 1}: ${item.imageName}${item.label.includes("still frame") ? " (still frame)" : ""}` })),
    }] : []),
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
          ...(blocks.length > 1
            ? [
                {
                  label: "Merge all into…",
                  separated: true,
                  onSelect: () => {},
                  children: [
                    { label: "Keep line breaks", title: "Keep text on separate lines, or turn off to combine it with spaces. Lists, toggles and tabs keep their structure.", checked: true, keepOpen: true, onSelect: () => { keepLineBreaks = !keepLineBreaks; } },
                    ...TURN_INTO.map((kind, index) => ({
                      label: kind.id === "tabs" ? "Merge into tabs" : `Merge into one ${kind.id === "paragraph" ? "paragraph" : kind.title.toLowerCase()}`,
                      separated: index === 0,
                      title: ["Text", "Advanced"].includes(kind.group) ? "Combines nested text. Embedded blocks become names or URLs; lists, toggles and tabs keep embedded blocks." : undefined,
                      onSelect: action(() => { mergeSelectedBlocksInto(editor, kind.id, keepLineBreaks); }),
                    })),
                  ],
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
