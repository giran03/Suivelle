// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pageGet: vi.fn(), recordGet: vi.fn(), recordSetValue: vi.fn(), calendarSave: vi.fn(), pageDelete: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ ipc: mocks }));
import { useWorkspace } from "../../stores/workspace";
import type { Workspace } from "../../types";
import type { CalendarSource } from "./model";
import { readCalendarTask } from "./taskDrag";
import { scheduleTask, timeBlockValue } from "./timeBlocking";

const task = { pageId: "task", title: "Build prototype", workspaceId: "w", recordId: "r", propertyId: "date" };
const sources: CalendarSource[] = [{ kind: "database", pageId: "db", propertyId: "date" }, { kind: "calendar", pageId: "cal" }];
let undo: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); undo = undefined;
  useWorkspace.setState({ workspace: { id: "w" } as Workspace, notify: (_text, action) => { undo = action as () => Promise<void>; } });
  mocks.pageGet.mockResolvedValue({ id: "task", workspaceId: "w", deletedAt: null });
  mocks.recordGet.mockResolvedValue({ record: { id: "r", values: {} }, database: { page: { id: "db" }, properties: [{ id: "date", type: "date" }] } });
  mocks.calendarSave.mockResolvedValue({ pageId: "session" });
});

describe("time blocking", () => {
  it("converts the slot into source wall time and crosses midnight", () => {
    expect(timeBlockValue("2026-10-14T15:30:00Z", "Asia/Manila", false, 90)).toEqual({ start: "2026-10-14T23:30", end: "2026-10-15T01:00" });
    expect(() => timeBlockValue("invalid", "UTC", false, 60)).toThrow();
    expect(() => timeBlockValue("2026-10-14", "UTC", false, -1)).toThrow();
  });
  it("writes drawer tasks back to the source and can undo", async () => {
    await scheduleTask(task, "2026-10-14T09:00:00+08:00", false, "Asia/Manila", 45, sources);
    expect(mocks.recordSetValue).toHaveBeenCalledWith("r", "date", { start: "2026-10-14T09:00", end: "2026-10-14T09:45" });
    expect(mocks.calendarSave).not.toHaveBeenCalled();
    await undo!();
    expect(mocks.recordSetValue).toHaveBeenLastCalledWith("r", "date", null);
  });
  it("uses the date property's timezone rather than the display timezone", async () => {
    await scheduleTask(task, "2026-10-14T09:00:00+08:00", false, "Asia/Manila", 60,
      [{ ...sources[0], timezone: "America/New_York" }]);
    expect(mocks.recordSetValue).toHaveBeenCalledWith("r", "date", { start: "2026-10-13T21:00", end: "2026-10-13T22:00" });
  });
  it("creates a linked session from a board/table without changing its deadline", async () => {
    await scheduleTask({ pageId: "task", title: task.title, workspaceId: "w" }, "2026-10-14T09:00:00+08:00", false, "Asia/Manila", 60, sources);
    expect(mocks.recordSetValue).not.toHaveBeenCalled();
    expect(mocks.calendarSave).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w", data: expect.objectContaining({ calendarId: "cal", timezone: "Asia/Manila", start: "2026-10-14T09:00", end: "2026-10-14T10:00", allDay: false, links: [{ pageId: "task", label: task.title, blockId: null }] }) }));
    await undo!(); expect(mocks.pageDelete).toHaveBeenCalledWith("session");
  });
  it("refuses stale, read-only and cross-workspace tasks", async () => {
    await expect(scheduleTask({ ...task, workspaceId: "other" }, "2026-10-14", true, "UTC", 60, sources)).rejects.toThrow("another workspace");
    await expect(scheduleTask(task, "2026-10-14", true, "UTC", 60, [{ ...sources[0], writable: false }])).rejects.toThrow("writable");
    mocks.recordGet.mockResolvedValue({ record: { id: "r", values: { date: { start: "2026-10-14" } } }, database: { page: { id: "db" }, properties: [{ id: "date", type: "date" }] } });
    await expect(scheduleTask(task, "2026-10-14", true, "UTC", 60, sources)).rejects.toThrow("already scheduled");
    expect(mocks.recordSetValue).not.toHaveBeenCalled();
  });
  it("keeps all-day database dates inclusive", async () => {
    await scheduleTask(task, "2026-10-14", true, "UTC", 60, sources);
    expect(mocks.recordSetValue).toHaveBeenCalledWith("r", "date", { start: "2026-10-14" });
  });
  it("rejects malformed drag metadata", () => {
    const el = document.createElement("button");
    el.dataset.calendarTask = "{"; expect(readCalendarTask(el)).toBeNull();
    el.dataset.calendarTask = JSON.stringify({ ...task, propertyId: 7 }); expect(readCalendarTask(el)).toBeNull();
    el.dataset.calendarTask = JSON.stringify(task); expect(readCalendarTask(el)).toEqual(task);
  });
});
