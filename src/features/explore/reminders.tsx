import { useEffect, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { describeParsed, parseNaturalDate } from "../database/naturalDate";
import { Icon } from "../../components/Icon";
import { READ_ONLY } from "../../lib/access";
import type { Reminder } from "../../types";
import { useExplore } from "./store";

/** "tomorrow 9am" → "2026-10-14T09:00:00"; a date alone means 9 in the morning. */
export function reminderStamp(input: string, now = new Date()): string | null {
  const parsed = parseNaturalDate(input, { now });
  if (!parsed) return null;
  return `${parsed.date}T${parsed.time ?? "09:00"}:00`;
}

export function formatWhen(stamp: string): string {
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? stamp : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Sets a reminder for the open page. */
export function RemindPanel() {
  const page = useWorkspace((s) => s.selectedPage);
  const [when, setWhen] = useState("tomorrow 9am");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stamp = reminderStamp(when);
  const parsed = parseNaturalDate(when);
  const past = !!stamp && new Date(stamp).getTime() < Date.now();
  if (!page) return <p className="picker-muted">Open a page to set a reminder for it.</p>;
  const save = async () => {
    if (!stamp) return;
    try {
      const r = await ipc.reminderCreate(page.id, stamp, note);
      useExplore.getState().hide();
      useWorkspace.getState().notify(`Reminder set for ${formatWhen(r.remindAt)}.`);
    } catch (e) { setError(toAppError(e).message); }
  };
  return <form className="explore-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <p className="picker-muted">Remind me about <strong>{page.title || "Untitled"}</strong></p>
    <label className="field"><span>When</span>
      <input autoFocus value={when} onChange={(e) => setWhen(e.target.value)} placeholder="tomorrow 9am, friday at 14:00, in 3 days" aria-describedby="remind-when-hint" />
    </label>
    <p id="remind-when-hint" className={`set-hint${!stamp || past ? " field-error" : ""}`} role="status">
      {!stamp ? "Try “tomorrow 9am”, “friday at 14:00” or “in 3 days”." : past ? "That time has passed." : `${describeParsed(parsed!)}${parsed?.time ? "" : " at 9:00"}`}
    </p>
    <label className="field"><span>Note <small className="picker-muted">Optional</small></span>
      <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What to do then" />
    </label>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="explore-actions">
      <button type="button" className="btn ghost" onClick={() => useExplore.getState().show("reminders")}>All reminders…</button>
      <button type="submit" className="btn primary" disabled={!stamp || past}>Set reminder</button>
    </div>
  </form>;
}

/** Upcoming reminders, then ones that fired in the last week. */
export function RemindersPanel() {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const [items, setItems] = useState<Reminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { if (workspaceId) ipc.reminderList(workspaceId).then(setItems, (e) => setError(toAppError(e).message)); };
  useEffect(load, [workspaceId]);
  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!items) return <p className="picker-muted" role="status">Loading reminders…</p>;
  if (!items.length) return <p className="picker-muted">No reminders. Use “Remind me about this page…” from the command palette on any page.</p>;
  return <ul className="explore-list">{items.map((r) =>
    <li key={r.id} className={r.firedAt ? "done" : undefined}>
      <button type="button" className="explore-row" onClick={() => { useExplore.getState().hide(); void useWorkspace.getState().selectPage(r.pageId); }}>
        <Icon name={r.firedAt ? "check" : "clock"} size={14} />
        <span className="explore-row-main">{r.pageTitle || "Untitled"}{r.note && <small>{r.note}</small>}</span>
        <time dateTime={r.remindAt}>{formatWhen(r.remindAt)}</time>
      </button>
      <button type="button" className="icon-btn" disabled={READ_ONLY} aria-label={`Delete reminder for ${r.pageTitle || "Untitled"}`} title="Delete reminder"
        onClick={() => void ipc.reminderDelete(r.id).then(load, (e) => setError(toAppError(e).message))}><Icon name="trash" size={14} /></button>
    </li>)}
  </ul>;
}
