import type { Action, Property, Trigger } from "../../types";
import { optionsOf } from "../database/model";

export type TriggerType = Trigger["type"];
export type ActionType = Action["type"];

export const TRIGGER_TYPES: { type: TriggerType; label: string; hint: string }[] = [
  { type: "record_created", label: "A record is created", hint: "Also runs for records made by forms, templates and other automations" },
  { type: "record_updated", label: "A record is changed", hint: "Any property or the title changes" },
  { type: "property_changed", label: "A property changes", hint: "Optionally only when it becomes a given value" },
  { type: "date_reached", label: "A date is reached", hint: "Once per record, from a date property" },
  { type: "schedule", label: "On a schedule", hint: "Every few minutes or hours, daily or weekly" },
  { type: "app_started", label: "Suivelle starts", hint: "Each time the app opens" },
  { type: "button", label: "A button is pressed", hint: "From a Button property on a record" },
];

export const ACTION_TYPES: { type: ActionType; label: string; needsRecord: boolean }[] = [
  { type: "update_properties", label: "Change properties", needsRecord: true },
  { type: "set_status", label: "Set a status", needsRecord: true },
  { type: "create_record", label: "Create a record", needsRecord: false },
  { type: "duplicate_record", label: "Duplicate the record", needsRecord: true },
  { type: "archive_record", label: "Archive the record", needsRecord: true },
  { type: "trash_record", label: "Move the record to the trash", needsRecord: true },
  { type: "notify", label: "Show a desktop notification", needsRecord: false },
];

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const triggerHasRecord = (t: Trigger) => t.type !== "schedule" && t.type !== "app_started";

/** Properties an automation can set: ones people can edit, except the title and the kinds not supported here. */
export const isSettable = (p: Property) => !["title", "created_time", "updated_time", "unique_id", "rollup", "formula", "button", "relation", "multi_select"].includes(p.type);
export const isWatchable = (p: Property) => !["created_time", "updated_time", "unique_id", "rollup", "button", "relation"].includes(p.type);

export function newTrigger(type: TriggerType, props: Property[]): Trigger {
  switch (type) {
    case "property_changed":
      return { type, propertyId: props.find(isWatchable)?.id ?? "" };
    case "date_reached":
      return { type, propertyId: props.find((p) => p.type === "date")?.id ?? "", offsetDays: 0, time: "09:00" };
    case "schedule":
      return { type, every: "daily", interval: 1, time: "09:00", days: [] };
    case "button":
      return { type, propertyId: props.find((p) => p.type === "button")?.id ?? "" };
    default:
      return { type } as Trigger;
  }
}

export function newAction(type: ActionType, props: Property[]): Action {
  switch (type) {
    case "update_properties": {
      const p = props.find(isSettable);
      return { type, values: p ? { [p.id]: defaultValue(p) } : {} };
    }
    case "set_status": {
      const p = props.find((x) => x.type === "status") ?? props.find((x) => x.type === "select");
      return { type, propertyId: p?.id ?? "", optionId: p ? (optionsOf(p).find((o) => o.group === "done")?.id ?? optionsOf(p)[0]?.id ?? "") : "" };
    }
    case "create_record":
      return { type, title: "", values: {} };
    case "notify":
      return { type, title: "", body: "" };
    default:
      return { type } as Action;
  }
}

/** A sensible starting value for a property in an automation. */
export function defaultValue(p: Property): unknown {
  switch (p.type) {
    case "checkbox":
      return true;
    case "number":
      return 0;
    case "select":
    case "status":
      return optionsOf(p)[0]?.id ?? "";
    case "date":
      return { start: "{{today}}" };
    default:
      return "";
  }
}

const nameOf = (props: Property[], id: string | undefined | null) => props.find((p) => p.id === id)?.name ?? "a property that no longer exists";

export function describeTrigger(t: Trigger, props: Property[]): string {
  switch (t.type) {
    case "record_created":
      return "When a record is created";
    case "record_updated":
      return "When a record is changed";
    case "property_changed": {
      const p = props.find((x) => x.id === t.propertyId);
      const to = t.to === undefined || t.to === null ? "" : ` to ${valueText(p, t.to)}`;
      return `When ${nameOf(props, t.propertyId)} changes${to}`;
    }
    case "date_reached": {
      const d = t.offsetDays;
      const when = d === 0 ? "on" : d < 0 ? `${-d} day${d === -1 ? "" : "s"} before` : `${d} day${d === 1 ? "" : "s"} after`;
      return `${when === "on" ? "On" : `At ${t.time}, ${when}`} the date in ${nameOf(props, t.propertyId)}${d === 0 ? ` at ${t.time}` : ""}`;
    }
    case "schedule":
      if (t.every === "minutes") return t.interval === 1 ? "Every minute" : `Every ${t.interval} minutes`;
      if (t.every === "hours") return t.interval === 1 ? "Every hour" : `Every ${t.interval} hours`;
      if (t.every === "daily") return `Every day at ${t.time}`;
      return `Every ${t.days.map((d) => WEEKDAYS[d]).join(", ")} at ${t.time}`;
    case "app_started":
      return "When Suivelle starts";
    case "button":
      return `When the “${props.find((p) => p.id === t.propertyId)?.config.label ?? nameOf(props, t.propertyId)}” button is pressed`;
  }
}

function valueText(p: Property | undefined, v: unknown): string {
  if (p && (p.type === "select" || p.type === "status")) return `“${optionsOf(p).find((o) => o.id === v)?.name ?? "?"}”`;
  if (typeof v === "boolean") return v ? "checked" : "unchecked";
  if (v && typeof v === "object" && "start" in v) return String((v as { start: string }).start).replace("{{today}}", "today");
  return `“${String(v)}”`;
}

export function describeAction(a: Action, props: Property[]): string {
  switch (a.type) {
    case "update_properties": {
      const parts = Object.entries(a.values).map(([id, v]) => `${nameOf(props, id)} = ${valueText(props.find((p) => p.id === id), v)}`);
      return parts.length ? `Set ${parts.join(", ")}` : "Change properties";
    }
    case "set_status": {
      const p = props.find((x) => x.id === a.propertyId);
      return `Set ${nameOf(props, a.propertyId)} to ${valueText(p, a.optionId)}`;
    }
    case "create_record":
      return `Create a record${a.title ? ` “${a.title}”` : ""}`;
    case "duplicate_record":
      return "Duplicate the record";
    case "archive_record":
      return "Archive the record";
    case "trash_record":
      return "Move the record to the trash";
    case "notify":
      return `Notify “${a.title || "…"}”`;
  }
}

/** Why an automation cannot be saved yet, in words; null when it can. */
export function problemWith(name: string, trigger: Trigger, actions: Action[], props: Property[]): string | null {
  if (!name.trim()) return "Give the automation a name.";
  if ((trigger.type === "property_changed" || trigger.type === "date_reached" || trigger.type === "button") && !props.some((p) => p.id === trigger.propertyId)) {
    return trigger.type === "button" ? "Choose a button property (or add one first)." : trigger.type === "date_reached" ? "Choose a date property." : "Choose a property.";
  }
  if (trigger.type === "schedule" && trigger.every === "weekly" && trigger.days.length === 0) return "Choose at least one day of the week.";
  if (actions.length === 0) return "Add at least one action.";
  for (const a of actions) {
    if (!triggerHasRecord(trigger) && ACTION_TYPES.find((x) => x.type === a.type)?.needsRecord) return "A schedule or app start has no record: use only “Create a record” and notifications.";
    if (a.type === "update_properties" && Object.keys(a.values).length === 0) return "Choose a property to change.";
    if (a.type === "set_status" && (!a.propertyId || !a.optionId)) return "Choose a status to set.";
    if (a.type === "notify" && !a.title.trim()) return "Give the notification a title.";
  }
  const last = actions.findIndex((a) => a.type === "archive_record" || a.type === "trash_record");
  if (last >= 0 && last !== actions.length - 1) return "Archiving or trashing the record must be the last action.";
  return null;
}
