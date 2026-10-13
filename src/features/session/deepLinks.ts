import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { pageLinkTarget } from "../../lib/legacy";
import { useWorkspace } from "../../stores/workspace";

const open = (url: string) => {
  const id = pageLinkTarget(url);
  if (id) void useWorkspace.getState().openPage(id);
};

/** Opens suivelle://page/… links clicked in other programs, including the one that launched the app. */
export function installDeepLinks(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
  let stop: (() => void) | undefined;
  let cancelled = false;
  void listen<string>("open-link", ({ payload }) => open(payload)).then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; });
  // A launch link waits until the workspace has loaded, so the page exists to open.
  const takePending = () => void invoke<string[]>("deep_link_take").then((urls) => urls.forEach(open), () => undefined);
  const unsubscribe = useWorkspace.subscribe((s, prev) => { if (s.ready && !prev.ready) takePending(); });
  if (useWorkspace.getState().ready) takePending();
  return () => { cancelled = true; stop?.(); unsubscribe(); };
}
