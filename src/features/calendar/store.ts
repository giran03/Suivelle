import { create } from "zustand";
import type { CalendarEvent, CalendarLink, CalendarOccurrence, CalendarSchedule } from "./model";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
export interface CalendarRequest {
  id: string;
  workspaceId: string;
  event?: CalendarEvent;
  occurrence?: CalendarOccurrence;
  link?: CalendarLink;
  calendarId?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  /** A new event that starts from a copy of another. */
  draft?: { title: string; data: CalendarSchedule };
}
export const calendarChanged = () =>
  window.dispatchEvent(new Event("calendar-changed"));
export const useCalendarComposer = create<{
  request: CalendarRequest | null;
  show: (request: Omit<CalendarRequest, "id" | "workspaceId">) => void;
  hide: () => void;
}>((set) => ({
  request: null,
  show: (request) => {
    const workspaceId = useWorkspace.getState().workspace?.id;
    if (!READ_ONLY && workspaceId)
      set({ request: { ...request, workspaceId, id: crypto.randomUUID() } });
  },
  hide: () => set({ request: null }),
}));
