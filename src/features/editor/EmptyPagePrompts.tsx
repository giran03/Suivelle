import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useTemplateGallery } from "../templates/store";
import { BLOCK_KINDS } from "./blockKinds";

export const blankPageBody = (doc: Node) => doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.content.size === 0;

export function EmptyPagePrompts({ editor, pageId }: { editor: Editor; pageId: string }) {
  const empty = useEditorState({ editor, selector: ({ editor: e }) => blankPageBody(e.state.doc) });
  const [pageKind, setPageKind] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(!blankPageBody(editor.state.doc));
  useEffect(() => {
    let live = true;
    ipc.pageGet(pageId).then(page => { if (live) setPageKind(page.kind); }).catch(() => {});
    const composition = () => setDismissed(true);
    const changed = () => { if (!blankPageBody(editor.state.doc)) setDismissed(true); };
    editor.on("update", changed);
    editor.view.dom.addEventListener("compositionstart", composition);
    return () => {
      live = false;
      editor.off("update", changed);
      editor.view.dom.removeEventListener("compositionstart", composition);
    };
  }, [editor, pageId]);
  if (pageKind !== "page" || !empty || dismissed || !editor.isEditable) return null;
  return <div className="empty-page-prompts" role="group" aria-label="Start this page">
    <button type="button" onClick={() => editor.chain().focus("start").insertContent("/").run()} title="Open block commands">Press <kbd className="kbd">/</kbd> for commands</button>
    <button type="button" onClick={() => { editor.commands.focus("start"); BLOCK_KINDS.find(k => k.id === "calendar")?.apply(editor); }} title="Add a calendar to this page">Add calendar</button>
    <button type="button" onClick={() => { const ws = useWorkspace.getState().workspace; if (ws) useTemplateGallery.getState().show(pageId, ws.id, editor); }} title="Apply a page template or create from a project template">Pick a template</button>
  </div>;
}
