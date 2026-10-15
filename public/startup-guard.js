// Runs without the app bundle: an import failure must still leave a usable window.
(() => {
  const splash = document.getElementById("startup");
  const status = document.getElementById("startup-status");
  const retry = document.getElementById("startup-retry");
  if (!splash || !status || !retry) return;
  let finished = false;
  const slow = setTimeout(() => {
    status.textContent = "Still preparing your workspace…";
    retry.hidden = false;
  }, 15000);
  const fail = () => {
    if (finished) return;
    clearTimeout(slow);
    clearTimeout(stalled);
    status.textContent = "Suivelle could not finish opening. Restart the app or try again.";
    retry.hidden = false;
  };
  const stalled = setTimeout(fail, 65000);
  const resourceError = (event) => {
    if (event.target instanceof HTMLScriptElement || event instanceof ErrorEvent) fail();
  };
  window.addEventListener("error", resourceError, true);
  window.addEventListener("unhandledrejection", fail);
  window.addEventListener("suivelle-startup-failed", fail);
  window.addEventListener("suivelle-startup-ready", () => {
    finished = true;
    clearTimeout(slow);
    clearTimeout(stalled);
    window.removeEventListener("error", resourceError, true);
    window.removeEventListener("unhandledrejection", fail);
    window.removeEventListener("suivelle-startup-failed", fail);
    splash.remove();
  }, { once: true });
  retry.addEventListener("click", () => window.location.reload());
})();
