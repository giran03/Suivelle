import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { create } from "zustand";
import { ipc } from "../../lib/ipc";
import { newId } from "../../lib/ids";
import { useWorkspace } from "../../stores/workspace";
import { EMBED_DEFAULTS, embedTarget } from "./embedModel";
import { registerFlusher } from "./flushRegistry";

export type MediaPasteKind = "image" | "audio" | "video" | "pdf" | "embed";
export interface MediaPasteRequest {
  id: string; editor: Editor; workspaceId: string; url: string; kind: MediaPasteKind;
  range: { from: number; to: number }; cleanup: () => void;
}
export const useMediaPaste = create<{ requests: MediaPasteRequest[]; dismiss: (id: string) => void }>((set, get) => ({
  requests: [],
  dismiss: (id) => {
    get().requests.find((r) => r.id === id)?.cleanup();
    set((s) => ({ requests: s.requests.filter((r) => r.id !== id) }));
  },
}));

export function mediaUrlHint(url: string): MediaPasteKind | null {
  const ext = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  if (ext && ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "apng"].includes(ext)) return "image";
  if (ext && ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"].includes(ext)) return "audio";
  if (ext && ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  try { if (embedTarget(url).frame) return "embed"; } catch { /* Ordinary links stay links. */ }
  return null;
}

export function mediaPasteRangeValid(r: MediaPasteRequest): boolean {
  return !r.editor.isDestroyed && r.editor.isEditable && r.range.from >= 0 && r.range.from <= r.range.to && r.range.to <= r.editor.state.doc.content.size
    && r.editor.state.doc.textBetween(r.range.from, r.range.to, "", "") === r.url;
}

/** Paste the link first. Detection and consent must never lose clipboard content. */
export function pasteMediaUrl(editor: Editor, text: string): boolean {
  const workspace = useWorkspace.getState().workspace;
  const source = text.trim();
  if (!workspace || !editor.isEditable || source.length > 8192 || !/^https?:\/\/\S+$/i.test(source)) return false;
  let url: URL;
  try { url = new URL(source); } catch { return false; }
  if (url.username || url.password) return false;
  if (!editor.commands.insertContent({ type: "text", text: source, marks: [{ type: "link", attrs: { href: source } }] })) return false;
  const end = editor.state.selection.from;
  let active = true;
  const request: MediaPasteRequest = {
    id: newId(), editor, workspaceId: workspace.id, url: source, kind: "image",
    range: { from: end - source.length, to: end },
    cleanup: () => { active = false; editor.off("transaction", track); editor.off("destroy", destroyed); },
  };
  const track = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    request.range.from = transaction.mapping.map(request.range.from, 1);
    request.range.to = transaction.mapping.map(request.range.to, -1);
  };
  const destroyed = () => { request.cleanup(); useMediaPaste.getState().dismiss(request.id); };
  editor.on("transaction", track);
  editor.on("destroy", destroyed);
  void (async () => {
    let kind = mediaUrlHint(source);
    if (!kind) {
      try { kind = (await ipc.mediaUrlInfo(source))?.kind ?? null; } catch { /* Offline detection leaves the pasted link intact. */ }
    }
    if (!active || !kind || !mediaPasteRangeValid(request)) { request.cleanup(); return; }
    request.kind = kind;
    useMediaPaste.setState((s) => ({ requests: [...s.requests, request] }));
  })();
  return true;
}

export async function convertMediaPaste(request: MediaPasteRequest): Promise<void> {
  const work = (async () => {
    if (!mediaPasteRangeValid(request)) throw new Error("The pasted link has changed. Paste it again to convert it.");
    let type: string = "embed";
    let attrs: Record<string, unknown> = { ...EMBED_DEFAULTS, url: request.url };
    if (request.kind !== "embed") {
      const att = await ipc.attachmentImportUrl(request.workspaceId, request.url);
      type = att.mimeType.startsWith("image/") ? "image" : att.mimeType.startsWith("audio/") ? "audio" : att.mimeType.startsWith("video/") ? "video" : "pdf";
      attrs = { attachmentId: att.id, hash: att.hash, name: att.originalName, mime: att.mimeType, size: att.size };
    }
    if (!mediaPasteRangeValid(request)) throw new Error("The pasted link has changed. Paste it again to convert it.");
    if (!request.editor.commands.insertContentAt({ ...request.range }, { type, attrs })) throw new Error("Could not insert the media here.");
    useMediaPaste.getState().dismiss(request.id);
  })();
  const unregister = registerFlusher(() => work);
  try { await work; } finally { unregister(); }
}
