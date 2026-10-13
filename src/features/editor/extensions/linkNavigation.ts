import { Extension } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { Plugin } from "@tiptap/pm/state";
import { openExternalLink } from "../../../lib/links";
import { pageLinkTarget } from "../../../lib/legacy";
import { toAppError } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";
import { usePeek } from "../../peek/store";

export async function openEditorLink(href: string, peek = false): Promise<void> {
  try {
    const id = pageLinkTarget(href);
    if (id) { if (peek) usePeek.getState().show(id); else await useWorkspace.getState().openPage(id); }
    else await openExternalLink(href);
  } catch (e) { useWorkspace.getState().setError(toAppError(e).message); }
}

function followLink(view: EditorView, event: MouseEvent | KeyboardEvent): boolean {
  if (event.defaultPrevented || event.type === "click" && (event as MouseEvent).button !== 0 || event.type === "auxclick" && (event as MouseEvent).button !== 1 || event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return false;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link || !view.dom.contains(link)) return false;
  event.preventDefault();
  const href = link.getAttribute("href")!;
  const selection = window.getSelection();
  if (event.type === "click" && !pageLinkTarget(href) && !event.ctrlKey && !event.metaKey && selection && !selection.isCollapsed && (link.contains(selection.anchorNode) || link.contains(selection.focusNode))) return true;
  void openEditorLink(href, event.shiftKey);
  return true;
}

/** The same behavior in main, peek, and nested editors, while text selection stays editable. */
export const LinkNavigation = Extension.create({
  name: "linkNavigation",
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleDOMEvents: { click: followLink, auxclick: followLink, keydown: followLink } } })];
  },
});
