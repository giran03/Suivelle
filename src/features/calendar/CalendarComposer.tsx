import { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import { ipc, toAppError } from "../../lib/ipc";
import { syncDialog } from "../../lib/dialog";
import { Icon } from "../../components/Icon";
import { DateField } from "../../components/DateField";
import { TimezoneField } from "../../components/TimezoneField";
import { DateRangeField } from "../../components/DateRangeField";
import { ColorPicker } from "../../components/ColorPicker";
import { rememberColor } from "../../lib/color";
import { copyText } from "../../components/editingMenu";
import { listPageTemplates } from "../templates/pageTemplates";
import { useWorkspace } from "../../stores/workspace";
import type { Page, SearchHit } from "../../types";
import {
  calendarChanged,
  useCalendarComposer,
  type CalendarRequest,
} from "./store";
import {
  autoColor,
  durationLabel,
  HEX_COLOR,
  newSchedule,
  parseQuickAdd,
  patchOccurrence,
  readableText,
  scheduleProblem,
  spanDays,
  wallTime,
  type CalendarSchedule,
} from "./model";
import "./calendar.css";

function Body({ request }: { request: CalendarRequest }) {
  const [collections, setCollections] = useState<Page[]>([]);
  const [title, setTitle] = useState(
    request.event?.title ?? request.draft?.title ?? request.link?.label ?? "",
  );
  const [data, setData] = useState<CalendarSchedule>(() => {
    const d = request.event
      ? structuredClone(request.event.data)
      : request.draft
        ? structuredClone(request.draft.data)
        : newSchedule(
          request.calendarId ?? "",
          request.start,
          request.end,
          request.allDay ?? true,
        );
    if (request.link) {
      d.links = [request.link];
      d.followSourceTitle = true;
    }
    if (request.occurrence) {
      d.start = wallTime(request.occurrence.start, d.timezone, d.allDay);
      d.end = wallTime(request.occurrence.end, d.timezone, d.allDay);
    }
    return d;
  });
  const [scope, setScope] = useState<"one" | "future" | "all">(
    request.event?.data.recurrence && request.occurrence ? "one" : "all",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [newName, setNewName] = useState("");
  const [templates, setTemplates] = useState<Page[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [picking, setPicking] = useState(false);
  const [quick, setQuick] = useState("");
  const applyQuick = () => {
    if (!quick.trim()) return;
    const q = parseQuickAdd(quick, DateTime.local());
    if (q.title) setTitle(q.title);
    set({ start: q.start, end: q.end, allDay: q.allDay });
    setQuick("");
  };
  useEffect(() => {
    let alive = true;
    if (!request.event)
      void listPageTemplates()
        .then((p) => alive && setTemplates(p))
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [request]);
  const [linkTitles, setLinkTitles] = useState<Record<string, string>>({});
  const one = scope === "one" && !!request.event?.data.recurrence;
  const problem = scheduleProblem(data);
  const length = durationLabel(data);
  const previewColor =
    data.color ??
    (request.event && spanDays(data) > 1
      ? autoColor(request.event.pageId)
      : null);
  const set = (patch: Partial<CalendarSchedule>) =>
    setData((d) => ({ ...d, ...patch }));
  useEffect(() => {
    let alive = true;
    const today = DateTime.local().toISODate()!;
    ipc
      .calendarSnapshot(request.workspaceId, today, today)
      .then((s) => {
        if (!alive) return;
        setCollections(s.collections);
        if (!request.event)
          setData((d) => ({
            ...d,
            calendarId: d.calendarId || s.collections[0]?.id || "",
          }));
      })
      .catch((e) => alive && setError(toAppError(e).message));
    return () => {
      alive = false;
    };
  }, [request]);
  useEffect(() => {
    let alive = true;
    ipc
      .pageTitles(data.links.map((l) => l.pageId))
      .then((rows) => {
        if (alive)
          setLinkTitles(
            Object.fromEntries(
              rows.map((p) => [
                p.id,
                p.deleted ? "Page in trash" : p.title || "Untitled",
              ]),
            ),
          );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [data.links]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (!query.trim()) {
        setHits([]);
        return;
      }
      ipc
        .searchWorkspace({ workspaceId: request.workspaceId, query, limit: 12 })
        .then((r) => alive && setHits(r))
        .catch((e) => alive && setError(toAppError(e).message));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, request.workspaceId]);
  const createCollection = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const p = await ipc.calendarCreate(request.workspaceId, newName.trim());
      setCollections((c) => [...c, p]);
      set({ calendarId: p.id });
      setNewName("");
      calendarChanged();
      await useWorkspace.getState().reloadTree();
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy || useWorkspace.getState().workspace?.id !== request.workspaceId)
      return;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const schedule =
        one && request.event && request.occurrence
          ? patchOccurrence(
              request.event.data,
              request.occurrence.originalDate,
              data.start,
              data.end,
            )
          : data;
      const saved = await ipc.calendarSave({
        workspaceId: request.workspaceId,
        pageId: request.event?.pageId,
        revision: request.event?.revision,
        title: one ? request.event!.title : title.trim() || "Untitled event",
        data: schedule,
        ...(!request.event && templateId ? { templateId } : {}),
        ...(scope === "future"
          ? { splitDate: request.occurrence?.originalDate }
          : {}),
      });
      calendarChanged();
      await useWorkspace.getState().reloadTree();
      useCalendarComposer.getState().hide();
      useWorkspace.getState().notify(
        request.event ? "Event updated" : "Event created",
        request.event
          ? async () => {
              if (scope === "future") {
                const blocks = await ipc.blockList(request.event!.pageId);
                const old = blocks.find((b) => b.id === request.event!.blockId);
                if (!old)
                  throw new Error("The original series is unavailable.");
                await ipc.calendarSave({
                  workspaceId: request.workspaceId,
                  pageId: request.event!.pageId,
                  revision: old.revision,
                  title: request.event!.title,
                  data: request.event!.data,
                });
                await ipc.pageDelete(saved.pageId);
              } else
                await ipc.calendarSave({
                  workspaceId: request.workspaceId,
                  pageId: saved.pageId,
                  revision: saved.revision,
                  title: request.event!.title,
                  data: request.event!.data,
                });
              calendarChanged();
            }
          : async () => {
              await ipc.pageDelete(saved.pageId);
              calendarChanged();
              await useWorkspace.getState().reloadTree();
            },
      );
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!request.event || busy) return;
    setBusy(true);
    try {
      if (one && request.occurrence) {
        await ipc.calendarSave({
          workspaceId: request.workspaceId,
          pageId: request.event.pageId,
          revision: request.event.revision,
          title: request.event.title,
          data: {
            ...request.event.data,
            exceptions: [
              ...request.event.data.exceptions.filter(
                (x) => x.date !== request.occurrence!.originalDate,
              ),
              {
                date: request.occurrence.originalDate,
                cancelled: true,
                start: null,
                end: null,
              },
            ],
          },
        });
      } else if (
        scope === "future" &&
        request.occurrence &&
        request.event.data.recurrence
      ) {
        await ipc.calendarSave({
          workspaceId: request.workspaceId,
          pageId: request.event.pageId,
          revision: request.event.revision,
          title: request.event.title,
          data: {
            ...request.event.data,
            recurrence: {
              ...request.event.data.recurrence,
              until: DateTime.fromISO(request.occurrence.originalDate)
                .minus({ days: 1 })
                .toISODate()!,
            },
            exceptions: request.event.data.exceptions.filter(
              (x) => x.date < request.occurrence!.originalDate,
            ),
          },
        });
      } else {
        await ipc.pageDelete(request.event.pageId);
      }
      calendarChanged();
      useCalendarComposer.getState().hide();
      useWorkspace
        .getState()
        .notify(
          one
            ? "Occurrence cancelled"
            : scope === "future"
              ? "Future occurrences cancelled"
              : "Event moved to trash",
          async () => {
            if (one || scope === "future") {
              const current = await ipc.blockList(request.event!.pageId);
              const block = current.find(
                (b) => b.id === request.event!.blockId,
              );
              if (block)
                await ipc.calendarSave({
                  workspaceId: request.workspaceId,
                  pageId: request.event!.pageId,
                  revision: block.revision,
                  title: request.event!.title,
                  data: request.event!.data,
                });
            } else await ipc.pageRestore(request.event!.pageId);
            calendarChanged();
          },
        );
    } catch (e) {
      setError(toAppError(e).message);
      setBusy(false);
    }
  };
  return (
    <form
      className="calendar-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <header className="calendar-form-head">
        <h2>{request.event ? "Edit event" : "New event"}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close event editor"
          disabled={busy}
          onClick={() => useCalendarComposer.getState().hide()}
        >
          <Icon name="close" />
        </button>
      </header>
      <fieldset disabled={busy} className="calendar-fields">
        {request.event?.notes && (
          <details>
            <summary>Event notes</summary>
            <p className="calendar-notes-preview">{request.event.notes}</p>
            <p className="set-hint">
              Open this event as a page to edit its notes and attachments.
            </p>
          </details>
        )}
        {!request.event && (
          <label>
            Quick add
            <input
              value={quick}
              maxLength={200}
              placeholder="Focus session Mon–Wed 9am, Review tomorrow 2–3:30pm…"
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyQuick();
                }
              }}
              onBlur={applyQuick}
            />
          </label>
        )}
        {!request.event && templates.length > 0 && (
          <label>
            Notes template
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Blank notes</option>
              {templates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {!request.event && (
          <label>
            Start with a template
            <select
              defaultValue=""
              onChange={(e) => {
                const name = e.target.value;
                if (!name) return;
                const day = data.start.slice(0, 10);
                if (name === "Deadline") {
                  setTitle(name);
                  set({
                    ...newSchedule(data.calendarId, day, undefined, true),
                    busy: false,
                    timezone: data.timezone,
                    links: data.links,
                  });
                } else {
                  const length =
                    name === "Focus session" ? 90 : name === "Review" ? 30 : 60;
                  const start = day + "T09:00";
                  setTitle(name);
                  set({
                    ...newSchedule(
                      data.calendarId,
                      start,
                      DateTime.fromISO(start)
                        .plus({ minutes: length })
                        .toFormat("yyyy-MM-dd'T'HH:mm"),
                      false,
                    ),
                    timezone: data.timezone,
                    links: data.links,
                  });
                }
              }}
            >
              <option value="">Blank event</option>
              <option>Meeting</option>
              <option>Focus session</option>
              <option>Review</option>
              <option>Deadline</option>
            </select>
          </label>
        )}
        {request.event?.data.recurrence && request.occurrence && (
          <label>
            Edit
            <select
              value={scope}
              onChange={(e) => {
                const next = e.target.value as "one" | "future" | "all";
                setScope(next);
                if (next === "all")
                  setData(structuredClone(request.event!.data));
                else
                  setData({
                    ...request.event!.data,
                    start: wallTime(
                      request.occurrence!.start,
                      data.timezone,
                      data.allDay,
                    ),
                    end: wallTime(
                      request.occurrence!.end,
                      data.timezone,
                      data.allDay,
                    ),
                  });
              }}
            >
              <option value="one">This occurrence</option>
              <option
                value="future"
                disabled={
                  request.occurrence.originalDate ===
                  request.event.data.start.slice(0, 10)
                }
              >
                This and future occurrences
              </option>
              <option value="all">Entire series</option>
            </select>
          </label>
        )}
        <label>
          Title
          <input
            autoFocus
            value={title}
            maxLength={500}
            disabled={one || data.followSourceTitle}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you planning?"
          />
        </label>
        <label>
          Calendar
          <select
            value={data.calendarId}
            disabled={one}
            required
            onChange={(e) => set({ calendarId: e.target.value })}
          >
            <option value="">Choose a calendar</option>
            {collections.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        {!one && (
          <div className="calendar-new-source">
            <input
              aria-label="New calendar name"
              value={newName}
              maxLength={200}
              placeholder="Create a calendar…"
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={!newName.trim()}
              onClick={() => void createCollection()}
            >
              Create
            </button>
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={data.allDay}
            disabled={one}
            onChange={(e) => {
              const allDay = e.target.checked;
              const start = data.start.slice(0, 10) + (allDay ? "" : "T09:00");
              const through = DateTime.fromISO(data.end)
                .minus(data.allDay ? { days: 1 } : { milliseconds: 1 })
                .toISODate() ?? data.start.slice(0, 10);
              const end = allDay
                ? DateTime.fromISO(through).plus({ days: 1 }).toISODate()!
                : `${through}T10:00`;
              set({ allDay, start, end });
            }}
          />
          All day
        </label>
        <DateRangeField
          start={data.start}
          end={data.allDay ? DateTime.fromISO(data.end).minus({ days: 1 }).toISODate() ?? "" : data.end}
          allDay={data.allDay}
          onChange={({ start, end }) => set({ start, end: data.allDay ? DateTime.fromISO(end).plus({ days: 1 }).toISODate()! : end })}
        />
        {(problem || length) && (
          <p
            className={problem ? "field-error" : "set-hint"}
            role={problem ? "alert" : undefined}
          >
            {problem ?? `Lasts ${length}`}
          </p>
        )}
        {!data.allDay && (
          <label>
            Timezone
            <TimezoneField value={data.timezone} disabled={one} onChange={timezone => set({ timezone })} />
          </label>
        )}
        {!one && (
          <>
            <div className="calendar-color-field">
              <span id="calendar-color-label">Color</span>
              <button
                type="button"
                className="btn calendar-color-button"
                aria-labelledby="calendar-color-label calendar-color-value"
                aria-haspopup="dialog"
                onClick={() => setPicking(true)}
              >
                <i
                  aria-hidden="true"
                  data-auto={!data.color || undefined}
                  style={previewColor ? { background: previewColor } : undefined}
                />
                <span id="calendar-color-value">
                  {data.color ?? "Automatic"}
                </span>
              </button>
              {data.color && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => set({ color: undefined })}
                >
                  Use automatic
                </button>
              )}
            </div>
            <p className="set-hint">
              Automatic gives multi-day events their own color so overlapping
              ranges stay apart; single-day events follow the calendar color.
            </p>
            <label>
              Repeat
              <select
                value={data.recurrence?.frequency ?? "none"}
                onChange={(e) =>
                  set({
                    recurrence:
                      e.target.value === "none"
                        ? null
                        : {
                            frequency: e.target.value as NonNullable<
                              CalendarSchedule["recurrence"]
                            >["frequency"],
                            interval: 1,
                            days: [],
                            until: null,
                            count: null,
                          },
                    exceptions: [],
                  })
                }
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            {data.recurrence && (
              <div className="calendar-repeat">
                <label>
                  Every
                  <input
                    type="number"
                    min={1}
                    max={99}
                    required
                    value={data.recurrence.interval}
                    onChange={(e) =>
                      set({
                        recurrence: {
                          ...data.recurrence!,
                          interval: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                {data.recurrence.frequency === "weekly" && (
                  <div
                    className="calendar-weekdays"
                    role="group"
                    aria-label="Repeat on weekdays"
                  >
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
                      (name, i) => (
                        <button
                          key={name}
                          type="button"
                          className="btn"
                          aria-pressed={data.recurrence!.days.includes(i)}
                          onClick={() =>
                            set({
                              recurrence: {
                                ...data.recurrence!,
                                days: data.recurrence!.days.includes(i)
                                  ? data.recurrence!.days.filter((d) => d !== i)
                                  : [...data.recurrence!.days, i],
                              },
                            })
                          }
                        >
                          {name}
                        </button>
                      ),
                    )}
                  </div>
                )}
                <div className="calendar-two-fields">
                  <label>
                    Until (optional)
                    <DateField
                      label="Repeat until"
                      type="date"
                      value={data.recurrence.until ?? ""}
                      onChange={(value) =>
                        set({
                          recurrence: {
                            ...data.recurrence!,
                            until: value || null,
                            count: null,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Occurrences (optional)
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={data.recurrence.count ?? ""}
                      onChange={(e) =>
                        set({
                          recurrence: {
                            ...data.recurrence!,
                            count: e.target.value
                              ? Number(e.target.value)
                              : null,
                            until: null,
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <p className="set-hint">
                  Monthly dates that do not exist are skipped. Recurring times
                  keep their local timezone.
                </p>
              </div>
            )}
            <label>
              Location
              <input
                value={data.location}
                maxLength={1000}
                onChange={(e) => set({ location: e.target.value })}
              />
            </label>
            <label>
              Reminders
              <select
                value={data.reminders.join(",")}
                onChange={(e) =>
                  set({
                    reminders: e.target.value
                      ? e.target.value.split(",").map(Number)
                      : [],
                  })
                }
              >
                <option value="">None</option>
                <option value="0">At start</option>
                <option value="5">5 minutes before</option>
                <option value="15">15 minutes before</option>
                <option value="60">1 hour before</option>
                <option value="1440">1 day before</option>
                <option value="15,1440">1 day and 15 minutes before</option>
              </select>
            </label>
            <p className="set-hint">
              Reminders run while Suivelle is open, including in the tray.
              All-day reminders use 9 a.m. in the event timezone.
            </p>
            <div className="calendar-two-fields">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={data.busy}
                  onChange={(e) => set({ busy: e.target.checked })}
                />
                Counts as busy time
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={data.completed}
                  onChange={(e) => set({ completed: e.target.checked })}
                />
                Session completed
              </label>
            </div>
            <details className="calendar-links" open={data.links.length > 0}>
              <summary>Linked pages and blocks ({data.links.length})</summary>
              <ul>
                {data.links.map((l, i) => (
                  <li key={`${l.pageId}:${l.blockId}`}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        useCalendarComposer.getState().hide();
                        void useWorkspace
                          .getState()
                          .openPage(l.pageId, l.blockId);
                      }}
                    >
                      {linkTitles[l.pageId] ?? l.label ?? "Missing page"}
                      {l.blockId ? " · Block" : ""}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Unlink ${l.label}`}
                      onClick={() =>
                        set({ links: data.links.filter((_, at) => at !== i) })
                      }
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <input
                aria-label="Find a page or block to link"
                placeholder="Find a page or block…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {hits.length > 0 && (
                <ul className="calendar-link-results">
                  {hits.map((h) => (
                    <li key={`${h.pageId}:${h.blockId}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const link = {
                            pageId: h.pageId,
                            blockId: h.blockId,
                            label: h.pageTitle,
                          };
                          if (
                            !data.links.some(
                              (l) =>
                                l.pageId === link.pageId &&
                                l.blockId === link.blockId,
                            )
                          )
                            set({ links: [...data.links, link] });
                          setQuery("");
                          setHits([]);
                        }}
                      >
                        {h.pageTitle}
                        {h.kind === "block"
                          ? ` · ${h.snippet.replace(/[\uE000\uE001]/g, "")}`
                          : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </>
        )}
      </fieldset>
      {!one && data.links.length > 0 && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={!!data.followSourceTitle}
            disabled={busy}
            onChange={(e) => set({ followSourceTitle: e.target.checked })}
          />
          Follow the linked source title
        </label>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <footer className="calendar-form-actions">
        {request.event && <div className="calendar-event-tools" role="group" aria-label="Event tools">
          <button type="button" className="icon-btn" aria-label="Copy event link" data-tooltip="Copy link" disabled={busy}
            onClick={() => void copyText(`suivelle://page/${request.event!.pageId}`)}>
            <Icon name="link" size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="Remind in 15 minutes" data-tooltip="Remind in 15 min" disabled={busy}
            onClick={async () => {
              try {
                await ipc.reminderCreate(request.event!.pageId,
                  DateTime.local().plus({ minutes: 15 }).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
                  "Calendar reminder (snoozed)");
                useWorkspace.getState().notify("Reminder snoozed for 15 minutes");
              } catch (e) { setError(toAppError(e).message); }
            }}>
            <Icon name="clock" size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="Duplicate event" data-tooltip="Duplicate event" disabled={busy}
            onClick={() => {
              const copy = { ...data, recurrence: one ? null : data.recurrence, exceptions: [], completed: false };
              useCalendarComposer.getState().hide();
              useCalendarComposer.getState().show({ draft: { title: `${title.trim() || "Event"} (copy)`, data: copy } });
            }}>
            <Icon name="duplicate" size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="Open event as page" data-tooltip="Open as page" disabled={busy}
            onClick={() => { useCalendarComposer.getState().hide(); void useWorkspace.getState().openPage(request.event!.pageId); }}>
            <Icon name="open" size={16} />
          </button>
          <button type="button" className="icon-btn calendar-event-delete" disabled={busy}
            aria-label={one ? "Cancel occurrence" : scope === "future" ? "Cancel future occurrences" : "Move event to trash"}
            data-tooltip={one ? "Cancel occurrence" : scope === "future" ? "Cancel future occurrences" : "Move to trash"}
            onClick={() => void remove()}>
            <Icon name="trash" size={16} />
          </button>
        </div>}
        <div className="calendar-event-save" role="group" aria-label="Save event changes">
          <button type="button" className="btn" disabled={busy} onClick={() => useCalendarComposer.getState().hide()}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !data.calendarId || !!problem}>
            {busy ? "Saving…" : request.event ? "Save" : "Create event"}
          </button>
        </div>
      </footer>
      {picking && (
        <ColorPicker
          title="Event color"
          hint="Preview · used for this event's bar and dot"
          initial={
            data.color && HEX_COLOR.test(data.color)
              ? data.color
              : (previewColor ?? "#355AA4")
          }
          preview={(color) => (
            <span
              className="calendar-color-preview"
              style={{ background: color, color: readableText(color) }}
              aria-hidden="true"
            >
              {title.trim() || "Event"}
            </span>
          )}
          onUse={(color) => {
            rememberColor(color);
            set({ color: color.toLowerCase() });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </form>
  );
}
export function CalendarComposer() {
  const request = useCalendarComposer((s) => s.request);
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current) syncDialog(ref.current, !!request);
  }, [request]);
  useEffect(() => {
    if (request && request.workspaceId !== workspaceId)
      useCalendarComposer.getState().hide();
  }, [request, workspaceId]);
  return (
    <dialog
      ref={ref}
      className="palette calendar-editor"
      closedby="any"
      aria-label="Calendar event"
      onClick={(e) => {
        if ("closedBy" in HTMLDialogElement.prototype || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          useCalendarComposer.getState().hide();
      }}
      onCancel={(e) => {
        e.preventDefault();
        useCalendarComposer.getState().hide();
      }}
      onClose={() => useCalendarComposer.getState().hide()}
    >
      {request && <Body key={request.id} request={request} />}
    </dialog>
  );
}
