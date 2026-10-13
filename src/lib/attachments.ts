import { convertFileSrc } from "@tauri-apps/api/core";

/** URLs for the Rust content-addressed attachment protocol, independent of editor code. */
export const attachmentUrl = (hash: string): string => convertFileSrc(hash, "attachment");
// Version the URL too: WebView caches must not reuse a flattened animation from older thumbnails.
export const thumbUrl = (hash: string, edge: 320 | 640 | 1280): string => `${attachmentUrl(hash)}?thumb=${edge}&v=2`;
