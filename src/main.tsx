import React from "react";
import ReactDOM from "react-dom/client";
import { loadSafeMode } from "./lib/safeMode";
import "./motion.css";
import "./styles.css";
import "./features/tooltip/tooltip.css";
import "./forced-colors.css";
import "./page-focus.css";

function StartupReady({ children }: { children: React.ReactNode }) {
  React.useLayoutEffect(() => { window.dispatchEvent(new Event("suivelle-startup-ready")); }, []);
  return children;
}

try {
  // Modules capture READ_ONLY at import time. Never proceed if the safety check failed.
  globalThis.__SUIVELLE_SAFE_MODE__ ??= await loadSafeMode();
  const [{ App }, { ErrorBoundary }] = await Promise.all([
    import("./app/App"),
    import("./app/ErrorBoundary"),
  ]);

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <StartupReady>
        <ErrorBoundary label="Suivelle hit an unexpected error."><App /></ErrorBoundary>
      </StartupReady>
    </React.StrictMode>,
  );
} catch (error) {
  console.error("Suivelle startup failed", error);
  window.dispatchEvent(new Event("suivelle-startup-failed"));
}
