import { Popover, type Anchor } from "../../components/Popover";
import type { DateBucket, GroupSpec, Property, ViewConfig } from "../../types";

const GROUPABLE = new Set(["select", "status", "checkbox", "date", "created_time", "updated_time"]);
const isDate = (p: Property | undefined) => !!p && ["date", "created_time", "updated_time"].includes(p.type);

function GroupPicker({
  label,
  none,
  props,
  value,
  exclude,
  onChange,
}: {
  label: string;
  none: string;
  props: Property[];
  value: GroupSpec | null | undefined;
  exclude?: string;
  onChange: (g: GroupSpec | null) => void;
}) {
  const options = props.filter((p) => GROUPABLE.has(p.type) && p.id !== exclude);
  const current = options.find((p) => p.id === value?.propertyId);
  return (
    <div className="group-picker">
      <label className="field">
        <span>{label}</span>
        <select
          value={value?.propertyId ?? ""}
          onChange={(e) => {
            const p = options.find((o) => o.id === e.target.value);
            onChange(p ? { propertyId: p.id, bucket: isDate(p) ? (value?.bucket ?? "month") : null } : null);
          }}
        >
          <option value="">{none}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {isDate(current) && value && (
        <label className="field">
          <span>Group dates by</span>
          <select aria-label={`${label}: date grouping`} value={value.bucket ?? "month"} onChange={(e) => onChange({ ...value, bucket: e.target.value as DateBucket })}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </label>
      )}
    </div>
  );
}

export function GroupPanel({
  anchor,
  onClose,
  props,
  config,
  allowSubgroup,
  onChange,
}: {
  anchor: Anchor;
  onClose: () => void;
  props: Property[];
  config: ViewConfig;
  allowSubgroup: boolean;
  onChange: (patch: Partial<ViewConfig>) => void;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} label="Group" className="picker">
      <GroupPicker label="Group by" none="No grouping" props={props} value={config.group} onChange={(group) => onChange({ group, subgroup: group ? config.subgroup : null })} />
      {allowSubgroup && config.group && (
        <GroupPicker label="Then by" none="No sub-groups" props={props} value={config.subgroup} exclude={config.group.propertyId} onChange={(subgroup) => onChange({ subgroup })} />
      )}
      {config.group && (
        <label className="check-row">
          <input type="checkbox" checked={!!config.hideEmptyGroups} onChange={(e) => onChange({ hideEmptyGroups: e.target.checked })} />
          Hide groups with no records
        </label>
      )}
    </Popover>
  );
}
