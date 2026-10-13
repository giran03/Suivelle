// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { currentCalendarDay, useCalendarDay } from "./useCalendarDay";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let clock: ReturnType<typeof useCalendarDay>;
async function mount(timezone = "Asia/Manila") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Clock() {
    clock = useCalendarDay(timezone);
    return null;
  }
  await act(async () => root.render(<Clock />));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});
it("advances today and the selected day at midnight in the calendar timezone", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T15:59:59Z"));
  await mount();
  expect(clock.day).toBe("2026-10-13");
  await act(async () => vi.advanceTimersByTime(1100));
  expect(clock).toMatchObject({ today: "2026-10-14", day: "2026-10-14" });
});
it("keeps a deliberately selected day when today advances", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T15:59:59Z"));
  await mount();
  await act(async () => clock.setDay("2026-10-20"));
  await act(async () => vi.advanceTimersByTime(1100));
  expect(clock).toMatchObject({ today: "2026-10-14", day: "2026-10-20" });
});
it("refreshes immediately on focus and visibility after sleep, without waiting for a timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T15:00:00Z"));
  await mount();
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(clock.day).toBe("2026-10-14");
  vi.setSystemTime(new Date("2026-10-15T04:00:00Z"));
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(clock.day).toBe("2026-10-15");
});
it("reads the actual current day in the chosen timezone, even if the machine is on a different date", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T16:01:00Z"));
  expect(currentCalendarDay("Asia/Manila")).toBe("2026-10-14");
  expect(currentCalendarDay("America/New_York")).toBe("2026-10-13");
});
