import { getMarkRange, type Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { plainPaste } from "./plainText";

export type SmartToken = { kind: "color" | "issue" | "file"; value: string; label: string };

export function webUrl(text: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Do not allow URL parsing to strip clipboard controls.
  if (text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function smartToken(raw: string): SmartToken | null {
  const text = raw.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Clipboard values must not contain control characters.
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(text)) return { kind: "color", value: text, label: text };
  const href = webUrl(text);
  if (href) {
    const url = new URL(href);
    const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && match
      ? { kind: "issue", value: href, label: `${match[1]}/${match[2]} #${match[3]}` } : null;
  }
  const path = /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/(?!\/))\S/i.test(path)) return null;
  if (/[<>"|?*]/.test(path) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(path)) return null;
  const label = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return label ? { kind: "file", value: path, label } : null;
}

/** Redundant clipboard HTML is safe only if it carries the same token and no rich block/media. */
function sameTokenHtml(html: string, text: string): boolean {
  if (!html) return true;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return !doc.body.querySelector("img,table,pre,code,ul,ol,iframe,video,audio,[data-smart-kind],[data-type]") && doc.body.textContent?.trim() === text.trim();
}

export function pasteSmart(editor: Editor, text: string, html = ""): boolean {
  if (!editor.isEditable || plainPaste.active || editor.isActive("codeBlock") || editor.isActive("code") || editor.isActive("equation")) return false;
  const selection = editor.state.selection;
  if (!(selection instanceof TextSelection) || !sameTokenHtml(html, text)) return false;
  const href = webUrl(text.trim());
  let tr = closeHistory(editor.state.tr);
  if (href && !selection.empty) {
    // Mark the existing words before Intake's media detection can consume the URL.
    if (!selection.$from.parent.inlineContent || !selection.$to.parent.inlineContent) return false;
    tr = tr.addMark(selection.from, selection.to, editor.schema.marks.link.create({ href })).setMeta("preventAutolink", true);
  } else {
    const token = smartToken(text);
    if (!token || !selection.$from.parent.inlineContent) return false;
    const marks = [editor.schema.marks.smartReference.create({ kind: token.kind, value: token.value })];
    if (token.kind === "issue") marks.push(editor.schema.marks.link.create({ href: token.value }));
    tr = tr.replaceSelectionWith(editor.schema.text(token.label, marks), false).setStoredMarks(null).setMeta("preventAutolink", true);
  }
  editor.view.dispatch(tr.setMeta("uiEvent", "paste").scrollIntoView());
  // The next keystroke must not merge with this paste's undo event.
  editor.view.dispatch(closeHistory(editor.state.tr));
  return true;
}

/** Convert the clicked reference only, even when it sits inside a larger text selection. */
export function convertSmartReference(editor: Editor, position: number): boolean {
  if (!editor.isEditable) return false;
  const range = getMarkRange(editor.state.doc.resolve(position), editor.schema.marks.smartReference);
  if (!range) return false;
  const mark = editor.state.doc.nodeAt(range.from)?.marks.find(m => m.type.name === "smartReference");
  if (typeof mark?.attrs.value !== "string") return false;
  return editor.chain().focus().setTextSelection(range).insertContent({ type: "text", text: mark.attrs.value, marks: [] }).run();
}

/** Plain clipboard/export text retains the full file path even when its badge shows a filename. */
export function referenceText(nodes: JSONContent[]): string {
  return nodes.map(node => {
    const mark = node.marks?.find(m => m.type === "smartReference" && m.attrs?.kind === "file");
    return mark?.attrs?.value ?? node.text ?? (node.type === "hardBreak" ? "\n" : referenceText(node.content ?? []));
  }).join(nodes.some(n => !["text", "hardBreak", "pageMention"].includes(n.type ?? "")) ? "\n" : "");
}
