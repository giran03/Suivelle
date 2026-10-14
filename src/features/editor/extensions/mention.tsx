import { type Editor, mergeAttributes, Node } from "@tiptap/core";
import { usePeek } from "../../peek/store";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect } from "react";
import { create } from "zustand";
import { Icon } from "../../../components/Icon";
import { ipc } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";

export interface MentionItem {
  id: string;
  title: string;
  parentTitle: string | null;
}

interface MentionMenuState {
  open: boolean;
  query: string;
  items: MentionItem[];
  index: number;
  rect: (() => DOMRect | null) | null;
  choose: ((item: MentionItem) => void) | null;
}

export const useMentionMenu = create<MentionMenuState>(() => ({ open: false, query: "", items: [], index: 0, rect: null, choose: null }));
const close = () => useMentionMenu.setState({ open: false, items: [], index: 0, rect: null, choose: null });
const key = new PluginKey("pageMentionMenu");
const linkKey = new PluginKey("pageLinkMenu");

/** Candidates for "@": recent pages when nothing is typed, otherwise title matches. */
async function candidates(query: string): Promise<MentionItem[]> {
  const { workspace, selectedPageId } = useWorkspace.getState();
  if (!workspace) return [];
  try {
    if (!query.trim()) {
      const recents = await ipc.pageListRecent(workspace.id, 9);
      return recents.filter((p) => p.id !== selectedPageId).slice(0, 8).map((p) => ({ id: p.id, title: p.title, parentTitle: null }));
    }
    const hits = await ipc.searchWorkspace({ workspaceId: workspace.id, query, titlesOnly: true, limit: 12 });
    return hits
      .filter((h) => h.kind === "page" && h.pageId !== selectedPageId)
      .slice(0, 8)
      .map((h) => ({ id: h.pageId, title: h.pageTitle, parentTitle: h.parentTitle }));
  } catch {
    return [];
  }
}

function MentionView({ node }: NodeViewProps) {
  const pageId = String(node.attrs.pageId ?? "");
  const info = useWorkspace((s) => s.pageTitles[pageId]);
  useEffect(() => {
    if (pageId) void useWorkspace.getState().ensureTitles([pageId]);
  }, [pageId]);

  const missing = !!info?.missing;
  const deleted = !!info?.deleted;
  const text = !info ? "…" : missing ? "Unknown page" : deleted ? "Deleted page" : info.title || "Untitled";
  const state = missing || deleted ? " is-gone" : "";
  const follow = !missing && !deleted && !!pageId;

  return (
    <NodeViewWrapper
      as="span"
      className={`mention${state}`}
      role="link"
      aria-disabled={!follow}
      data-page-id={pageId}
      // A live page gets the hover preview card instead of a text tooltip.
      title={deleted ? "This page is in the trash" : missing ? "This page no longer exists" : undefined}
      onClick={(e: React.MouseEvent) => {
        // A click follows the link (Shift+click opens it beside this page); the caret is placed
        // beside the chip with the arrow keys.
        if (!follow) return;
        if (e.shiftKey) usePeek.getState().show(pageId);
        else void useWorkspace.getState().openPage(pageId);
      }}
    >
      <Icon name="page" size={14} />
      <span>{text}</span>
    </NodeViewWrapper>
  );
}

/** One page-picker trigger: "@" and "[[" share the menu, the candidates and the inserted mention. */
function pagePicker(editor: Editor, pluginKey: PluginKey, char: string) {
  return Suggestion<MentionItem, MentionItem>({
    editor,
    pluginKey,
    char,
    allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
    items: ({ query }) => candidates(query),
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [{ type: "pageMention", attrs: { pageId: props.id } }, { type: "text", text: " " }])
        .run();
      void useWorkspace.getState().ensureTitles([props.id]);
    },
    render: () => {
      const sync = (p: { query: string; items: MentionItem[]; clientRect?: (() => DOMRect | null) | null; command: (i: MentionItem) => void }) =>
        useMentionMenu.setState((s) => ({
          open: true,
          query: p.query,
          items: p.items,
          index: p.query === s.query ? Math.min(s.index, Math.max(0, p.items.length - 1)) : 0,
          rect: p.clientRect ?? null,
          choose: p.command,
        }));
      return {
        onStart: sync,
        onUpdate: sync,
        onExit: close,
        onKeyDown: ({ event, view }) => {
          const { items, index, choose } = useMentionMenu.getState();
          if (event.key === "Escape") {
            exitSuggestion(view, key);
            return true;
          }
          if (!items.length) return false;
          if (event.key === "ArrowDown") {
            useMentionMenu.setState({ index: (index + 1) % items.length });
            return true;
          }
          if (event.key === "ArrowUp") {
            useMentionMenu.setState({ index: (index - 1 + items.length) % items.length });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            choose?.(items[index]);
            return true;
          }
          return false;
        },
      };
    },
  });
}

export const PageMention = Node.create({
  name: "pageMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-id"),
        renderHTML: (attrs) => (attrs.pageId ? { "data-page-id": attrs.pageId as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-page-mention]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-page-mention": "" }, HTMLAttributes)];
  },

  renderText() {
    return "@page";
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView);
  },

  addProseMirrorPlugins() {
    return [pagePicker(this.editor, key, "@"), pagePicker(this.editor, linkKey, "[[")];
  },
});
