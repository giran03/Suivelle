import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { Icon } from "../../../components/Icon";
import { ipc, toAppError } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";
import type { Page } from "../../../types";
import { createSyncedPage, listSyncedPages, unsyncBlock } from "../synced";
import "../embeds.css";
import { PickItem, useLoaded } from "./pickers";

// Loaded on use: the nested editor builds these same extensions, so a static import would be a cycle.
const SyncedEditor = lazy(() => import("../SyncedEditor").then((m) => ({ default: m.SyncedEditor })));

/**
 * Only one place on a page may edit a given synced block at a time: two live editors writing the
 * same rows would overwrite each other. The first to mount owns it; any other shows a read-only view.
 */
const owners = new Map<string, string>();

function useOwnership(pageId: string | null): boolean | null {
  const me = useId();
  const [mine, setMine] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pageId) {
      setMine(null);
      return;
    }
    if (!owners.has(pageId)) owners.set(pageId, me);
    setMine(owners.get(pageId) === me);
    return () => {
      if (owners.get(pageId) === me) owners.delete(pageId);
    };
  }, [pageId, me]);
  return mine;
}

function Picker({ onPick }: { onPick: (pageId: string) => void }) {
  const { data: pages, error, setError } = useLoaded("synced", () => listSyncedPages());

  const create = async () => {
    try {
      onPick((await createSyncedPage("Synced block")).id);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  return (
    <div className="dbv-picker">
      <button type="button" className="btn primary" onClick={() => void create()}>
        <Icon name="plus" />
        New synced block
      </button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {pages && pages.length > 0 && <p className="picker-muted">Or show one that already exists</p>}
      <ul className="dbv-picker-list">
        {pages?.map((p) => (
          <PickItem key={p.id} icon="duplicate" onPick={() => onPick(p.id)}>
            {p.title || "Untitled"}
          </PickItem>
        ))}
      </ul>
    </div>
  );
}

function SyncedView({ node, updateAttributes, editor, selected, getPos }: NodeViewProps) {
  const pageId = (node.attrs.pageId as string | null) ?? null;
  const pageEditable = editor.isEditable;
  const ownership = useOwnership(pageId);
  const [page, setPage] = useState<Page | null>(null);
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    if (!pageId) return;
    let alive = true;
    setMissing(false);
    ipc
      .pageGet(pageId)
      .then((p) => (p.deletedAt ? setMissing(true) : alive && setPage(p)))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [pageId]);

  if (!pageId) {
    return (
      <NodeViewWrapper className={`synced${selected ? " is-selected" : ""}`} contentEditable={false}>
        {pageEditable ? <Picker onPick={(id) => updateAttributes({ pageId: id })} /> : <p className="dbv-none">No synced block chosen.</p>}
      </NodeViewWrapper>
    );
  }

  if (missing) {
    return (
      <NodeViewWrapper className="synced" contentEditable={false}>
        <div className="dbv-missing" role="alert">
          <Icon name="warning" />
          <span>This synced block's content is gone. It may have been deleted or moved to the trash.</span>
          {pageEditable && (
            <button type="button" className="btn" onClick={() => updateAttributes({ pageId: null })}>
              Choose another
            </button>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  const commitName = async () => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (!page || !name || name === page.title) return;
    await useWorkspace.getState().renamePage(page.id, name);
    setPage({ ...page, title: name });
  };

  const canEdit = pageEditable && ownership === true;
  return (
    <NodeViewWrapper className={`synced${selected ? " is-selected" : ""}`} contentEditable={false}>
      <div className="synced-head">
        <Icon name="duplicate" size={14} />
        <span className="synced-tag">Synced</span>
        {renaming !== null ? (
          <input
            autoFocus
            className="synced-name-input"
            value={renaming}
            aria-label="Name of this synced block"
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void commitName();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button type="button" className="synced-name" disabled={!pageEditable} title="Rename" onClick={() => setRenaming(page?.title ?? "")}>
            {page ? page.title || "Untitled" : "Loading…"}
          </button>
        )}
        <span className="dbv-spacer" />
        <button type="button" className="icon-btn" aria-label="Open the synced page" title="Open the page that holds this content" onClick={() => void useWorkspace.getState().openPage(pageId)}>
          <Icon name="open" size={14} />
        </button>
        {pageEditable && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Unsync and copy the content here"
            title="Unsync: put a copy of the content here instead"
            onClick={() => void unsyncBlock(editor, getPos, node, pageId)}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {ownership === false && (
        <p className="synced-note">This synced block is also shown above on this page, so it can only be edited there. This copy updates as you edit it.</p>
      )}
      {ownership !== null && <Suspense fallback={null}><SyncedEditor key={pageId} pageId={pageId} editable={canEdit} /></Suspense>}
    </NodeViewWrapper>
  );
}

export const SyncedBlock = Node.create({
  name: "syncedBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return { pageId: { default: null } };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="synced-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "synced-block" }, HTMLAttributes)];
  },

  addNodeView() {
    // The nested editor handles its own keys and pointers; the page's editor must not.
    return ReactNodeViewRenderer(SyncedView, { stopEvent: () => true, ignoreMutation: () => true });
  },
});
