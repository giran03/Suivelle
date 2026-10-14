// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ShortcutSettings } from "./ShortcutSettings";
import { useShortcuts } from "./store";
import { key } from "./bindings";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); useShortcuts.setState({ overrides: {}, recording: false }); document.body.replaceChildren(); vi.restoreAllMocks(); });
it("renders individual keycaps without inline close controls and retains removal in the editor", async () => {
  useShortcuts.setState({ overrides: { search: [key("k", "Control"), key("j", "Control")] } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ShortcutSettings />));
  const binding = host.querySelector<HTMLButtonElement>('[aria-label="Change Ctrl+K for Search pages and commands"]')!;
  expect([...binding.querySelectorAll("kbd")].map(el => el.textContent)).toEqual(["Ctrl", "K"]);
  expect(host.querySelector(".shortcut-remove")).toBeNull();
  expect(binding.textContent).not.toContain("×");
  await act(async () => binding.click());
  const remove = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === "Remove binding")!;
  expect(remove).toBeDefined();
  await act(async () => remove.click());
  expect(useShortcuts.getState().overrides.search).toEqual([key("j", "Control")]);
});
