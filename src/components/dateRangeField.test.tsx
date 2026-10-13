// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DateRangeField } from "./DateRangeField";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
async function mount(start = "2026-10-13", end = "2026-10-23", allDay = true) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const change = vi.fn();
  await act(async () => root.render(<DateRangeField start={start} end={end} allDay={allDay} onChange={change} />));
  const popup = host.querySelector<HTMLDivElement>('[popover]')!;
  popup.hidePopover = vi.fn();
  return { change, popup };
}
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
async function click(label: string) {
  const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label || b.ariaLabel === label)!;
  expect(b).toBeDefined(); await act(async () => b.click());
}
async function day(date: string) { await act(async () => host.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!.click()); }
it("selects rounded endpoints with the intervening dates and commits only on Apply", async () => {
  const { change, popup } = await mount();
  await day("2026-10-15"); await day("2026-10-19");
  expect(change).not.toHaveBeenCalled();
  expect(host.querySelectorAll('.date-range-cell[data-range]')).toHaveLength(5);
  expect(host.querySelectorAll('[data-endpoint]')).toHaveLength(2);
  await click("Apply range");
  expect(change).toHaveBeenCalledWith({ start: "2026-10-15", end: "2026-10-19" });
  expect(popup.hidePopover).toHaveBeenCalledOnce();
});
it("orders a backwards selection and supports one-day all-day ranges", async () => {
  const { change } = await mount();
  await day("2026-10-19"); await day("2026-10-15"); await click("Apply range");
  expect(change).toHaveBeenLastCalledWith({ start: "2026-10-15", end: "2026-10-19" });
  await day("2026-10-15"); await day("2026-10-15"); await click("Apply range");
  expect(change).toHaveBeenLastCalledWith({ start: "2026-10-15", end: "2026-10-15" });
});
it("preserves both times while selecting different dates", async () => {
  const { change } = await mount("2026-10-13T09:00", "2026-10-23T10:30", false);
  await day("2026-10-15"); await day("2026-10-19"); await click("Apply range");
  expect(change).toHaveBeenCalledWith({ start: "2026-10-15T09:00", end: "2026-10-19T10:30" });
  expect(host.querySelectorAll('input[type="time"]')).toHaveLength(2);
});
it("cancels without changing the event", async () => {
  const { change, popup } = await mount();
  await day("2026-10-15"); await click("Cancel");
  expect(change).not.toHaveBeenCalled(); expect(popup.hidePopover).toHaveBeenCalledOnce();
});
it("navigates across months by keyboard and through month/year selection", async () => {
  await mount("2026-12-31", "2027-01-02");
  await act(async () => host.querySelector('[role="grid"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(host.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe("January 2027");
  expect(host.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  await click("Choose year"); await click("2028"); await click("Mar");
  expect(host.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe("March 2028");
});
it("blocks invalid timed ranges and spans longer than one year", async () => {
  await mount("2026-10-13T10:30", "2026-10-13T09:00", false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("end must follow");
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Apply range")!.disabled).toBe(true);
  await act(async () => root.render(<DateRangeField start="2026-10-13" end="2027-10-23" allDay onChange={vi.fn()} />));
  await act(async () => host.querySelector<HTMLButtonElement>('.date-range-trigger')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("at most 366");
});
