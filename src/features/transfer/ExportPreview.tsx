import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { syncDialog } from "../../lib/dialog";
import { attachmentUrl } from "../../lib/attachments";
import { ipc } from "../../lib/ipc";

type Preview = Awaited<ReturnType<typeof ipc.exportPagePreview>>;
export function ExportPreview({
  preview,
  format,
  busy,
  error,
  onSave,
  onClose,
}: {
  preview: Preview;
  format: "markdown" | "html";
  busy: boolean;
  error?: string | null;
  onSave: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState(false);
  useEffect(() => {
    if (dialog.current) syncDialog(dialog.current, true);
  }, []);
  const document = new DOMParser().parseFromString(preview.html, "text/html");
  for (const img of document.querySelectorAll("img")) {
    const asset = preview.assets[img.getAttribute("src") ?? ""];
    if (asset) {
      const c = asset.crop;
      img.src = `${attachmentUrl(asset.hash)}${c ? `?crop=${c.x},${c.y},${c.width},${c.height}` : ""}`;
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="palette export-preview"
      aria-label="Export preview"
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onCancel={(e) => {
        e.stopPropagation();
        if (busy) e.preventDefault();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="media-viewer-head">
        <strong>Export as {format === "html" ? "HTML" : "Markdown"}</strong>
        <button
          className="btn ghost"
          aria-pressed={!source}
          onClick={() => setSource(false)}
        >
          Preview
        </button>
        <button
          className="btn ghost"
          aria-pressed={source}
          onClick={() => setSource(true)}
        >
          Source
        </button>
      </header>
      <div className="export-preview-content">
        {preview.notices.length > 0 && (
          <ul className="export-notices">
            {preview.notices.map((notice, i) => (
              <li key={i}>{notice}</li>
            ))}
          </ul>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {source ? (
          <pre tabIndex={0} aria-label="Export source">
            {preview.source}
          </pre>
        ) : (
          <iframe
            title="Rendered export preview"
            sandbox=""
            srcDoc={document.documentElement.outerHTML}
          />
        )}
      </div>
      <footer className="media-viewer-head">
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => {
            if (dialog.current) syncDialog(dialog.current, false);
          }}
        >
          Cancel
        </button>
        <button className="btn" disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : "Save export…"}
        </button>
      </footer>
    </dialog>,
    window.document.body,
  );
}
