import { useEffect } from "react";
import { usePresence } from "../lib/presence";
import { useWorkspace } from "../stores/workspace";

/** One transient notice with an optional undo; conveys the result of a reversible action. */
export function Toast() {
  const live = useWorkspace((s) => s.toast);
  const { item: toast, leaving } = usePresence(live, 250);
  const dismiss = useWorkspace((s) => s.dismissToast);

  useEffect(() => {
    if (!live) return;
    const t = window.setTimeout(dismiss, 7000);
    return () => window.clearTimeout(t);
  }, [live, dismiss]);

  if (!toast) return null;
  return (
    <div className={`toast${leaving ? " is-closing" : ""}`} role="status">
      <span>{toast.message}</span>
      {toast.undo && (
        <button
          onClick={() => {
            const undo = toast.undo;
            dismiss();
            void undo?.();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
