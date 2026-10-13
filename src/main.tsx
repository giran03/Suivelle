import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { CaptureWindow } from "./features/capture/CaptureWindow";
import "./motion.css";
import "./styles.css";
import "./features/tooltip/tooltip.css";
import "./forced-colors.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="Suivelle hit an unexpected error.">
      {new URLSearchParams(window.location.search).has("quick-capture") ? <CaptureWindow /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
