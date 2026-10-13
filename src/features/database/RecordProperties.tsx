import { useEffect, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { Icon } from "../../components/Icon";
import { anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Property, RecordDetail } from "../../types";
import { CellContent } from "./cells";
import { DateEditor, InlineEditor, OptionPicker, RelationPicker } from "./editors";
import { SaveAsTemplate } from "./RecordTemplates";
import { cellText, isOptionType, isPopoverType, linksOf, TYPE_META } from "./model";

/** The properties of one record, shown above its page content. Uses the same editors as the table. */
export function RecordProperties({ pageId }: { pageId: string }) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [editing, setEditing] = useState<{ prop: Property; anchor: Anchor | null } | null>(null);
  const [saving, setSaving] = useState<Anchor | null>(null);
  const setError = useWorkspace((s) => s.setError);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    ipc
      .recordGet(pageId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, [pageId, setError]);

  if (!detail) return null;
  const { record, database } = detail;
  const props = database.properties.filter((p) => p.type !== "title");

  const commit = async (prop: Property, value: unknown) => {
    try {
      setDetail({ ...detail, record: await ipc.recordSetValue(record.id, prop.id, value) });
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const begin = (prop: Property, el: HTMLElement) => {
    if (READ_ONLY || !TYPE_META[prop.type].editable) return;
    if (prop.type === "checkbox") return void commit(prop, record.values[prop.id] !== true);
    setEditing({ prop, anchor: isPopoverType(prop.type) ? anchorOf(el) : null });
  };

  return (
    <section className="rec-props" aria-label="Properties">
      {props.map((prop) => {
        const isEditing = editing?.prop.id === prop.id;
        return (
          <div className="rp-row" key={prop.id}>
            <div className="rp-label">
              <Icon name={TYPE_META[prop.type].icon} size={14} />
              <span>{prop.name}</span>
            </div>
            <div
              className={`rp-value${!READ_ONLY && TYPE_META[prop.type].editable ? " editable" : ""}`}
              role={!READ_ONLY && TYPE_META[prop.type].editable ? "button" : undefined}
              tabIndex={!READ_ONLY && TYPE_META[prop.type].editable && !isEditing ? 0 : undefined}
              aria-label={`${prop.name}: ${cellText(prop, record) || "empty"}`}
              onClick={(e) => !isEditing && begin(prop, e.currentTarget)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && !isEditing) {
                  e.preventDefault();
                  begin(prop, e.currentTarget);
                }
              }}
            >
              {isEditing && !editing.anchor ? (
                <InlineEditor
                  initial={typeof record.values[prop.id] === "string" ? (record.values[prop.id] as string) : typeof record.values[prop.id] === "number" ? String(record.values[prop.id]) : ""}
                  type={prop.type}
                  seeded={false}
                  onDone={(result) => {
                    setEditing(null);
                    if (result) void commit(prop, result.value);
                  }}
                />
              ) : (
                <CellContent prop={prop} row={record} />
              )}
            </div>
          </div>
        );
      })}

      <div className="rp-foot">
        <button type="button" className="link" onClick={(e) => setSaving(anchorOf(e.currentTarget))}>
          Save as template…
        </button>
      </div>
      {saving && <SaveAsTemplate databaseId={database.database.id} recordId={record.id} title={record.title} anchor={saving} onClose={() => setSaving(null)} />}
      {editing?.anchor && isOptionType(editing.prop.type) && (
        <OptionPicker
          prop={editing.prop}
          current={record.values[editing.prop.id]}
          multi={editing.prop.type === "multi_select"}
          anchor={editing.anchor}
          onChange={(v) => void commit(editing.prop, v)}
          onCreate={async (name) => {
            try {
              const opts = (editing.prop.config.options ?? []).map((o) => ({ ...o }));
              const updated = await ipc.propertyUpdate({ id: editing.prop.id, config: { options: [...opts, { name, color: "gray", group: "todo" }] } });
              setDetail({ ...detail, database: { ...database, properties: database.properties.map((p) => (p.id === updated.id ? updated : p)) } });
              return updated.config.options?.find((o) => o.name === name) ?? null;
            } catch (e) {
              setError(toAppError(e).message);
              return null;
            }
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.anchor && editing.prop.type === "relation" && (
        <RelationPicker
          prop={editing.prop}
          current={linksOf(record.values[editing.prop.id])}
          anchor={editing.anchor}
          excludeId={record.id}
          onChange={(ids) => void commit(editing.prop, ids)}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.anchor && editing.prop.type === "date" && (
        <DateEditor current={record.values[editing.prop.id]} anchor={editing.anchor} onChange={(v) => void commit(editing.prop, v)} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}
