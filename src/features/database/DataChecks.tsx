import type { PropertyType, SelectOption, ValidationRules } from "../../types";
import { cleanRules, describeRules } from "./validation";

export interface Checks {
  validation: ValidationRules;
  default: unknown;
}

/** Types whose cells can carry data checks and a default value (the backend's `supports_checks`). */
export const CHECK_TYPES: PropertyType[] = ["title", "text", "url", "email", "phone", "number", "select", "multi_select", "status", "date", "checkbox"];
export const supportsChecks = (t: PropertyType) => CHECK_TYPES.includes(t);

const TEXTY: PropertyType[] = ["title", "text", "url", "email", "phone"];
const UNIQUE_TYPES: PropertyType[] = [...TEXTY, "number", "select", "status"];

export const emptyChecks = (): Checks => ({ validation: {}, default: undefined });

/** What gets stored: blanks dropped, so an untouched property keeps a plain config. */
export function checksConfig(c: Checks): { validation?: ValidationRules; default?: unknown } {
  const validation = cleanRules(c.validation);
  const out: { validation?: ValidationRules; default?: unknown } = {};
  if (validation) out.validation = validation;
  if (c.default !== undefined && c.default !== null && c.default !== "") out.default = c.default;
  return out;
}

const numberOrUndefined = (s: string): number | undefined => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));

/**
 * Data checks (required, unique, minimum and maximum, email or web address format) and a default value
 * for new records. Checks only mark cells that break them; they never block typing, pasting or importing.
 */
export function DataChecks({ type, options, value, onChange }: { type: PropertyType; options?: SelectOption[]; value: Checks; onChange: (c: Checks) => void }) {
  if (!supportsChecks(type)) return null;
  const v = value.validation;
  const set = (patch: Partial<ValidationRules>) => onChange({ ...value, validation: { ...v, ...patch } });
  const texty = TEXTY.includes(type);
  const ranged = texty || type === "number";
  const summary = describeRules(cleanRules(v));
  const open = !!summary || value.default !== undefined;
  return (
    <details className="data-checks" open={open || undefined}>
      <summary>
        Data checks and default
        {summary && <span className="picker-muted"> ({summary})</span>}
      </summary>
      <p className="picker-muted">Cells that break a check are marked, not blocked.</p>
      <label className="check-row">
        <input type="checkbox" checked={!!v.required} onChange={(e) => set({ required: e.target.checked })} />
        Required
      </label>
      {UNIQUE_TYPES.includes(type) && (
        <label className="check-row">
          <input type="checkbox" checked={!!v.unique} onChange={(e) => set({ unique: e.target.checked })} />
          Unique
        </label>
      )}
      {ranged && (
        <div className="check-pair">
          <label className="field">
            <span>{type === "number" ? "Smallest value" : "Fewest characters"}</span>
            <input type="number" step="any" min={type === "number" ? undefined : 0} value={v.min ?? ""} onChange={(e) => set({ min: numberOrUndefined(e.target.value) })} />
          </label>
          <label className="field">
            <span>{type === "number" ? "Largest value" : "Most characters"}</span>
            <input type="number" step="any" min={type === "number" ? undefined : 0} value={v.max ?? ""} onChange={(e) => set({ max: numberOrUndefined(e.target.value) })} />
          </label>
        </div>
      )}
      {(type === "text" || type === "title") && (
        <label className="field">
          <span>Must look like</span>
          <select value={v.format ?? ""} onChange={(e) => set({ format: (e.target.value || undefined) as ValidationRules["format"] })}>
            <option value="">Anything</option>
            <option value="email">An email address</option>
            <option value="url">A web address</option>
          </select>
        </label>
      )}
      {type !== "title" && type !== "multi_select" && (
        <DefaultField type={type} options={options ?? []} value={value.default} onChange={(d) => onChange({ ...value, default: d })} />
      )}
    </details>
  );
}

function DefaultField({ type, options, value, onChange }: { type: PropertyType; options: SelectOption[]; value: unknown; onChange: (v: unknown) => void }) {
  if (type === "checkbox") {
    return (
      <label className="check-row">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />
        Checked on new records
      </label>
    );
  }
  if (type === "select" || type === "status") {
    const usable = options.filter((o) => o.id);
    if (usable.length === 0) return null;
    return (
      <label className="field">
        <span>Default value</span>
        <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">None</option>
          {usable.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (type === "number") {
    return (
      <label className="field">
        <span>Default value</span>
        <input type="number" step="any" value={typeof value === "number" ? value : ""} onChange={(e) => onChange(numberOrUndefined(e.target.value))} />
      </label>
    );
  }
  if (type === "date") {
    const start = value && typeof value === "object" ? String((value as { start?: string }).start ?? "") : "";
    return (
      <label className="field">
        <span>Default date</span>
        <input type="date" value={start} onChange={(e) => onChange(e.target.value ? { start: e.target.value } : undefined)} />
      </label>
    );
  }
  return (
    <label className="field">
      <span>Default value</span>
      <input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
    </label>
  );
}
