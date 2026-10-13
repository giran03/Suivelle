import { EditorContent, useEditor } from "@tiptap/react";
import { READ_ONLY } from "../../lib/access";
import { useEffect } from "react";
import { Backlinks } from "../pages/Backlinks";
import { useActiveEditor } from "../../stores/activeEditor";
import { useSaveStatus } from "../../stores/saveStatus";
import { useWorkspace } from "../../stores/workspace";
import { recallScroll, rememberScroll } from "../session/persist";
import "./editor.css";
import { EditorContextMenu } from "./EditorContextMenu";
import { BlockHandle } from "./BlockHandle";
import { buildExtensions } from "./extensions";
import { blockFlashKey } from "./extensions/flash";
import { MentionMenu } from "./MentionMenu";
import { SelectionToolbar } from "./SelectionToolbar";
import { SlashMenu } from "./SlashMenu";
import { TableToolbar } from "./TableToolbar";
import { useBlockSync } from "./useBlockSync";
import { pageLinkTarget } from "../../lib/legacy";

/** The page body: one TipTap document whose blocks are saved as individual rows. */
export function Editor({ pageId }: { pageId: string }) {
  const editor = useEditor({
    extensions: buildExtensions(),
    editable: false,
    editorProps: {
      attributes: {
        class: "doc",
        "aria-label": "Page content",
        "aria-multiline": "true",
        spellcheck: "true",
      },
      handleDOMEvents: {
        // A link to another page (from "Copy link to this page") opens it, like a mention.
        click: (_view, event) => {
          const a = (event.target as HTMLElement | null)?.closest?.("a[href]");
          const id = pageLinkTarget(a?.getAttribute("href") ?? "");
          if (!id) return false;
          event.preventDefault();
          void useWorkspace.getState().openPage(id);
          return true;
        },
      },
    },
  });
  const { state, saveError, loadError, retry, ready } = useBlockSync(editor, pageId);
  const focusTarget = useWorkspace((s) => s.focusTarget);

  // Find in page and the outline reach this editor through the registry, once its content is in.
  useEffect(() => {
    if (!editor || !ready) return;
    useActiveEditor.getState().set(editor);
    return () => {
      if (useActiveEditor.getState().editor === editor) useActiveEditor.getState().set(null);
    };
  }, [editor, ready]);

  // The topbar shows "Saving…", "Saved" or a retry; this editor is the source of truth for it.
  useEffect(() => {
    useSaveStatus.getState().report(state, saveError, () => void retry());
  }, [state, saveError, retry]);
  useEffect(() => () => useSaveStatus.getState().clear(), []);

  // Reopen the page where it was left, and keep remembering as it scrolls.
  useEffect(() => {
    if (!ready) return;
    const scroller = document.querySelector<HTMLElement>(".main-scroll");
    if (!scroller) return;
    if (!useWorkspace.getState().focusTarget) {
      const top = recallScroll(pageId);
      if (top) requestAnimationFrame(() => (scroller.scrollTop = top));
    }
    let timer: number | undefined;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => rememberScroll(pageId, scroller.scrollTop), 250);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [ready, pageId]);

  // Search results and backlinks point at a block: scroll to it and flash it once.
  useEffect(() => {
    if (!editor || !ready || !focusTarget || focusTarget.pageId !== pageId) return;
    const focusBlockId = focusTarget.blockId;
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos >= 0) return false;
      if (node.attrs?.blockId === focusBlockId) {
        pos = p;
        return false;
      }
      return true;
    });
    useWorkspace.setState({ focusTarget: null });
    if (pos < 0) return;
    editor.view.dispatch(editor.state.tr.setMeta(blockFlashKey, focusBlockId));
    (editor.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
    // Not cancelled on re-run: the highlight must still be removed after the target resets.
    window.setTimeout(() => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(blockFlashKey, null));
    }, 1700);
  }, [editor, ready, focusTarget, pageId]);

  return (
    <div
      className="editor"
      // Clicking the empty space under the last block puts the caret at the end.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && editor?.isEditable) {
          e.preventDefault();
          editor.commands.focus("end");
        }
      }}
    >
      {loadError && (
        <div className="error" role="alert">
          <span>This page could not be loaded, so it is read-only to protect your content. {loadError}</span>
        </div>
      )}
      <EditorContent editor={editor} />
      {ready && <Backlinks pageId={pageId} />}
      {editor && !READ_ONLY && (
        <>
          <EditorContextMenu editor={editor} />
          <BlockHandle editor={editor} />
          <SelectionToolbar editor={editor} />
          <TableToolbar editor={editor} />
          <SlashMenu editor={editor} />
          <MentionMenu editor={editor} />
        </>
      )}
      {state === "error" && (
        <div className="error save-error" role="alert">
          <span>Changes are not saved yet. {saveError}</span>
          <button onClick={() => void retry()}>Retry now</button>
        </div>
      )}
    </div>
  );
}
