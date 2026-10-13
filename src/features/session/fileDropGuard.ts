/**
 * Native file-drop handling is off (see tauri.conf.json) so that pages can receive dropped files.
 * The price is that a file dropped anywhere else would make the webview navigate to it and replace
 * the whole app. This keeps every drop inside the app, and marks the page while a file is dragged
 * over the window so the editor can show where it will land.
 */
export function installFileDropGuard(): () => void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  const mark = (on: boolean) => document.body.classList.toggle("file-drag", on);

  const over = (e: DragEvent) => {
    if (hasFiles(e)) e.preventDefault();
  };
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth++;
    mark(true);
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) mark(false);
  };
  const drop = (e: DragEvent) => {
    if (hasFiles(e)) e.preventDefault();
    depth = 0;
    mark(false);
  };

  window.addEventListener("dragover", over);
  window.addEventListener("dragenter", enter);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragenter", enter);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
    mark(false);
  };
}
