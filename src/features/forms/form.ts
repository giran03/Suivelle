import type { FormField, FormSpec, Property } from "../../types";

export interface ShownField {
  field: FormField;
  prop: Property;
}

/** Properties a person can fill in; calculated, automatic and relation properties are not asked for. */
export const isFillable = (p: Property) => !["created_time", "updated_time", "unique_id", "relation", "rollup", "formula", "button"].includes(p.type);

/** The form's fields in order, each with its property (fields whose property is gone are skipped). */
export function shownFields(spec: FormSpec | null | undefined, props: Property[]): ShownField[] {
  const fields = spec?.fields ?? props.filter(isFillable).map((p) => ({ propertyId: p.id, required: p.type === "title" }));
  return fields.flatMap((field) => {
    const prop = props.find((p) => p.id === field.propertyId);
    return prop && isFillable(prop) ? [{ field, prop }] : [];
  });
}

export const labelOf = ({ field, prop }: ShownField) => field.label?.trim() || prop.name;

/** A value as typed into the form: text for inputs, a boolean, or a list of option ids. */
export type Entry = string | boolean | string[];

export function isBlank(e: Entry | undefined): boolean {
  if (e === undefined) return true;
  if (typeof e === "string") return e.trim() === "";
  if (typeof e === "boolean") return e === false;
  return e.length === 0;
}

/** Field errors by property id; empty when the form can be submitted. */
export function validate(fields: ShownField[], entries: Record<string, Entry>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const e = entries[f.prop.id];
    const name = labelOf(f);
    if (f.field.required && isBlank(e)) {
      errors[f.prop.id] = f.prop.type === "checkbox" ? `${name} must be checked` : `${name} is required`;
      continue;
    }
    if (typeof e !== "string" || e.trim() === "") continue;
    if (f.prop.type === "number" && !Number.isFinite(Number(e))) errors[f.prop.id] = `${name} must be a number`;
    else if (f.prop.type === "email" && !/^\S+@\S+$/.test(e.trim())) errors[f.prop.id] = `${name} must be an email address`;
  }
  return errors;
}

/** What the backend expects: no empty values, numbers as numbers, dates as `{start}`. */
export function toValues(fields: ShownField[], entries: Record<string, Entry>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { prop } of fields) {
    if (prop.type === "title") continue;
    const e = entries[prop.id];
    if (isBlank(e)) continue;
    switch (prop.type) {
      case "number":
        out[prop.id] = Number(e);
        break;
      case "date":
        out[prop.id] = { start: String(e) };
        break;
      case "checkbox":
        out[prop.id] = e === true;
        break;
      default:
        out[prop.id] = typeof e === "string" ? e.trim() : e;
    }
  }
  return out;
}
