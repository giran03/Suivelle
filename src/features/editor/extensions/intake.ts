import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { newId } from "../../../lib/ids";
import { ipc, toAppError } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";
import type { BlockRow } from "../convert";
import { blocksToDoc } from "../convert";
import { replaceBlock } from "../commands";
import { jsonToMarkdown, looksLikeMarkdown } from "../markdown";
import { registerFlusher } from "../flushRegistry";
import { plainPaste } from "../plainText";

const MAX_BYTES = 256 * 1024 * 1024;
/** Copying "an image" from a web page puts just an <img> tag next to the file; the file wins. */
const IMAGE_ONLY_HTML = /^\s*(?:<meta[^>]*>\s*)?<img\b[^>]*>\s*$/i;

function kindOf(mime: string): "image" | "audio" | "video" | "pdf" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return mime === "application/pdf" ? "pdf" : "file";
}

/** Screenshots arrive as "image.png"; give them a name that says when they were taken. */
function fileName(file: File): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const ext = file.type.split("/")[1]?.split("+")[0] || "png";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Pasted image ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

/** Swaps the placeholder with this token for the finished block, or removes it when `attrs` is null. */
export function finishPending(editor: Editor, token: string, attrs: Record<string, unknown> | null, kind?: string): void {
  let found: { pos: number; size: number; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.attrs?.pending === token) found = { pos, size: node.nodeSize, attrs: node.attrs };
    return !found;
  });
  if (!found) return;
  const { pos, size, attrs: old } = found as { pos: number; size: number; attrs: Record<string, unknown> };
  const tr = editor.state.tr;
  if (!attrs) tr.delete(pos, pos + size);
  else tr.setNodeMarkup(pos, kind ? editor.schema.nodes[kind] : undefined, { ...old, ...attrs });
  editor.view.dispatch(tr);
}

/** Stores each file and puts it in the page as the matching block, one after another. */
export async function importFiles(editor: Editor, files: File[]): Promise<void> {
  const pending = importFilesNow(editor, files);
  const unregister = registerFlusher(() => pending);
  try { await pending; } finally { unregister(); }
}

async function importFilesNow(editor: Editor, files: File[]): Promise<void> {
  const ws = useWorkspace.getState().workspace;
  if (!ws || !editor.isEditable) return;
  const { setError } = useWorkspace.getState();
  for (const file of files) {
    if (file.size === 0) {
      setError(`“${file.name || "That file"}” is empty, so it was not added.`);
      continue;
    }
    if (file.size > MAX_BYTES) {
      setError(`“${file.name}” is larger than 256 MB. Add big files with a File block from the / menu instead.`);
      continue;
    }
    // Show the block straight away, so there is something to see while the file is stored.
    const name = fileName(file);
    const token = newId();
    replaceBlock(editor, { type: kindOf(file.type), attrs: { pending: token, name } });
    try {
      const att = await ipc.attachmentImportBytes(ws.id, name, await file.arrayBuffer());
      if (editor.isDestroyed) return;
      finishPending(editor, token, {
        attachmentId: att.id,
        hash: att.hash,
        name: att.originalName,
        mime: att.mimeType,
        size: att.size,
        pending: null,
      }, kindOf(att.mimeType));
    } catch (e) {
      if (!editor.isDestroyed) finishPending(editor, token, null);
      setError(toAppError(e).message);
    }
  }
}

/** Where new top-level-ish blocks go: over an empty paragraph, else after the block holding the caret. */
function insertionPoint(editor: Editor): { from: number; to: number } {
  const { $from } = editor.state.selection;
  const paragraph = editor.schema.nodes.paragraph;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    const parent = $from.node(d - 1);
    const index = $from.index(d - 1);
    if (node.type === paragraph && node.content.size === 0 && parent.canReplaceWith(index, index + 1, paragraph)) {
      return { from: $from.before(d), to: $from.after(d) };
    }
    if (parent.canReplaceWith(index + 1, index + 1, paragraph)) return { from: $from.after(d), to: $from.after(d) };
  }
  const end = editor.state.doc.content.size;
  return { from: end, to: end };
}

async function pasteMarkdown(editor: Editor, text: string): Promise<void> {
  try {
    const rows = await ipc.markdownToBlocks(text);
    if (editor.isDestroyed) return;
    const nodes = rows.length ? (blocksToDoc(rows as BlockRow[]).content ?? []) : [];
    if (!nodes.length) throw new Error("nothing to paste");
    editor.chain().focus().insertContentAt(insertionPoint(editor), nodes).run();
  } catch {
    // Parsing is a convenience; the text itself must always arrive.
    if (!editor.isDestroyed) editor.chain().focus().insertContent(text).run();
  }
}

/**
 * Brings things into the page from outside: pasted or dropped files become media blocks, pasted
 * Markdown becomes blocks, and copied blocks leave as Markdown text (rich HTML is unchanged).
 */
export const Intake = Extension.create({
  name: "intake",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("intake"),
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData;
            if (!data || !editor.isEditable) return false;
            const files = Array.from(data.files ?? []);
            const html = data.getData("text/html");
            if (files.length && (!html || IMAGE_ONLY_HTML.test(html))) {
              event.preventDefault();
              void importFiles(editor, files);
              return true;
            }
            if (!files.length && !html) {
              const text = data.getData("text/plain");
              if (text && !plainPaste.active && looksLikeMarkdown(text) && !editor.isActive("codeBlock") && !editor.isActive("equation")) {
                event.preventDefault();
                void pasteMarkdown(editor, text);
                return true;
              }
            }
            return false;
          },

          handleDrop: (view, event, _slice, moved) => {
            if (moved || !editor.isEditable) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
            void importFiles(editor, files);
            return true;
          },

          clipboardTextSerializer: (slice) => {
            const only = slice.content.childCount === 1 ? slice.content.firstChild : null;
            // A few words from inside one text block copy as plain text, without markup.
            if (only?.isTextblock && (slice.openStart > 0 || slice.openEnd > 0)) {
              return slice.content.textBetween(0, slice.content.size, "\n");
            }
            const titles = useWorkspace.getState().pageTitles;
            const json = slice.content.toJSON();
            return Array.isArray(json) ? jsonToMarkdown(json, { pageTitle: (id) => titles[id]?.title }) : "";
          },
        },
      }),
    ];
  },
});
