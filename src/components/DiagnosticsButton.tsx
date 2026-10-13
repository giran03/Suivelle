import { useState } from "react";
import { copyText } from "./editingMenu";

/** Copies a diagnostic report to paste into a bug report. Outside the desktop app it reports the error only. */
export function DiagnosticsButton({ error }: { error?: Error | null }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      let report = "";
      if ("__TAURI_INTERNALS__" in window) report = await (await import("../lib/ipc")).ipc.diagnosticsReport();
      if (error) report = `Error: ${error.message}\n${error.stack ?? ""}\n\n${report}`;
      await copyText(report);
      setState("copied");
    } catch { setState("failed"); }
  };
  return <button type="button" className="btn" onClick={() => void copy()}>
    {state === "copied" ? "Report copied" : state === "failed" ? "Could not copy the report" : "Copy diagnostic report"}
  </button>;
}
