// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  availableTimezones,
  systemTimezone,
  TimezoneField,
} from "./TimezoneField";
import { calendarConfig, newSchedule } from "../features/calendar/model";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function mount(disabled = false) {
  const host = document.createElement("div"),
    change = vi.fn();
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <TimezoneField
        value="Asia/Manila"
        onChange={change}
        disabled={disabled}
      />,
    ),
  );
  const popup = host.querySelector<HTMLElement>(".timezone-picker")!;
  popup.hidePopover = vi.fn();
  return { host, change, popup };
}
it("includes the complete runtime list, UTC, and persisted timezone aliases without duplicates", () => {
  const intl = Intl as typeof Intl & {
    supportedValuesOf: (key: string) => string[];
  };
  const zones = availableTimezones("US/Eastern", "Asia/Manila");
  expect(zones).toEqual(
    expect.arrayContaining([
      ...intl.supportedValuesOf("timeZone"),
      "UTC",
      "US/Eastern",
      "Asia/Manila",
    ]),
  );
  expect(new Set(zones).size).toBe(zones.length);
  expect(calendarConfig({}).timezone).toBe(systemTimezone());
  expect(newSchedule("calendar").timezone).toBe(systemTimezone());
});
it("searches city names with spaces and selects with the keyboard without submitting a form", async () => {
  const { host, change, popup } = await mount();
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "new york");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(change).toHaveBeenCalledWith("America/New_York");
  expect(popup.hidePopover).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(host.querySelector("button"));
});
it("keeps disabled fields locked", async () => {
  const { host, change } = await mount(true);
  expect(
    host.querySelector<HTMLButtonElement>(".timezone-field-trigger")!.disabled,
  ).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".timezone-field-trigger")!.click(),
  );
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".timezone-system")!.click(),
  );
  expect(change).not.toHaveBeenCalled();
});
it("offers a shortcut back to the system timezone", async () => {
  const { host, change } = await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".timezone-system")!.click(),
  );
  expect(change).toHaveBeenCalledWith(systemTimezone());
});
