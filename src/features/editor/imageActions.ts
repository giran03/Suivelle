import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { MenuItem } from "../../components/ContextMenu";
import { imagePresentation } from "./imageModel";

export function requestImageAction(
  editor: Editor,
  pos: number,
  action: string,
) {
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  (dom?.matches(".image-block")
    ? dom
    : dom?.querySelector(".image-block")
  )?.dispatchEvent(new CustomEvent("image-action", { detail: action }));
}

/** Image commands shared by right-click and the image's More toolbar button. */
export function imageItems(
  editor: Editor,
  pos: number,
  node: Node,
): MenuItem[] {
  if (node.type.name !== "image" || !node.attrs.attachmentId) return [];
  const p = imagePresentation(node.attrs.presentation);
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  const animated =
    dom?.querySelector<HTMLElement>(".image-block")?.dataset.animated;
  const action = (label: string, key: string): MenuItem => ({
    label,
    onSelect: () => requestImageAction(editor, pos, key),
  });
  const items = [action("View image", "view")];
  if (editor.isEditable || p.note)
    items.push(
      action(
        p.note ? "View private image note" : "Add private image note",
        "note",
      ),
    );
  items.push(
    animated === "true"
      ? action("Copy still frame (animated image)", "copy-still")
      : action("Copy image", "copy-image"),
    action("Save displayed image…", "save"),
  );
  if (p.link)
    items.push(
      action("Open image link", "open-link"),
      action("Copy image link", "copy-link"),
    );
  if (editor.isEditable) {
    for (const align of ["left", "center", "right"] as const)
      items.push({
        label: `Align ${align}`,
        checked: p.align === align || (!p.align && align === "left"),
        onSelect: () => {
          const current = editor.state.doc.nodeAt(pos);
          if (current?.type.name === "image")
            editor.view.dispatch(
              editor.state.tr.setNodeAttribute(pos, "presentation", {
                ...imagePresentation(current.attrs.presentation),
                align,
              }),
            );
        },
      });
    items.push(
      action("Edit caption", "caption"),
      action("Edit alt text", "alt"),
      action("Set image width…", "width"),
      action("Reset image size", "reset-size"),
      action(p.link ? "Edit image link" : "Add image link", "link"),
      action("Replace image…", "replace"),
    );
    items.push(
      {
        ...action(
          animated === "true"
            ? "Crop unavailable for animated images"
            : "Crop image…",
          "crop",
        ),
        disabled: animated !== "false",
      },
      { ...action("Reset crop", "reset-crop"), disabled: !p.crop },
    );
    if (p.link) items.push(action("Remove image link", "remove-link"));
  }
  return items;
}
