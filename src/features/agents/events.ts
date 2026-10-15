import { listen } from "@tauri-apps/api/event";
import { useWorkspace } from "../../stores/workspace";
import { useSaveStatus } from "../../stores/saveStatus";
import { useAgents } from "./store";
import type { AgentActivity } from "./types";

/** Reacts to changes agents (and the mirror folder) make while the app is open: refreshes the
 * page tree, open databases and the node map, reloads the open page when it changed and has no
 * unsaved edits, and points to the Review inbox when something waits for review. */
export function handleAgentActivity(payload: AgentActivity): void {
  const s = useWorkspace.getState();
  void useAgents.getState().refresh();
  window.dispatchEvent(new Event("suivelle:graph-changed"));
  const pages = payload.pageIds ?? [];
  if (pages.length) {
    void s.reloadTree();
    void s.refreshTitles();
    s.bumpData();
    const open = s.selectedPageId;
    if (open && pages.includes(open)) {
      if (useSaveStatus.getState().status === "saving") {
        s.notify(`${payload.agentName ?? "An agent"} changed this page while you were editing.`, () => { void s.selectPage(open, { fromHistory: true }).then(() => useWorkspace.getState().bumpEditor()); }, "Reload");
      } else {
        void s.selectPage(open, { fromHistory: true }).then(() => useWorkspace.getState().bumpEditor());
      }
    }
  }
  if (payload.proposalStatus === "pending") {
    s.notify(`${payload.agentName ?? "An agent"} proposed changes`, () => useAgents.getState().show("review"), "Review");
  }
}

export function installAgentEvents(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
  let stop: (() => void) | undefined;
  let cancelled = false;
  void useAgents.getState().refresh();
  void listen<AgentActivity>("agent-activity", ({ payload }) => handleAgentActivity(payload))
    .then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; });
  return () => { cancelled = true; stop?.(); };
}
