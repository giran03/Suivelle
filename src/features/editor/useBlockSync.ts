import type { Editor } from "@tiptap/core";
import { READ_ONLY } from "../../lib/access";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { blocksToDoc, diffBlocks, docToBlocks, positionsOf, rowFromBlock, type BlockRow } from "./convert";
import { registerFlusher } from "./flushRegistry";

const DEBOUNCE_MS = 500;
const RETRY_MS = 3000;

export type SaveState = "idle" | "saving" | "error";

/**
 * Loads a page's blocks into the editor and autosaves edits.
 *
 * Edits are buffered; after a short pause the document is converted to rows, diffed against what
 * is stored, and only the changes are sent in one transaction. A failed save keeps the changes
 * pending and retries, so text is never dropped. Pending edits are flushed on blur, page change,
 * window hide and unmount.
 */
export function useBlockSync(editor: Editor | null, pageId: string) {
  const saved = useRef(new Map<string, BlockRow>());
  const dirty = useRef(false);
  const failure = useRef<string | null>(null);
  const loaded = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const focusAfterReload = useRef(false);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ pageId: string; focusEditor: Editor | null }>).detail;
      if (detail.pageId === pageId) { focusAfterReload.current = detail.focusEditor === editor; setReload(n => n + 1); }
    };
    window.addEventListener("page-template-applied", refresh);
    return () => window.removeEventListener("page-template-applied", refresh);
  }, [pageId, editor]);

  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    if (READ_ONLY || !editor || editor.isDestroyed || !loaded.current || !dirty.current) return chain.current;
    // Convert now, while the editor is certainly alive; send in order behind any save in flight.
    const next = docToBlocks(editor.getJSON(), positionsOf(saved.current.values()));
    const { upserts, deleteIds } = diffBlocks(saved.current, next);
    dirty.current = false;
    if (!upserts.length && !deleteIds.length) return chain.current;
    chain.current = chain.current.then(async () => {
      setState("saving");
      try {
        await ipc.blockApplyBatch({ pageId, upserts, deleteIds });
        upserts.forEach((r) => saved.current.set(r.id, r));
        deleteIds.forEach((id) => saved.current.delete(id));
        setState(dirty.current ? "saving" : "idle");
        failure.current = null;
        setSaveError(null);
      } catch (e) {
        const err = toAppError(e);
        dirty.current = true; // keep the changes; they are re-diffed on the next attempt
        setState("error");
        failure.current = err.message;
        setSaveError(err.message);
        // A page that no longer exists will never accept edits; do not retry forever.
        if (err.code !== "not_found") timer.current = window.setTimeout(() => void flush(), RETRY_MS);
      }
    });
    return chain.current;
  }, [editor, pageId]);

  // Schedule edits write through a backend transaction. Reload their page after flushing,
  // so a later note edit cannot overwrite the saved schedule with stale node attributes.
  useEffect(() => {
    if(!editor)return;
    let alive=true;
    const onSaved=(event:Event)=>{
      if((event as CustomEvent<string>).detail!==pageId)return;
      void ipc.blockList(pageId).then(blocks=>{
        if(!alive||editor.isDestroyed)return;
        const rows=blocks.map(rowFromBlock);
        const schedules=new Map(rows.filter(row=>row.type==="calendar_event").map(row=>[row.id,row]));
        const tr=editor.state.tr;
        editor.state.doc.descendants((node,pos)=>{
          const row=schedules.get(node.attrs.blockId);
          if(node.type.name==="calendarEvent"&&row){saved.current.set(row.id,row);tr.setNodeMarkup(pos,undefined,{...node.attrs,schedule:JSON.parse(row.dataJson)});}
        });
        if(tr.docChanged)editor.view.dispatch(tr);
      }).catch(e=>setLoadError(toAppError(e).message));
    };
    window.addEventListener("calendar-event-saved",onSaved);
    return()=>{alive=false;window.removeEventListener("calendar-event-saved",onSaved);};
  },[editor,pageId]);

  // Load the page's blocks.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    loaded.current = false;
    dirty.current = false;
    setReady(false);
    setLoadError(null);
    editor.setEditable(false);
    (async () => {
      try {
        const blocks = await ipc.blockList(pageId);
        if (cancelled || editor.isDestroyed) return;
        const rows = blocks.map(rowFromBlock);
        saved.current = new Map(rows.map((r) => [r.id, r]));
        editor.commands.setContent(blocksToDoc(rows), { emitUpdate: false });
        loaded.current = true;
          editor.setEditable(!READ_ONLY);
        setReady(true);
        if (focusAfterReload.current) { focusAfterReload.current = false; editor.commands.focus("end"); }
      } catch (e) {
        // Never autosave over content we could not read: stay read-only and say why.
        if (!cancelled) setLoadError(toAppError(e).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, pageId, reload]);

  // Buffer edits, and flush on the events that could lose them.
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      if (READ_ONLY || !loaded.current) return;
      dirty.current = true;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    };
    const onHide = () => void flush();
    editor.on("update", onUpdate);
    editor.on("blur", onHide);
    window.addEventListener("blur", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    const unregister = registerFlusher(async () => { await flush(); if (dirty.current || failure.current) throw new Error(failure.current ?? "Page changes are not saved yet. Retry saving before switching workspaces."); });
    return () => {
      editor.off("update", onUpdate);
      editor.off("blur", onHide);
      window.removeEventListener("blur", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
      unregister();
      void flush();
    };
  }, [editor, flush]);

  return { state, saveError, loadError, ready, retry: flush };
}
