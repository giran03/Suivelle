import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, type Anchor } from "../../components/Popover";
import type { Property, SelectOption, Tone } from "../../types";
import { FormulaEditor } from "./FormulaEditor";
import { isOptionType, optionsOf, TYPE_META } from "./model";

const TONES: Tone[] = ["gray", "violet", "red", "orange", "green", "blue"];
const GROUPS: { id: NonNullable<SelectOption["group"]>; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "In progress" },
  { id: "done", label: "Complete" },
];

interface Draft {
  id?: string;
  name: string;
  color: Tone;
  group?: SelectOption["group"];
}

/** Rename a property and, for option types, edit its options (names, colours, status groups). */
export function PropertyEditor({
  prop,
  anchor,
  onSave,
  onClose,
}: {
  prop: Property;
  anchor: Anchor;
  onSave: (patch: { name?: string; config?: unknown }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(prop.name);
  const [prefix, setPrefix] = useState(prop.config.prefix ?? "");
  const [options, setOptions] = useState<Draft[]>(() => optionsOf(prop).map((o) => ({ id: o.id, name: o.name, color: o.color, group: o.group })));
  const [fresh, setFresh] = useState("");
  const [expression, setExpression] = useState(prop.config.expression ?? "");
  const [label, setLabel] = useState(prop.config.label ?? "Run");
  const withOptions = isOptionType(prop.type);

  const save = async () => {
    const patch: { name?: string; config?: unknown } = {};
    if (name.trim() && name.trim() !== prop.name) patch.name = name.trim();
    if (withOptions) {
      const all = fresh.trim() ? [...options, { name: fresh.trim(), color: "gray" as Tone, group: "todo" as const }] : options;
      patch.config = { options: all.filter((o) => o.name.trim()).map((o) => ({ ...o, name: o.name.trim() })) };
    }
    if (prop.type === "unique_id") patch.config = { prefix: prefix.trim() };
    if (prop.type === "button" && label.trim() !== (prop.config.label ?? "Run")) patch.config = { label: label.trim() || "Run" };
    if (prop.type === "formula" && expression !== (prop.config.expression ?? "")) patch.config = { expression };
    if (Object.keys(patch).length === 0 || (await onSave(patch))) onClose();
  };

  const cycle = (c: Tone) => TONES[(TONES.indexOf(c) + 1) % TONES.length];

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Edit ${prop.name}`} className="picker prop-editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="picker-muted">{TYPE_META[prop.type].label}</p>
        {prop.type === "formula" && <FormulaEditor databaseId={prop.databaseId} propertyId={prop.id} value={expression} onChange={setExpression} />}
        {prop.type === "button" && (
          <>
            <label className="field">
              <span>Button label</span>
              <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <p className="picker-muted">What it does is set up under Automations, with a “button is pressed” trigger.</p>
          </>
        )}
        {prop.type === "unique_id" && (
          <label className="field">
            <span>Prefix</span>
            <input value={prefix} maxLength={10} placeholder="For example TASK" onChange={(e) => setPrefix(e.target.value)} />
          </label>
        )}
        {withOptions && (
          <div className="option-editor">
            <div className="picker-group">Options</div>
            {options.map((o, i) => (
              <div className="option-row" key={o.id ?? `new-${i}`}>
                <button
                  type="button"
                  className="swatch-btn"
                  data-tone={o.color}
                  aria-label={`Colour ${o.color}. Change`}
                  title="Change colour"
                  onClick={() => setOptions(options.map((x, j) => (j === i ? { ...x, color: cycle(x.color) } : x)))}
                />
                <input
                  value={o.name}
                  aria-label={`Option ${i + 1} name`}
                  onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                {prop.type === "status" && (
                  <select
                    value={o.group ?? "todo"}
                    aria-label={`${o.name} group`}
                    onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, group: e.target.value as Draft["group"] } : x)))}
                  >
                    {GROUPS.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" className="icon-btn" aria-label={`Remove option ${o.name}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
            <input
              className="picker-add"
              value={fresh}
              placeholder="Add an option"
              aria-label="New option name"
              onChange={(e) => setFresh(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fresh.trim()) {
                  e.preventDefault();
                  e.stopPropagation();
                  setOptions([...options, { name: fresh.trim(), color: "gray", group: "todo" }]);
                  setFresh("");
                }
              }}
            />
          </div>
        )}
        <div className="picker-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </Popover>
  );
}
