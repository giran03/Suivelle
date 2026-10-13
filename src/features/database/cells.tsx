import { useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Property, RecordRow, SelectOption } from "../../types";
import { formatDateValue, formatFormulaValue, formatNumber, formatRollup, formatStamp, linksOf, optionById, uniqueIdLabel } from "./model";

export function Tag({ option, status = false }: { option: SelectOption | undefined; status?: boolean }) {
  if (!option) return <span className="tag unknown">Unknown option</span>;
  return (
    <span className="tag" data-tone={option.color}>
      {status && <i className="tag-dot" aria-hidden="true" />}
      {option.name}
    </span>
  );
}

/** A button cell: pressing it runs the automations wired to this button on this record. */
function ButtonCell({ prop, row }: { prop: Property; row: RecordRow }) {
  const [busy, setBusy] = useState(false);
  const label = prop.config.label?.trim() || "Run";
  const press = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const { notify, setError, bumpData } = useWorkspace.getState();
    setBusy(true);
    try {
      const runs = await ipc.buttonPress(row.id, prop.id);
      const failed = runs.find((r) => r.status === "failed");
      if (failed) setError(`“${failed.automationName}” did not run: ${failed.message}`);
      else notify(runs.length ? `${label}: ${runs.map((r) => r.message).join("; ")}` : `${label}: nothing needed doing`);
      bumpData();
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn cell-button" disabled={busy} onClick={(e) => void press(e)} onDoubleClick={(e) => e.stopPropagation()} aria-label={`${label} (${prop.name}) for ${row.title || "Untitled"}`}>
      <Icon name="play" size={12} />
      {label}
    </button>
  );
}

/** Read-only rendering of one cell. */
export function CellContent({ prop, row }: { prop: Property; row: RecordRow }) {
  const v = row.values[prop.id];
  switch (prop.type) {
    case "title":
      return row.title ? <span className="cell-text">{row.title}</span> : <span className="cell-placeholder">Untitled</span>;
    case "number":
      return typeof v === "number" ? <span className="cell-num">{formatNumber(v)}</span> : null;
    case "checkbox":
      return (
        <span className={`check${v === true ? " on" : ""}`} role="img" aria-label={v === true ? "Checked" : "Unchecked"}>
          {v === true && <Icon name="check" size={12} />}
        </span>
      );
    case "select":
    case "status":
      return typeof v === "string" ? <Tag option={optionById(prop, v)} status={prop.type === "status"} /> : null;
    case "multi_select":
      return Array.isArray(v) ? (
        <span className="tags">
          {v.map((id) => (
            <Tag key={String(id)} option={optionById(prop, id)} />
          ))}
        </span>
      ) : null;
    case "date":
      return v ? <span className="cell-text">{formatDateValue(v)}</span> : null;
    case "created_time":
      return <span className="cell-text cell-muted">{formatStamp(row.createdAt)}</span>;
    case "updated_time":
      return <span className="cell-text cell-muted">{formatStamp(row.updatedAt)}</span>;
    case "unique_id":
      return <span className="cell-text cell-muted">{uniqueIdLabel(prop, row.uniqueId)}</span>;
    case "relation": {
      const links = linksOf(v);
      return links.length ? (
        <span className="tags">
          {links.map((l) => (
            <span key={l.id} className="rel-chip">
              {l.title || "Untitled"}
            </span>
          ))}
        </span>
      ) : null;
    }
    case "rollup": {
      const text = formatRollup(prop, v);
      return text ? <span className={`cell-text${typeof v === "number" ? " cell-num" : ""}`}>{text}</span> : null;
    }
    case "formula": {
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") {
        return (
          <span className={`check${v ? " on" : ""}`} role="img" aria-label={v ? "True" : "False"}>
            {v && <Icon name="check" size={12} />}
          </span>
        );
      }
      if (typeof v === "object" && !Array.isArray(v) && (v as { error?: string }).error) {
        return <span className="cell-error" title={`The formula could not be calculated (${(v as { error: string }).error})`}>{(v as { error: string }).error}</span>;
      }
      const text = formatFormulaValue(v);
      return text ? <span className={`cell-text${typeof v === "number" ? " cell-num" : ""}`}>{text}</span> : null;
    }
    case "button":
      return <ButtonCell prop={prop} row={row} />;
    case "url":
      return typeof v === "string" ? <span className="cell-text cell-link">{v}</span> : null;
    default:
      return typeof v === "string" ? <span className="cell-text">{v}</span> : null;
  }
}

/** A property on a card or list row. Bare values (numbers, text) get the property's name so they are not anonymous. */
export function CardProp({ prop, row }: { prop: Property; row: RecordRow }) {
  const named = ["number", "text", "url", "email", "phone", "unique_id", "formula", "rollup"].includes(prop.type);
  return (
    <>
      {named && <span className="card-prop-name">{prop.name}</span>}
      <CellContent prop={prop} row={row} />
    </>
  );
}
