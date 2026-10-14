import { create } from "zustand";
import { ipc } from "../../lib/ipc";
import type { PagePreview } from "../../types";

const TTL_MS = 30_000;
const MAX_CACHED = 50;
const cache = new Map<string, { at: number; value: PagePreview | null }>();

interface PreviewCardState {
  pageId: string | null;
  anchor: DOMRect | null;
  /** `undefined` while loading, `null` when the page is gone. */
  data: PagePreview | null | undefined;
}

export const usePreviewCard = create<PreviewCardState>(() => ({ pageId: null, anchor: null, data: undefined }));

/** Drops what is remembered about a page (or all pages), so the next hover reads fresh text. */
export function invalidatePreview(pageId?: string): void {
  if (pageId) cache.delete(pageId);
  else cache.clear();
}

export function showPreview(pageId: string, anchor: DOMRect): void {
  const hit = cache.get(pageId);
  const fresh = hit && Date.now() - hit.at < TTL_MS;
  usePreviewCard.setState({ pageId, anchor, data: fresh ? hit.value : undefined });
  if (fresh) return;
  void ipc
    .pagePreview(pageId)
    .then((value) => {
      cache.delete(pageId);
      cache.set(pageId, { at: Date.now(), value });
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
      if (usePreviewCard.getState().pageId === pageId) usePreviewCard.setState({ data: value });
    })
    .catch(() => {
      if (usePreviewCard.getState().pageId === pageId) usePreviewCard.setState({ data: null });
    });
}

export function hidePreview(): void {
  if (usePreviewCard.getState().pageId) usePreviewCard.setState({ pageId: null, anchor: null, data: undefined });
}
