import { ipc } from "./ipc";

/** Keep the workspace in its window; external destinations open in the user's browser. */
export async function openExternalLink(href: string): Promise<void> {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters before URL parsing can strip them.
  if (/[\u0000-\u001f\u007f]/.test(href)) throw new Error("This link contains invalid characters.");
  let url: URL;
  try { url = new URL(href); } catch { throw new Error("This link is not a valid URL."); }
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("Only web and email links can be opened externally.");
  if ("__TAURI_INTERNALS__" in window) await ipc.imageOpenLink(url.href);
  else window.open(url.href, "_blank", "noopener,noreferrer");
}
