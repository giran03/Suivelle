import { DateTime } from "luxon";
import { ipc } from "../../lib/ipc";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
import { addDays } from "../database/calendar";
import { newSchedule, wallTime, type CalendarSource } from "./model";
import { calendarChanged } from "./store";
import type { CalendarTask } from "./taskDrag";

export function timeBlockValue(start: string, zone: string, allDay: boolean, minutes: number) {
  const date = DateTime.fromISO(start, { zone }).setZone(zone);
  if (!date.isValid || !Number.isFinite(minutes) || minutes < 15 || minutes > 480) throw new Error("Choose a valid time slot and duration.");
  return {
    start: wallTime(start, zone, allDay),
    end: allDay ? addDays(start.slice(0, 10), 1) : date.plus({ minutes }).toFormat("yyyy-MM-dd'T'HH:mm"),
  };
}

/** Drawer records get a date; board/table sessions link to the task without moving its deadline. */
export async function scheduleTask(task: CalendarTask, start: string, allDay: boolean, zone: string, minutes: number, sources: CalendarSource[]) {
  const owner = useWorkspace.getState().workspace?.id;
  if (READ_ONLY || !owner || owner !== task.workspaceId) throw new Error("This task belongs to another workspace.");
  const page = await ipc.pageGet(task.pageId);
  if (!page || page.deletedAt || page.workspaceId !== owner) throw new Error("This task is no longer available.");
  if (task.propertyId && task.recordId) {
    const detail = await ipc.recordGet(task.pageId);
    const source = sources.find((s) => s.kind === "database" && s.pageId === detail.database.page.id && s.propertyId === task.propertyId);
    if (!source || source.writable === false || detail.record.id !== task.recordId
      || !detail.database.properties.some((p) => p.id === task.propertyId && p.type === "date")) throw new Error("The task's date source is no longer writable.");
    const value = timeBlockValue(start, source.timezone ?? zone, allDay, minutes);
    // All-day database ranges use inclusive ends, unlike calendar events.
    const old = detail.record.values[task.propertyId];
    if (old && typeof old === "object" && "start" in old && old.start) throw new Error("This task was already scheduled. Refresh the calendar to move it.");
    await ipc.recordSetValue(task.recordId, task.propertyId, allDay ? { start: value.start } : value);
    useWorkspace.getState().notify(`Scheduled “${task.title || "Untitled"}”`, async () => {
      await ipc.recordSetValue(task.recordId!, task.propertyId!, old ?? null);
      useWorkspace.getState().bumpData();
      calendarChanged();
    });
  } else {
    const value = timeBlockValue(start, zone, allDay, minutes);
    const calendarId = sources.find((s) => s.kind === "calendar")?.pageId;
    if (!calendarId) throw new Error("Connect a calendar in Sources to plan linked work sessions.");
    const data = { ...newSchedule(calendarId), ...value, timezone: zone, allDay,
      links: [{ pageId: task.pageId, blockId: null, label: task.title }], followSourceTitle: true };
    const saved = await ipc.calendarSave({ workspaceId: owner, title: task.title || "Untitled", data });
    useWorkspace.getState().notify(`Planned “${task.title || "Untitled"}”`, async () => { await ipc.pageDelete(saved.pageId); calendarChanged(); });
  }
  useWorkspace.getState().bumpData();
  calendarChanged();
}
