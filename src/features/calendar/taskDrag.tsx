import { useEffect } from "react";
import { Icon } from "../../components/Icon";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
import type { RecordRow } from "../../types";
import { useCalendarComposer } from "./store";

export interface CalendarTask {
  pageId: string;
  title: string;
  workspaceId: string;
  recordId?: string;
  propertyId?: string;
}

export function readCalendarTask(el: HTMLElement): CalendarTask | null {
  try {
    const v = JSON.parse(el.dataset.calendarTask ?? "null");
    return v && typeof v.pageId === "string" && typeof v.title === "string" && typeof v.workspaceId === "string"
      && (v.recordId === undefined || typeof v.recordId === "string")
      && (v.propertyId === undefined || typeof v.propertyId === "string") ? v : null;
  } catch { return null; }
}

let users = 0;
let draggable: { destroy: () => void } | undefined;
/** One delegated drag listener serves drawer items and virtualized board/table handles. */
export function useCalendarTaskDrag() {
  useEffect(() => {
    if (READ_ONLY) return;
    users++;
    void import("@fullcalendar/react/interaction").then(({ Draggable }) => {
      if (users && !draggable) draggable = new Draggable(document.body, {
        itemSelector: "[data-calendar-task]",
        minDistance: 6,
        eventData: (el) => ({ title: readCalendarTask(el)?.title || "Untitled", duration: "01:00", create: false }),
      });
    });
    return () => { if (--users === 0) { draggable?.destroy(); draggable = undefined; } };
  }, []);
}

export function TaskScheduleHandle({ row }: { row: RecordRow }) {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  if (READ_ONLY || !workspaceId) return null;
  const task: CalendarTask = { pageId: row.pageId, title: row.title, workspaceId };
  return <button type="button" className="icon-btn task-schedule-handle"
    data-calendar-task={JSON.stringify(task)}
    aria-label={`Plan a work session for ${row.title || "Untitled"}`}
    title="Drag to a calendar time slot, or click to plan a work session"
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => { e.stopPropagation(); useCalendarComposer.getState().show({ link: { pageId: row.pageId, label: row.title, blockId: null }, allDay: false }); }}>
    <Icon name="calendar" size={14} />
  </button>;
}
