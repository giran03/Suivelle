// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DateField } from "./DateField";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(value: string, type: "date" | "datetime-local" = "date") {
  const change = vi.fn(), host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<DateField label="Start" value={value} type={type} onChange={change} required />));
  const picker = host.querySelector<HTMLElement>(".date-picker")!;
  picker.hidePopover = vi.fn();
  return { host, change, picker };
}
it("selects an ISO date and preserves the time for datetime fields", async () => {
  const { host, change, picker } = await mount("2026-10-06T14:30", "datetime-local");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-date="2026-10-08"]')!.click());
  expect(change).toHaveBeenCalledWith("2026-10-08T14:30");
  expect(picker.hidePopover).toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>("input")!.required).toBe(true);
});
it("supports keyboard navigation across month and year boundaries", async () => {
  const { host, change } = await mount("2026-12-31");
  const grid = host.querySelector('[role="grid"]')!;
  const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  await act(async () => grid.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(host.querySelector('[role="grid"]')!.getAttribute("aria-label")).toBe("January 2027");
  expect(host.querySelector('[data-date="2027-01-01"]')!.getAttribute("tabindex")).toBe("0");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-date="2027-01-01"]')!.click());
  expect(change).toHaveBeenCalledWith("2027-01-01");
});
it("keeps one tab stop in the grid and supports clearing the date", async () => {
  const { host, change } = await mount("2026-10-06");
  expect(host.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  expect(host.querySelector('[aria-selected="true"]')!.getAttribute("data-date")).toBe("2026-10-06");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(e => e.textContent === "Clear")!.click());
  expect(change).toHaveBeenCalledWith("");
});
