import { useEffect, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DatabaseRef, Property, PropertyType, RollupFunction } from "../../types";
import { FormulaEditor } from "./FormulaEditor";
import { ADDABLE_TYPES, ROLLUP_FUNCTIONS, TYPE_META } from "./model";

/** Name, type and (for relations and rollups) the extra choices needed to add a property. */
export function NewProperty({
  databaseId,
  properties,
  onAdd,
}: {
  databaseId: string;
  properties: Property[];
  onAdd: (name: string, type: PropertyType, config?: unknown) => Promise<unknown>;
}) {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const setError = useWorkspace((s) => s.setError);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");

  const [expression, setExpression] = useState("");
  // relation
  const [databases, setDatabases] = useState<DatabaseRef[]>([]);
  const [target, setTarget] = useState("");
  const [twoWay, setTwoWay] = useState(true);
  // rollup
  const relations = properties.filter((p) => p.type === "relation" && p.config.targetDatabaseId);
  const [relationId, setRelationId] = useState("");
  const [targetProps, setTargetProps] = useState<Property[]>([]);
  const [targetPropId, setTargetPropId] = useState("");
  const [fn, setFn] = useState<RollupFunction>("count");

  const needsDatabases = type === "relation" || type === "rollup";
  useEffect(() => {
    if (!needsDatabases || !workspaceId) return;
    let cancelled = false;
    ipc
      .databaseList(workspaceId)
      .then((d) => {
        if (cancelled) return;
        setDatabases(d);
        setTarget((t) => t || d[0]?.id || "");
      })
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, [needsDatabases, workspaceId, setError]);

  const relation = relations.find((p) => p.id === (relationId || relations[0]?.id));
  const relationTargetPage = databases.find((d) => d.id === relation?.config.targetDatabaseId)?.pageId;
  useEffect(() => {
    if (type !== "rollup" || !relationTargetPage) return;
    let cancelled = false;
    ipc
      .databaseGet(relationTargetPage)
      .then((d) => {
        if (cancelled) return;
        const usable = d.properties.filter((p) => p.type !== "relation" && p.type !== "rollup");
        setTargetProps(usable);
        setTargetPropId((id) => (usable.some((p) => p.id === id) ? id : (usable[0]?.id ?? "")));
      })
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, [type, relationTargetPage, setError]);

  const targetProp = targetProps.find((p) => p.id === targetPropId);
  const functions = ROLLUP_FUNCTIONS.filter((f) => !targetProp || f.accepts(targetProp.type));
  const fnValue = functions.some((f) => f.value === fn) ? fn : (functions[0]?.value ?? "count");

  const ready = name.trim() && (type === "relation" ? !!target : type === "rollup" ? !!relation && !!targetProp : true);

  const submit = async () => {
    if (!ready) return;
    let config: unknown;
    if (type === "relation") config = { targetDatabaseId: target, twoWay };
    if (type === "formula") config = { expression };
    if (type === "rollup" && relation && targetProp) config = { relationPropertyId: relation.id, targetPropertyId: targetProp.id, function: fnValue };
    const added = await onAdd(name.trim(), type, config);
    if (added) {
      setName("");
      setExpression("");
    }
  };

  return (
    <form
      className="new-prop"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="picker-group">New property</div>
      <div className="cond">
        <input value={name} maxLength={60} placeholder="Name" aria-label="New property name" onChange={(e) => setName(e.target.value)} />
        <select aria-label="New property type" value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
          {ADDABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_META[t].label}
            </option>
          ))}
        </select>
        <button type="submit" className="btn primary" disabled={!ready}>
          Add
        </button>
      </div>
      {type === "formula" && (
        <div className="new-prop-extra">
          <FormulaEditor databaseId={databaseId} value={expression} onChange={setExpression} />
        </div>
      )}
      {type === "relation" && (
        <div className="new-prop-extra">
          <label className="field">
            <span>Related database</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || "Untitled"}
                  {d.id === databaseId ? " (this database)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
            Also show this relation on the related database
          </label>
        </div>
      )}
      {type === "rollup" &&
        (relations.length === 0 ? (
          <p className="picker-muted">Add a relation property first; a rollup summarizes the records it links to.</p>
        ) : (
          <div className="new-prop-extra">
            <label className="field">
              <span>Relation</span>
              <select value={relation?.id ?? ""} onChange={(e) => setRelationId(e.target.value)}>
                {relations.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Property</span>
              <select value={targetPropId} onChange={(e) => setTargetPropId(e.target.value)}>
                {targetProps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Calculate</span>
              <select value={fnValue} onChange={(e) => setFn(e.target.value as RollupFunction)}>
                {functions.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
    </form>
  );
}
