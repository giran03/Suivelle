// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { WorkspaceList } from "./WorkspaceList";
import { useWorkspace } from "../../stores/workspace";
import type { Workspace } from "../../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("moves with the handle's arrow keys while keeping selection controls separate", async () => {
  localStorage.clear();
  const original = useWorkspace.getState();
  const workspaces = [{ id: "a", name: "Personal" }, { id: "b", name: "Studio" }] as Workspace[];
  useWorkspace.setState({ workspaces, workspaceBusy: false });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function List() {
    const list = useWorkspace((s) => s.workspaces);
    return <WorkspaceList workspaces={list} disabled={false}>{(w) => <button>{w.name}</button>}</WorkspaceList>;
  }
  try {
    await act(async () => root.render(<List />));
    const handle = host.querySelector<HTMLButtonElement>('[aria-label^="Reorder Studio"]')!;
    expect(handle).toBeTruthy();
    handle.focus();
    await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(useWorkspace.getState().workspaces.map((w) => w.id)).toEqual(["b", "a"]);
    expect(document.activeElement).toBe(handle);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Studio moved to position 1 of 2");
    expect(handle.parentElement?.querySelectorAll("button")).toHaveLength(2);
  } finally {
    await act(async () => root.unmount()); host.remove();
    useWorkspace.setState(original, true); localStorage.clear();
  }
});
