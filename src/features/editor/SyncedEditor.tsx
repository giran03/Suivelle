import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { ipc } from "../../lib/ipc";
import { blocksToDoc, rowFromBlock } from "./convert";
import { announceSyncedSaved, onSyncedSaved } from "./syncedBus";
import { EditorContextMenu } from "./EditorContextMenu";
import { buildExtensions } from "./extensions";
import { SelectionToolbar } from "./SelectionToolbar";
import { TableToolbar } from "./TableToolbar";
import { useBlockSync } from "./useBlockSync";

/**
 * The body of a synced block: a second editor on the synced page's blocks, saved like any page. It
 * cannot hold another synced block. The slash and mention menus are the page's own (they share one
 * menu), so only the toolbars that follow this editor's selection are mounted here.
 */
export function SyncedEditor({ pageId, editable }: { pageId: string; editable: boolean }) {
  const editor = useEditor({
    extensions: buildExtensions({ nested: true }),
    editable: false,
    editorProps: { attributes: { class: "doc synced-doc", "aria-label": "Synced block content", "aria-multiline": "true", spellcheck: "true" } },
  });
  const { ready, loadError, state, saveError, retry } = useBlockSync(editor, pageId);

  // Another view of the same content saving is news to this one: a read-only copy shows it live.
  const previous = useRef(state);
  useEffect(() => {
    if (previous.current === "saving" && state === "idle") announceSyncedSaved(pageId);
    previous.current = state;
  }, [state, pageId]);
  useEffect(() => {
    if (!editor || editable) return;
    let alive = true;
    const off = onSyncedSaved(pageId, () => {
      ipc
        .blockList(pageId)
        .then((blocks) => {
          if (alive && !editor.isDestroyed) editor.commands.setContent(blocksToDoc(blocks.map(rowFromBlock)), { emitUpdate: false });
        })
        .catch(() => undefined); // it will show the new content the next time it is opened
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editable, pageId]);

  // The sync hook opens the editor once loaded; the page's own editability and ownership decide the rest.
  useEffect(() => {
    if (editor && ready && !editor.isDestroyed) editor.setEditable(editable);
  }, [editor, ready, editable]);

  return (
    <div className="synced-body">
      {loadError && (
        <p className="error-text" role="alert">
          This synced content could not be loaded, so it is read-only. {loadError}
        </p>
      )}
      <EditorContent editor={editor} />
      {editor && (
        <>
          <EditorContextMenu editor={editor} />
          <SelectionToolbar editor={editor} />
          <TableToolbar editor={editor} />
        </>
      )}
      {state === "error" && (
        <p className="error-text" role="alert">
          Changes are not saved yet. {saveError}{" "}
          <button type="button" className="link" onClick={() => void retry()}>
            Retry now
          </button>
        </p>
      )}
    </div>
  );
}
