import type { NumberFormat } from "../../types";
import { formatNumberWith } from "./numberFormat";

const SAMPLE = 1234.5678;

/** Edits how a number property is displayed. Values are never changed, only their look. */
export function NumberFormatEditor({ value, onChange }: { value: NumberFormat; onChange: (next: NumberFormat) => void }) {
  const set = (patch: Partial<NumberFormat>) => onChange({ ...value, ...patch });
  const sample = formatNumberWith(value.percent ? SAMPLE / 100 : SAMPLE, value);
  return (
    <fieldset className="numfmt">
      <legend className="picker-group">Number format</legend>
      <div className="numfmt-grid">
        <label className="field">
          <span>Decimals</span>
          <select aria-label="Decimals" value={value.decimals ?? ""} onChange={(e) => set({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })}>
            <option value="">Automatic</option>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Currency symbol</span>
          <input value={value.currency ?? ""} maxLength={4} placeholder="None" aria-label="Currency symbol" onChange={(e) => set({ currency: e.target.value })} />
        </label>
        <label className="field">
          <span>Unit suffix</span>
          <input value={value.unit ?? ""} maxLength={12} placeholder="For example kg" aria-label="Unit suffix" onChange={(e) => set({ unit: e.target.value })} />
        </label>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={!!value.thousands} onChange={(e) => set({ thousands: e.target.checked })} />
        Thousands separator
      </label>
      <label className="check-row">
        <input type="checkbox" checked={!!value.percent} onChange={(e) => set({ percent: e.target.checked })} />
        Show as percent (0.25 becomes 25%)
      </label>
      <label className="check-row">
        <input type="checkbox" checked={!!value.bar} onChange={(e) => set({ bar: e.target.checked })} />
        Progress bar behind the number
      </label>
      {value.bar && (
        <label className="field">
          <span>Bar is full at</span>
          <input
            type="number"
            min={0}
            step="any"
            aria-label="Bar is full at"
            value={value.barMax ?? ""}
            placeholder={value.percent ? "1" : "100"}
            onChange={(e) => set({ barMax: e.target.value === "" || Number(e.target.value) <= 0 ? undefined : Number(e.target.value) })}
          />
        </label>
      )}
      <p className="picker-muted numfmt-sample">
        Looks like <strong>{sample}</strong>
      </p>
    </fieldset>
  );
}
