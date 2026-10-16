import { useShortcutScope } from "../shortcuts/runtime";
import { useShortcut } from "../shortcuts/useShortcut";
import { useEffect, useRef, useState } from "react";
import { useQuickCapture } from "./store";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import { capture } from "./capture";
import { syncDialog } from "../../lib/dialog";
import "./capture.css";

export interface CaptureOptions { todo: boolean; target: "inbox" | "page" }

export function CaptureBody({ onClose, onSave = capture, page, ready = true }: {
  onClose: () => void;
  onSave?: (text: string, options: CaptureOptions) => Promise<string | null>;
  page?: { title: string } | null;
  ready?: boolean;
}) {
  const [text, setText] = useState("");
  const [todo, setTodo] = useState(false);
  const [target, setTarget] = useState<"inbox" | "page">("inbox");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const saveShortcut = useShortcut("capture-save");
  const input = useRef<HTMLTextAreaElement>(null);
  const selectedPage = useWorkspace((s) => (s.view === "page" && s.selectedPage?.kind === "page" ? s.selectedPage : null));
  const openPage = page === undefined ? selectedPage : page;
  const saving = useRef(false);

  useEffect(() => input.current?.focus(), []);

  const save = async () => {
    if (saving.current || !ready || !text.trim()) return;
    saving.current = true;
    setBusy(true);
    try {
      const message = await onSave(text, { todo, target: target === "page" && openPage ? "page" : "inbox" });
      if (message) setError(message);
      else onClose();
    } catch {
      setError("Could not save this capture. Please try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  useShortcutScope(formRef, "capture", { "capture-save": () => { if (busy || !ready) return false; void save(); } });
  return (
    <form
      ref={formRef}
      className="qc"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onClose();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="qc-head">
        <h2>Quick capture</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
          <Icon name="close" />
        </button>
      </div>
      <textarea
        ref={input}
        className="qc-text"
        rows={4}
        value={text}
        placeholder="Jot something down. One line per item."
        aria-label="What to capture"
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}

      />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="qc-foot">
        <div className="seg" role="radiogroup" aria-label="Save as">
          <button type="button" role="radio" aria-checked={!todo} className={!todo ? "on" : ""} onClick={() => setTodo(false)}>
            Note
          </button>
          <button type="button" role="radio" aria-checked={todo} className={todo ? "on" : ""} onClick={() => setTodo(true)}>
            To-do
          </button>
        </div>
        <label className="qc-where">
          <span className="sr-only">Save to</span>
          <select value={target} onChange={(e) => setTarget(e.target.value as "inbox" | "page")}>
            <option value="inbox">Inbox</option>
            <option value="page" disabled={!openPage}>
              {openPage ? `This page: ${openPage.title || "Untitled"}` : "This page (none open)"}
            </option>
          </select>
        </label>
        <span className="qc-spacer" />
        <button type="submit" className="btn primary" disabled={busy || !ready || !text.trim()}>
          Add
        </button>
      </div>
      <p className="qc-hint">
        <kbd className="kbd">{saveShortcut.label || "Add button"}</kbd> adds it <kbd className="kbd">Shift</kbd>
        <kbd className="kbd">Enter</kbd> new line
      </p>
    </form>
  );
}

/** A small box for getting a thought down fast, into the Inbox or the page you are on. */
export function QuickCapture() {
  const open = useQuickCapture((s) => s.open);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="palette capture"
      aria-label="Quick capture"
      onClose={() => useQuickCapture.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useQuickCapture.getState().hide();
      }}
    >
      {open && <CaptureBody onClose={() => useQuickCapture.getState().hide()} />}
    </dialog>
  );
}
