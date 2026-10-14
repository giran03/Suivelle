import React from "react";
import ReactDOM from "react-dom/client";
import { loadSafeMode } from "./lib/safeMode";
import "./motion.css";
import "./styles.css";
import "./features/tooltip/tooltip.css";
import "./forced-colors.css";
import "./page-focus.css";

// Safe mode decides READ_ONLY, which modules read once as they load, so ask before importing them.
globalThis.__SUIVELLE_SAFE_MODE__ ??= await loadSafeMode();
const [{ App }, { ErrorBoundary }] = await Promise.all([
  import("./app/App"),
  import("./app/ErrorBoundary"),
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="Suivelle hit an unexpected error.">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
