// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useAgents } from "../agents/store";
import type { AgentsOverview } from "../agents/types";
import { Sidebar } from "./Sidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  useAgents.setState(useAgents.getInitialState(), true);
  vi.restoreAllMocks();
});

it("keeps an empty inbox enabled for active agents and updates after disconnection", async () => {
  const overview = vi.spyOn(ipc, "agentsOverview");
  const refresh = async (statuses: string[], pending = 0) => {
    overview.mockResolvedValue({ pending, agents: statuses.map((status) => ({ status })) } as AgentsOverview);
    await act(async () => useAgents.getState().refresh());
  };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Sidebar />));
  const inbox = () => host.querySelector<HTMLButtonElement>(".agents-launch");
  expect(inbox()).toBeNull();

  await refresh(["active"]);
  expect(inbox()?.disabled).toBe(false);
  expect(inbox()?.previousElementSibling?.getAttribute("aria-label")).toBe("Node Map");
  expect(inbox()?.textContent).toBe("Inbox");
  expect(inbox()?.querySelector(".agx-badge")).toBeNull();
  await act(async () => inbox()!.click());
  expect(useAgents.getState()).toMatchObject({ open: true, tab: "review" });

  await refresh(["active", "active"], 2);
  expect(inbox()?.querySelector(".agx-badge")?.textContent).toBe("2");
  await refresh(["paused"]);
  expect(inbox()).toBeNull();
  await refresh([], 1);
  expect(inbox()).not.toBeNull();
  await refresh([]);
  expect(inbox()).toBeNull();
});
