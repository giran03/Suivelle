import { useEffect, useRef, useState } from "react";
import { syncDialog } from "../../lib/dialog";
import { toAppError } from "../../lib/ipc";
import { convertMediaPaste, useMediaPaste } from "./mediaPaste";
import "./mediaPaste.css";

export default function MediaPasteDialog() {
  const request = useMediaPaste((s) => s.requests[0]);
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (ref.current) syncDialog(ref.current, !!request); }, [request]);
  useEffect(() => { setError(""); }, [request?.id]);
  const keep = () => {
    if (!request || busy) return;
    useMediaPaste.getState().dismiss(request.id);
  };
  const label = request?.kind === "pdf" ? "PDF" : request?.kind ?? "image";
  const noun = label === "image" ? "an image" : label === "audio" ? "an audio block" : label === "embed" ? "an embed" : `a ${label}`;
  return <dialog ref={ref} className="palette media-paste-dialog" aria-labelledby="media-paste-title"
    onCancel={(e) => { e.preventDefault(); keep(); }} onClose={keep}
    onClick={(e) => { if (e.target === e.currentTarget) keep(); }}>
    <h2 id="media-paste-title">Convert this link to {noun}?</h2>
    <p>{request?.kind === "embed" ? "Show this link as an embedded player. Content loads when you choose to load it." : "Save a local copy and display it in your page. The media will also be available offline."}</p>
    <div className="media-paste-url">{request?.url}</div>
    {error && <p className="error" role="alert">{error} The pasted link is unchanged.</p>}
    <div className="media-paste-actions">
      <button type="button" className="btn" autoFocus disabled={busy} onClick={keep}>Keep link</button>
      <button type="button" className="btn primary" disabled={busy || !request} onClick={() => {
        if (!request) return;
        setBusy(true); setError("");
        void convertMediaPaste(request).catch((e) => setError(toAppError(e).message)).finally(() => setBusy(false));
      }}>{busy ? "Converting…" : `Convert to ${label}`}</button>
    </div>
  </dialog>;
}
