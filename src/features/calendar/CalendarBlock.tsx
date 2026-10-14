import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import FullCalendar, {
  type CalendarRef,
  type EventInput,
  type EventDropInfo,
  type EventResizeDoneInfo,
  type DropInfo,
} from "@fullcalendar/react";
import themePlugin from "@fullcalendar/react/themes/monarch";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import listPlugin from "@fullcalendar/react/list";
import multiMonthPlugin from "@fullcalendar/react/multimonth";
import interactionPlugin from "@fullcalendar/react/interaction";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/monarch/theme.css";
import { DateTime } from "luxon";
import { ipc, toAppError } from "../../lib/ipc";
import { READ_ONLY } from "../../lib/access";
import { Icon } from "../../components/Icon";
import { TimezoneField } from "../../components/TimezoneField";
import { syncDialog } from "../../lib/dialog";
import { useWorkspace } from "../../stores/workspace";
import { openDailyNote } from "../journal/journal";
import { addDays } from "../database/calendar";
import type { DatabaseDetail, DatabaseRef, Page, RecordRow } from "../../types";
import { calendarChanged, useCalendarComposer } from "./store";
import {
  CALENDAR_VIEWS,
  calendarConfig,
  daySummary,
  eventColor,
  overlaps,
  patchOccurrence,
  readableText,
  sourceKey,
  wallTime,
  type CalendarConfig,
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarSource,
  type CalendarView,
} from "./model";
import { exportCalendar, importCalendar } from "./transfer";
import { currentCalendarDay, useCalendarDay } from "./useCalendarDay";
import { unwatchLabel, watchLabel } from "./fitLabel";
import { readCalendarTask, useCalendarTaskDrag } from "./taskDrag";
import { scheduleTask } from "./timeBlocking";
import "./calendar.css";

const PLUGINS = [
  themePlugin,
  dayGridPlugin,
  timeGridPlugin,
  listPlugin,
  multiMonthPlugin,
  interactionPlugin,
];
type Snapshot = Awaited<ReturnType<typeof ipc.calendarSnapshot>>;
interface DisplayItem {
  input: EventInput;
  native?: CalendarEvent;
  occurrence?: CalendarOccurrence;
  row?: RecordRow;
  source: CalendarSource;
  value?: unknown;
}
const COLORS = ["#355aa4", "#387357", "#805834", "#785099", "#a34250"];

const eventOf = (target: EventTarget | null) =>
  target instanceof Element
    ? target.closest<HTMLElement>("[data-cal-event]")
    : null;
const sameEvent = (a: EventTarget | null, b: EventTarget | null) => {
  const id = eventOf(a)?.dataset.calEvent;
  return !!id && id === eventOf(b)?.dataset.calEvent;
};
/** A range cut at a week edge is several bars; they light up together. */
function linkEvent(root: HTMLElement, target: EventTarget | null, on: boolean) {
  const id = eventOf(target)?.dataset.calEvent;
  if (!id) return;
  root
    .querySelectorAll<HTMLElement>(`[data-cal-event="${CSS.escape(id)}"]`)
    .forEach((el) => el.toggleAttribute("data-linked", on));
}

function Sources({
  config,
  collections,
  update,
  onError,
}: {
  config: CalendarConfig;
  collections: Page[];
  update: (c: Partial<CalendarConfig>) => void;
  onError: (s: string) => void;
}) {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const [dbs, setDbs] = useState<DatabaseRef[]>([]);
  const [detail, setDetail] = useState<DatabaseDetail | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const detailRequest = useRef(0);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    ipc
      .databaseList(workspaceId)
      .then((r) => alive && setDbs(r))
      .catch((e) => alive && onError(toAppError(e).message));
    return () => {
      alive = false;
    };
  }, [workspaceId, onError]);
  const add = (s: CalendarSource) => {
    if (config.sources.length >= 32) { onError("This calendar supports up to 32 sources. Remove one before adding another."); return; }
    if (!config.sources.some((x) => sourceKey(x) === sourceKey(s)))
      update({
        sources: [
          ...config.sources,
          { ...s, color: COLORS[config.sources.length % COLORS.length] },
        ],
      });
  };
  return (
    <section className="calendar-sources" aria-label="Calendar sources">
      <h3>Master Calendar sources</h3>
      <p className="set-hint">
        Overlay dates from several project tables, each with its own color. Calendar events and database dates share this view. Removing a source
        keeps its data.
      </p>
      <ul>
        {config.sources.map((s, i) => (
          <li key={sourceKey(s)}>
            <span>
              {s.label ||
                collections.find((p) => p.id === s.pageId)?.title ||
                "Connected source"}
            </span>
            <select
              aria-label={`Color for ${s.label || "source"}`}
              disabled={READ_ONLY}
              value={s.color ?? COLORS[i % COLORS.length]}
              onChange={(e) =>
                update({
                  sources: config.sources.map((x, at) =>
                    at === i ? { ...x, color: e.target.value } : x,
                  ),
                })
              }
            >
              {COLORS.map((c, at) => (
                <option key={c} value={c}>
                  {["Blue", "Green", "Amber", "Purple", "Red"][at]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn"
              disabled={READ_ONLY}
              aria-label={`Remove ${s.label || "source"} from this view`}
              onClick={() =>
                update({ sources: config.sources.filter((_, at) => at !== i) })
              }
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!READ_ONLY && (
        <>
          <label>
            Connect a calendar
            <select
              value=""
              onChange={(e) => {
                const p = collections.find((p) => p.id === e.target.value);
                if (p) add({ kind: "calendar", pageId: p.id, label: p.title });
              }}
            >
              <option value="">Choose a calendar…</option>
              {collections.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <div className="calendar-new-source">
            <input
              aria-label="New calendar name"
              placeholder="New calendar name"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || !name.trim()}
              onClick={async () => {
                if (!workspaceId) return;
                setBusy(true);
                try {
                  const p = await ipc.calendarCreate(workspaceId, name.trim());
                  add({ kind: "calendar", pageId: p.id, label: p.title });
                  setName("");
                  calendarChanged();
                  await useWorkspace.getState().reloadTree();
                } catch (e) {
                  onError(toAppError(e).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
            </button>
          </div>
          <label>
            Connect database dates
            <select
              value={detail?.page.id ?? ""}
              onChange={async (e) => {
                const request = ++detailRequest.current;
                setDetail(null);
                if (e.target.value)
                  try {
                    const next = await ipc.databaseGet(e.target.value);
                    if (request === detailRequest.current) setDetail(next);
                  } catch (error) {
                    if (request === detailRequest.current) onError(toAppError(error).message);
                  }
              }}
            >
              <option value="">Choose a database…</option>
              {dbs.map((d) => (
                <option key={d.pageId} value={d.pageId}>
                  {d.title || "Untitled"}
                </option>
              ))}
            </select>
          </label>
          {detail && (
            <fieldset className="calendar-date-sources">
              <legend>Date properties to overlay</legend>
              {detail.properties.filter((p) => p.type === "date").map((p) => {
                const source: CalendarSource = {
                      kind: "database",
                      pageId: detail.page.id,
                      propertyId: p.id,
                      timezone: config.timezone,
                      label: `${detail.page.title} · ${p.name}`,
                      writable: true,
                };
                const connected = config.sources.some((s) => sourceKey(s) === sourceKey(source));
                return <label key={p.id} className="check-row"><input type="checkbox" checked={connected}
                  onChange={() => connected ? update({ sources: config.sources.filter((s) => sourceKey(s) !== sourceKey(source)) }) : add(source)} />{p.name}</label>;
              })}
              {!detail.properties.some((p) => p.type === "date") && <p className="set-hint">Add a date property to this table to overlay its tasks.</p>}
            </fieldset>
          )}
        </>
      )}
      <div className="calendar-two-fields">
        <label>
          Week starts
          <select
            value={config.weekStart}
            disabled={READ_ONLY}
            onChange={(e) => update({ weekStart: Number(e.target.value) })}
          >
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
          </select>
        </label>
        <label>
          Display timezone
          <TimezoneField label="Display timezone" value={config.timezone} disabled={READ_ONLY} onChange={timezone => update({ timezone })} />
        </label>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={config.autoColor}
          disabled={READ_ONLY}
          onChange={(e) => update({ autoColor: e.target.checked })}
        />
        Give multi-day events their own colors
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={config.weekNumbers}
          disabled={READ_ONLY}
          onChange={(e) => update({ weekNumbers: e.target.checked })}
        />
        Show week numbers
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={config.weekends}
          disabled={READ_ONLY}
          onChange={(e) => update({ weekends: e.target.checked })}
        />
        Show weekends
      </label>
      <label>
        Block height
        <input
          type="range"
          min="320"
          max="1000"
          step="20"
          value={config.height}
          disabled={READ_ONLY}
          onChange={(e) => update({ height: Number(e.target.value) })}
        />
        <span className="field-hint">{config.height} px</span>
      </label>
      <div className="calendar-two-fields">
        <label>
          Workday starts
          <input
            type="time"
            value={config.workStart}
            disabled={READ_ONLY}
            onChange={(e) => update({ workStart: e.target.value })}
          />
        </label>
        <label>
          Workday ends
          <input
            type="time"
            value={config.workEnd}
            disabled={READ_ONLY}
            onChange={(e) => update({ workEnd: e.target.value })}
          />
        </label>
      </div>
    </section>
  );
}

export function CalendarBlock({
  raw,
  update,
  expanded = false,
  initialDate,
}: {
  raw: Record<string, unknown>;
  update: (c: Partial<CalendarConfig>) => void;
  expanded?: boolean;
  initialDate?: string;
}) {
  const config = useMemo(() => calendarConfig(raw), [raw]);
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const dataEpoch = useWorkspace((s) => s.dataEpoch);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [range, setRange] = useState(() => ({
    from: DateTime.local().startOf("month").minus({ days: 7 }).toISODate()!,
    to: DateTime.local().endOf("month").plus({ days: 7 }).toISODate()!,
  }));
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [undated, setUndated] = useState<DisplayItem[]>([]);
  const [error, setError] = useState("");
  const [transferMessage, setTransferMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLimit, setDrawerLimit] = useState(100);
  useEffect(() => setDrawerLimit(100), [query, hidden]);
  const [blockMinutes, setBlockMinutes] = useState(60);
  const [scheduling, setScheduling] = useState(false);
  const schedulingRef = useRef(false);
  useCalendarTaskDrag();
  const timedView = config.view === "timeGridDay" || config.view === "timeGridWeek";
  const { today, day, setDay } = useCalendarDay(config.timezone);
  const calendarNow = useMemo(() => () => new Date(), [today, config.timezone]);
  const [dayCells, setDayCells] = useState<Map<HTMLElement, string>>(() => new Map());
  const mountDayCell = useCallback(({ el }: { el: HTMLElement }) => {
    const date = el.getAttribute("data-date");
    if (date) setDayCells((cells) => new Map(cells).set(el, date));
  }, []);
  const unmountDayCell = useCallback(({ el }: { el: HTMLElement }) => {
    setDayCells((cells) => { const next = new Map(cells); next.delete(el); return next; });
  }, []);
  const [narrow, setNarrow] = useState(false);
  const displayView = narrow && !timedView ? "listWeek" : config.view;
  const [limit, setLimit] = useState(1000);
  const [truncated, setTruncated] = useState(false);
  const [full, setFull] = useState(false);
  const [databaseEdit, setDatabaseEdit] = useState<DisplayItem | null>(null);
  const [dateDraft, setDateDraft] = useState("");
  const [dateBusy, setDateBusy] = useState(false);
  const ref = useRef<CalendarRef>(null);
  const previousToday = useRef(today);
  useEffect(() => {
    const previous = previousToday.current;
    previousToday.current = today;
    if (previous !== today && day === today && previous >= range.from && previous < range.to && (today < range.from || today >= range.to)) {
      ref.current?.getApi().gotoDate(today);
    }
  }, [today, day, range.from, range.to]);
  const root = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener("calendar-changed", reload);
    return () => window.removeEventListener("calendar-changed", reload);
  }, [reload]);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([e]) =>
      setNarrow(e.contentRect.width < 640),
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (fullRef.current) syncDialog(fullRef.current, full);
  }, [full]);
  useEffect(() => {
    ref.current?.getApi().changeView(displayView);
  }, [displayView]);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setLoading(true);
    setError("");
    const load = async () => {
      const snap = await ipc.calendarSnapshot(
        workspaceId,
        range.from,
        range.to,
        config.sources
          .filter((s) => s.kind === "calendar")
          .map((s) => s.pageId),
      );
      if (!alive) return;
      setSnapshot(snap);
      const next: DisplayItem[] = [];
      const noDate: DisplayItem[] = [];
      let partial = snap.truncated;
      const failures: string[] = [];
      for (const s of config.sources.filter((s) => s.kind === "calendar")) {
        const events = new Map(
          snap.events
            .filter((e) => e.data.calendarId === s.pageId)
            .map((e) => [e.pageId, e]),
        );
        for (const o of snap.occurrences) {
          const event = events.get(o.pageId);
          const color = event
            ? eventColor(
                { ...event.data, start: o.start, end: o.end, allDay: o.allDay },
                event.pageId,
                s.color,
                config.autoColor,
              )
            : undefined;
          if (event)
            next.push({
              source: s,
              native: event,
              occurrence: o,
              input: {
                id: `native:${o.id}`,
                title: event.title,
                start: o.start,
                end: o.end,
                allDay: o.allDay,
                color,
                textColor: color ? readableText(color) : "#ffffff",
                editable: !READ_ONLY,
                classNames: event.data.completed ? ["calendar-completed"] : [],
              },
            });
        }
        if (!snap.collections.some((p) => p.id === s.pageId))
          failures.push(`${s.label || "Calendar"} is missing or in the trash.`);
      }
      const results = await Promise.allSettled(
        config.sources
          .filter((s) => s.kind === "database")
          .map(async (s) => {
            const detail = await ipc.databaseGet(s.pageId);
            if (detail.page.workspaceId !== workspaceId)
              throw new Error("Source belongs to another workspace.");
            if (
              !detail.properties.some(
                (p) => p.id === s.propertyId && p.type === "date",
              )
            )
              throw new Error("The date property no longer exists.");
            const loadRows = async (unset: boolean) => {
              const rows: RecordRow[] = [];
              let cursor: string | null = null;
              do {
                const page = await ipc.queryRecords({
                  databaseId: detail.database.id,
                  viewId: s.viewId ?? null,
                  range: unset
                    ? { propertyId: s.propertyId! }
                    : {
                        propertyId: s.propertyId!,
                        from: range.from,
                        to: range.to,
                      },
                  cursor,
                  limit: 200,
                  skipTotal: true,
                });
                rows.push(...page.rows);
                cursor = page.nextCursor;
                if (rows.length >= limit && cursor) {
                  partial = true;
                  break;
                }
              } while (cursor);
              return rows.slice(0, limit);
            };
            const [rows, unscheduled] = await Promise.all([
              loadRows(false),
              loadRows(true),
            ]);
            for (const row of rows) {
              const value = row.values[s.propertyId!] as {
                start?: string;
                end?: string;
              } | null;
              if (!value?.start) continue;
              const allDay = value.start.length === 10;
              const zone = s.timezone ?? config.timezone;
              const start = allDay
                ? value.start
                : DateTime.fromISO(value.start, { zone }).toISO();
              const end = value.end
                ? allDay
                  ? addDays(value.end.slice(0, 10), 1)
                  : DateTime.fromISO(value.end, { zone }).toISO()
                : allDay
                  ? addDays(value.start, 1)
                  : DateTime.fromISO(value.start, { zone })
                      .plus({ hours: 1 })
                      .toISO();
              if (start && end)
                next.push({
                  source: s,
                  row,
                  value,
                  input: {
                    id: `db:${row.id}:${s.propertyId}`,
                    title: row.title,
                    start,
                    end,
                    allDay,
                    color: s.color,
                    textColor: s.color ? readableText(s.color) : "#fff",
                    editable: !READ_ONLY && s.writable !== false,
                  },
                });
            }
            for (const row of unscheduled)
              noDate.push({
                source: s,
                row,
                value: row.values[s.propertyId!],
                input: { id: `db:${row.id}:${s.propertyId}`, title: row.title },
              });
          }),
      );
      results.forEach((r, i) => {
        if (r.status === "rejected")
          failures.push(
            `${config.sources.filter((s) => s.kind === "database")[i]?.label || "Database"}: ${toAppError(r.reason).message}`,
          );
      });
      if (alive) {
        setItems([...new Map(next.map((i) => [i.input.id, i])).values()]);
        setUndated(noDate);
        setTruncated(partial);
        setError(
          [
            ...failures,
            ...(snap.invalid
              ? [
                  `${snap.invalid} event schedules could not be read. Their pages are preserved.`,
                ]
              : []),
          ].join(" "),
        );
      }
    };
    void load()
      .catch((e) => alive && setError(toAppError(e).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [
    workspaceId,
    range.from,
    range.to,
    config.sources,
    config.timezone,
    config.autoColor,
    version,
    dataEpoch,
    limit,
  ]);
  const visible = useMemo(
    () =>
      items.filter(
        (i) =>
          !hidden.has(sourceKey(i.source)) &&
          (!hideCompleted || !i.native?.data.completed) &&
          (!query.trim() ||
            `${i.input.title} ${i.native?.data.location ?? ""} ${i.source.label ?? ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase())),
      ),
    [items, hidden, hideCompleted, query],
  );
  const dayItems = visible.filter((i) => {
    const start = i.input.allDay
      ? String(i.input.start).slice(0, 10)
      : DateTime.fromISO(String(i.input.start))
          .setZone(config.timezone)
          .toISODate()!;
    const end = i.input.allDay
      ? addDays(String(i.input.end).slice(0, 10), -1)
      : DateTime.fromISO(String(i.input.end))
          .setZone(config.timezone)
          .toISODate()!;
    return start <= day && end >= day;
  });
  const summary = daySummary(
    dayItems
      .filter((i) => i.native)
      .map((i) => ({
        start: String(i.input.start),
        end: String(i.input.end),
        allDay: i.input.allDay,
        busy: i.native!.data.busy,
        completed: i.native!.data.completed,
      })),
    day,
    config.timezone,
    config.workStart,
    config.workEnd,
  );
  const events = useMemo(() => visible.map((i) => i.input), [visible]);
  const dayRows = useMemo(() => {
    const zone = config.timezone;
    const clock = (iso: unknown) =>
      DateTime.fromISO(String(iso))
        .setZone(zone)
        .toLocaleString(DateTime.TIME_SIMPLE);
    return [...dayItems]
      .sort(
        (a, b) =>
          Number(!!b.input.allDay) - Number(!!a.input.allDay) ||
          String(a.input.start).localeCompare(String(b.input.start)),
      )
      .map((item) => {
        const first = item.input.allDay
          ? String(item.input.start).slice(0, 10)
          : DateTime.fromISO(String(item.input.start)).setZone(zone).toISODate()!;
        const lastDay = item.input.allDay
          ? addDays(String(item.input.end).slice(0, 10), -1)
          : DateTime.fromISO(String(item.input.end)).setZone(zone).toISODate()!;
        const length =
          Math.round(
            DateTime.fromISO(lastDay).diff(DateTime.fromISO(first), "days").days,
          ) + 1;
        const index = Math.round(
          DateTime.fromISO(day).diff(DateTime.fromISO(first), "days").days,
        );
        const timed = !item.input.allDay;
        const counted = !!item.native && timed && item.native.data.busy;
        return {
          item,
          time: timed
            ? `${clock(item.input.start)} – ${clock(item.input.end)}`
            : "All day",
          note: length > 1 ? `Day ${index + 1} of ${length}` : "",
          overlapping:
            counted &&
            dayItems.some(
              (o) =>
                o !== item &&
                o.native?.data.busy &&
                !o.input.allDay &&
                overlaps(
                  { start: String(item.input.start), end: String(item.input.end) },
                  { start: String(o.input.start), end: String(o.input.end) },
                ),
            ),
        };
      });
  }, [dayItems, day, config.timezone]);
  const goToDay = (next: string) => {
    setDay(next);
    if (next < range.from || next >= range.to)
      ref.current?.getApi().gotoDate(next);
  };
  const goToToday = () => {
    const next = currentCalendarDay(config.timezone);
    setDay(next);
    ref.current?.getApi().gotoDate(next);
  };
  useEffect(() => {
    dayCells.forEach((date, el) =>
      el.toggleAttribute("data-selected", date === day),
    );
  }, [dayCells, day]);
  const add = (start = day, end?: string, allDay = true) => {
    const calendarId =
      config.sources.find((s) => s.kind === "calendar")?.pageId ??
      snapshot?.collections[0]?.id;
    useCalendarComposer.getState().show({ calendarId, start, end, allDay });
  };
  const move = async (info: EventDropInfo | EventResizeDoneInfo) => {
    const item = items.find((i) => i.input.id === info.event.id);
    if (!item || READ_ONLY) {
      info.revert();
      return;
    }
    const start = info.event.startStr,
      end = info.event.endStr;
    if (!start || !end) {
      info.revert();
      return;
    }
    try {
      if (item.native) {
        const original = item.native;
        const a = wallTime(start, original.data.timezone, info.event.allDay);
        const b = wallTime(end, original.data.timezone, info.event.allDay);
        const data = patchOccurrence(
          { ...original.data, allDay: info.event.allDay },
          item.occurrence!.originalDate,
          a,
          b,
        );
        const saved = await ipc.calendarSave({
          workspaceId: workspaceId!,
          pageId: original.pageId,
          revision: original.revision,
          title: original.title,
          data,
        });
        useWorkspace
          .getState()
          .notify(
            original.data.recurrence
              ? "This occurrence rescheduled"
              : "Event rescheduled",
            async () => {
              await ipc.calendarSave({
                workspaceId: workspaceId!,
                pageId: saved.pageId,
                revision: saved.revision,
                title: original.title,
                data: original.data,
              });
              calendarChanged();
            },
          );
      } else if (item.row && item.source.propertyId) {
        const old = item.value;
        const allDay = info.event.allDay;
        const value = {
          start: wallTime(
            start,
            item.source.timezone ?? config.timezone,
            allDay,
          ),
          end: allDay
            ? addDays(end.slice(0, 10), -1)
            : wallTime(end, item.source.timezone ?? config.timezone, false),
        };
        await ipc.recordSetValue(item.row.id, item.source.propertyId, value);
        useWorkspace
          .getState()
          .notify(
            `Updated ${item.source.label || "database date"}`,
            async () => {
              await ipc.recordSetValue(
                item.row!.id,
                item.source.propertyId!,
                old,
              );
              calendarChanged();
            },
          );
      }
      calendarChanged();
    } catch (e) {
      info.revert();
      setError(toAppError(e).message);
    }
  };
  const dropTask = async (info: DropInfo) => {
    const task = readCalendarTask(info.draggedEl);
    if (!task || schedulingRef.current || READ_ONLY || !timedView) return;
    schedulingRef.current = true; setScheduling(true); setError("");
    try { await scheduleTask(task, info.dateStr, info.allDay, config.timezone, blockMinutes, config.sources); }
    catch (e) { setError(toAppError(e).message); }
    finally { schedulingRef.current = false; setScheduling(false); }
  };
  const drawerItems = undated.filter((i) => !hidden.has(sourceKey(i.source)) && (!query.trim() || `${i.row!.title} ${i.source.label ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <div className="calendar-block" ref={root}>
      <header className="calendar-block-head">
        <strong>
          <Icon name="calendar" size={16} />
          {config.sources.filter((s) => s.kind === "database").length > 1 ? "Master Calendar" : "Calendar"}
        </strong>
        <select
          aria-label="Calendar view"
          value={displayView}
          disabled={READ_ONLY}
          onChange={(e) => update({ view: e.target.value as CalendarView })}
        >
          {Object.entries(CALENDAR_VIEWS).map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <span />
        {timedView && <button type="button" className="btn" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>Unscheduled Tasks ({drawerItems.length})</button>}
        <button
          type="button"
          className="btn"
          aria-expanded={sourceOpen}
          onClick={() => setSourceOpen(!sourceOpen)}
        >
          Sources
        </button>
        {!READ_ONLY && (
          <button type="button" className="btn primary" onClick={() => add()}>
            New event
          </button>
        )}
        {!expanded && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Expand calendar"
            title="Expand calendar"
            onClick={() => setFull(true)}
          >
            <Icon name="open" />
          </button>
        )}
      </header>
      {sourceOpen && (
        <Sources
          config={config}
          collections={snapshot?.collections ?? []}
          update={update}
          onError={setError}
        />
      )}
      <div className="calendar-filter-bar">
        <input
          aria-label="Search calendar"
          placeholder="Find an event…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check-row">
          <input
            type="checkbox"
            checked={hideCompleted}
            onChange={(e) => setHideCompleted(e.target.checked)}
          />
          Hide completed
        </label>
        {config.sources.length > 1 && (
          <div className="calendar-source-switches">
            {config.sources.map((s) => (
              <button
                key={sourceKey(s)}
                type="button"
                className="btn ghost"
                aria-pressed={!hidden.has(sourceKey(s))}
                onClick={() =>
                  setHidden((h) => {
                    const next = new Set(h);
                    if (next.has(sourceKey(s))) next.delete(sourceKey(s));
                    else next.add(sourceKey(s));
                    return next;
                  })
                }
              >
                <i
                  aria-hidden="true"
                  className="calendar-legend-dot"
                  style={{ background: s.color }}
                />
                {s.label || "Source"}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={reload}>
            Try again
          </button>
        </p>
      )}
      {truncated && (
        <p className="set-hint" role="status">
          This view is showing a limited set of items. Narrow the sources or
          date range.
          {limit < 10000 && (
            <button
              type="button"
              className="link"
              onClick={() => setLimit((n) => Math.min(10000, n + 1000))}
            >
              {" "}
              Load more database records
            </button>
          )}
        </p>
      )}
      {!config.sources.length && (
        <div className="calendar-empty">
          <Icon name="calendar" size={28} />
          <h3>Bring your plans into view</h3>
          <p>Create a calendar for events, or connect dates from a database.</p>
          <button
            type="button"
            className="btn"
            onClick={() => setSourceOpen(true)}
          >
            Choose sources
          </button>
        </div>
      )}
      <div className={`calendar-planner${drawerOpen && timedView ? " with-drawer" : ""}`}>
      <div
        className="calendar-surface"
        aria-busy={loading}
        onClick={(e) => {
          if (
            !(e.target instanceof Element) ||
            e.target.closest("[data-cal-event], button, a")
          )
            return;
          const date = e.target
            .closest<HTMLElement>('[role="cell"][data-date]')
            ?.getAttribute("data-date");
          if (date) setDay(date.slice(0, 10));
        }}
        onPointerOver={(e) => linkEvent(e.currentTarget, e.target, true)}
        onPointerOut={(e) => {
          if (!sameEvent(e.target, e.relatedTarget))
            linkEvent(e.currentTarget, e.target, false);
        }}
        onFocus={(e) => linkEvent(e.currentTarget, e.target, true)}
        onBlur={(e) => linkEvent(e.currentTarget, e.target, false)}
      >
        <FullCalendar
          ref={ref}
          plugins={PLUGINS}
          initialView={displayView}
          initialDate={initialDate}
          height={timedView ? (expanded ? 720 : config.height) : expanded || narrow ? "auto" : config.height}
          headerToolbar={{ start: "prev,next jumpToday", center: "title", end: "" }}
          buttons={{ jumpToday: { text: "Today", click: goToToday } }}
          now={calendarNow}
          timeZone={config.timezone}
          firstDay={config.weekStart}
          weekends={config.weekends}
          weekNumbers={config.weekNumbers}
          events={events}
          editable={!READ_ONLY}
          selectable={!READ_ONLY}
          droppable={!READ_ONLY && timedView && !scheduling}
          dropAccept={(el: HTMLElement) => !!readCalendarTask(el) && readCalendarTask(el)?.workspaceId === workspaceId}
          drop={(info) => void dropTask(info)}
          slotDuration="00:15:00"
          snapDuration="00:15:00"
          scrollTime={config.workStart}
          selectMinDistance={5}
          nowIndicator
          dayMaxEvents={3}
          businessHours={{
            daysOfWeek: [1, 2, 3, 4, 5],
            startTime: config.workStart,
            endTime: config.workEnd,
          }}
          select={(info) => add(info.startStr, info.endStr, info.allDay)}
          dateClick={(info) => setDay(info.dateStr.slice(0, 10))}
          eventDidMount={({ el, event }) => {
            el.dataset.calEvent = event.id;
            watchLabel(el, event.title);
          }}
          eventWillUnmount={({ el }) => unwatchLabel(el)}
          dayCellDidMount={mountDayCell}
          dayCellWillUnmount={unmountDayCell}
          datesSet={(info) =>
            setRange((r) => {
              const from = info.startStr.slice(0, 10),
                to = info.endStr.slice(0, 10);
              return r.from === from && r.to === to ? r : { from, to };
            })
          }
          eventClick={(info) => {
            const item = items.find((i) => i.input.id === info.event.id);
            if (item?.native && !READ_ONLY)
              useCalendarComposer
                .getState()
                .show({ event: item.native, occurrence: item.occurrence });
            else if (item?.row) {
              setDatabaseEdit(item);
              setDateDraft(
                String((item.value as { start?: string })?.start ?? "").slice(
                  0,
                  10,
                ),
              );
            } else if (item?.native)
              void useWorkspace.getState().openPage(item.native.pageId);
          }}
          eventDrop={(info) => void move(info)}
          eventResize={(info) => void move(info)}
        />
      </div>
      {drawerOpen && timedView && <aside className="calendar-task-drawer" aria-label="Unscheduled Tasks" aria-busy={scheduling || loading}>
        <header><h3>Unscheduled Tasks</h3><button type="button" className="icon-btn" aria-label="Close Unscheduled Tasks" onClick={() => setDrawerOpen(false)}><Icon name="close" size={14} /></button></header>
        <p className="set-hint">Drag a task onto a time slot to set its date in the source table.</p>
        <label>Time block length<select value={blockMinutes} onChange={(e) => setBlockMinutes(Number(e.target.value))}>
          {[15, 30, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}
        </select></label>
        {scheduling && <p role="status">Scheduling task…</p>}
        {!drawerItems.length && <p className="set-hint">{loading ? "Loading tasks…" : "No unscheduled tasks in the visible sources."}</p>}
        {!config.sources.some((s) => s.kind === "database") && <button type="button" className="btn" onClick={() => setSourceOpen(true)}>Connect a project table</button>}
        <ul>{drawerItems.slice(0, drawerLimit).map((i) => <li key={i.input.id}>
          <button type="button" className="calendar-task" disabled={READ_ONLY || scheduling || i.source.writable === false}
            data-calendar-task={!READ_ONLY && !scheduling && i.source.writable !== false ? JSON.stringify({ pageId: i.row!.pageId, title: i.row!.title, workspaceId, recordId: i.row!.id, propertyId: i.source.propertyId }) : undefined}
            title="Drag to a time slot, or click to choose a date"
            onClick={() => { setDatabaseEdit(i); setDateDraft(day); }}>
            <span>{i.row!.title || "Untitled"}</span><small><i className="calendar-legend-dot" style={{ background: i.source.color }} />{i.source.label || "Source table"}</small>
          </button>
        </li>)}</ul>
        {drawerItems.length > drawerLimit && <button type="button" className="btn" onClick={() => setDrawerLimit((n) => n + 100)}>Show more tasks ({drawerItems.length - drawerLimit})</button>}
      </aside>}
      </div>
      {[...dayCells].map(([cell, date]) => createPortal(
        <button type="button" className="calendar-day-add" disabled={READ_ONLY}
          aria-label={`Add event on ${DateTime.fromISO(date).toLocaleString(DateTime.DATE_FULL)}`}
          title="Add event"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDay(date); add(date); }}>
          <Icon name="plus" size={12} />
        </button>, cell.firstElementChild ?? cell, date,
      ))}
      <section className="calendar-day" aria-label="Selected day">
        <header className="calendar-day-head">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous day"
            onClick={() => goToDay(addDays(day, -1))}
          >
            <Icon name="back" />
          </button>
          <div className="calendar-day-title-block">
            <h3>
              {DateTime.fromISO(day).toLocaleString({
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </h3>
            <span>
              {dayItems.length === 0
                ? "Nothing scheduled"
                : `${dayItems.length} ${dayItems.length === 1 ? "item" : "items"}`}
              {summary.plannedMinutes > 0 &&
                ` · ${(summary.plannedMinutes / 60).toFixed(1)} h planned`}
              {summary.conflicts > 0 &&
                ` · ${summary.conflicts} overlapping ${summary.conflicts === 1 ? "pair" : "pairs"}`}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next day"
            onClick={() => goToDay(addDays(day, 1))}
          >
            <Icon name="forward" />
          </button>
          <span className="calendar-day-spacer" />
          {day !== today && (
            <button
              type="button"
              className="btn ghost"
              onClick={goToToday}
            >
              Today
            </button>
          )}
          {!READ_ONLY && (
            <button type="button" className="btn" onClick={() => add(day)}>
              <Icon name="plus" size={14} />
              Add event
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Open daily note"
            title="Open daily note"
            disabled={READ_ONLY}
            onClick={() => void openDailyNote(DateTime.fromISO(day).toJSDate())}
          >
            <Icon name="note" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Export calendar"
            title="Export calendar (.ics)"
            onClick={() => {
              try {
                const content = exportCalendar(
                  snapshot?.events.filter((e) =>
                    config.sources.some(
                      (s) =>
                        s.kind === "calendar" && s.pageId === e.data.calendarId,
                    ),
                  ) ?? [],
                );
                const url = URL.createObjectURL(
                  new Blob([content], { type: "text/calendar" }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "suivelle-calendar.ics";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (error) {
                setTransferMessage(toAppError(error).message);
              }
            }}
            disabled={truncated || !snapshot?.events.length}
          >
            <Icon name="upload" />
          </button>
          {!READ_ONLY && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Import calendar"
              title="Import calendar (.ics)"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="download" />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".ics,text/calendar"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f || !workspaceId) return;
              const calendarId = config.sources.find(
                (s) => s.kind === "calendar",
              )?.pageId;
              if (!calendarId) {
                setError("Connect a calendar before importing events.");
                return;
              }
              try {
                const imported = importCalendar(await f.text(), calendarId);
                setTransferMessage(imported.warnings.join(" "));
                if (
                  imported.events.length &&
                  !window.confirm(
                    `Import ${imported.events.length} events into this calendar?`,
                  )
                )
                  return;
                await ipc.calendarImport(workspaceId, imported.events);
                calendarChanged();
                await useWorkspace.getState().reloadTree();
              } catch (error) {
                setError(toAppError(error).message);
              }
            }}
          />
        </header>
        {transferMessage && (
          <p className="field-hint" role="status">
            {transferMessage}
          </p>
        )}
        {dayRows.length > 0 && (
          <ul className="calendar-day-list">
            {dayRows.map(({ item, time, note, overlapping }) => (
              <li key={item.input.id}>
                <button
                  type="button"
                  className="calendar-day-row"
                  data-completed={item.native?.data.completed || undefined}
                  onClick={() => {
                    if (item.native && !READ_ONLY)
                      useCalendarComposer
                        .getState()
                        .show({ event: item.native, occurrence: item.occurrence });
                    else
                      void useWorkspace
                        .getState()
                        .openPage(item.native?.pageId ?? item.row!.pageId);
                  }}
                >
                  <span className="calendar-day-time">{time}</span>
                  <i
                    aria-hidden="true"
                    className="calendar-legend-dot"
                    style={{
                      background: String(
                        item.input.color ?? item.source.color ?? "",
                      ),
                    }}
                  />
                  <span className="calendar-day-name">
                    {item.input.title || "Untitled"}
                  </span>
                  <span className="calendar-day-note">
                    {[note, overlapping && "Overlaps", item.native?.data.location]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {databaseEdit && (
        <section
          className="calendar-record-editor"
          aria-label="Database date editor"
        >
          <strong>{databaseEdit.input.title}</strong>
          <p className="set-hint">
            Changing this date updates {databaseEdit.source.label}. A linked
            work session keeps the deadline separate.
          </p>
          <label>
            Date
            <input
              type="date"
              value={dateDraft}
              disabled={READ_ONLY || dateBusy}
              onChange={(e) => setDateDraft(e.target.value)}
            />
          </label>
          <div className="calendar-form-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void useWorkspace.getState().openPage(databaseEdit.row!.pageId)
              }
            >
              Open record
            </button>
            <button
              type="button"
              className="btn"
              disabled={READ_ONLY}
              onClick={() =>
                useCalendarComposer.getState().show({
                  calendarId: config.sources.find((s) => s.kind === "calendar")
                    ?.pageId,
                  link: {
                    pageId: databaseEdit.row!.pageId,
                    blockId: null,
                    label: databaseEdit.row!.title,
                  },
                  start: day,
                })
              }
            >
              Plan a work session
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setDatabaseEdit(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={READ_ONLY || dateBusy || !dateDraft}
              onClick={async () => {
                setDateBusy(true);
                try {
                  const current = databaseEdit.value as {
                    start?: string;
                    end?: string;
                  };
                  const oldDate = current.start?.slice(0, 10);
                  const delta = oldDate
                    ? DateTime.fromISO(dateDraft).diff(
                        DateTime.fromISO(oldDate),
                        "days",
                      ).days
                    : 0;
                  const value = {
                    ...current,
                    start: dateDraft + (current.start?.slice(10) ?? ""),
                    ...(current.end
                      ? {
                          end: DateTime.fromISO(current.end)
                            .plus({ days: delta })
                            .toFormat(
                              current.end.length === 10
                                ? "yyyy-MM-dd"
                                : "yyyy-MM-dd'T'HH:mm",
                            ),
                        }
                      : {}),
                  };
                  await ipc.recordSetValue(
                    databaseEdit.row!.id,
                    databaseEdit.source.propertyId!,
                    value,
                  );
                  setDatabaseEdit(null);
                  calendarChanged();
                } catch (e) {
                  setError(toAppError(e).message);
                } finally {
                  setDateBusy(false);
                }
              }}
            >
              Save date
            </button>
          </div>
        </section>
      )}
      {!timedView && undated.length > 0 && (
        <details className="calendar-unscheduled">
          <summary>Unscheduled database records ({undated.length})</summary>
          <ul>
            {undated.slice(0, 100).map((i) => (
              <li key={i.input.id}>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void useWorkspace.getState().openPage(i.row!.pageId)
                  }
                >
                  {i.input.title || "Untitled"}
                </button>
                <span>{i.source.label}</span>
                <button
                  type="button"
                  className="btn"
                  disabled={READ_ONLY}
                  onClick={() => {
                    setDatabaseEdit(i);
                    setDateDraft(day);
                  }}
                >
                  Schedule…
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!expanded && (
        <dialog
          ref={fullRef}
          className="palette calendar-expanded"
          aria-label="Expanded calendar"
          onClose={() => setFull(false)}
          onCancel={() => setFull(false)}
        >
          <header className="calendar-expanded-head">
            <h2>Calendar</h2>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close expanded calendar"
              onClick={() => setFull(false)}
            >
              <Icon name="close" />
            </button>
          </header>
          {full && (
            <CalendarBlock
              raw={raw}
              update={update}
              initialDate={ref.current?.getApi().getDate().toISOString()}
              expanded
            />
          )}
        </dialog>
      )}
    </div>
  );
}
