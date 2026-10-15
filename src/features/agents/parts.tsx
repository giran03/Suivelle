import { useState } from "react";
import { copyText } from "../../components/editingMenu";
import { MODE_LABELS, TOOL_GROUP_LABELS, TOOL_GROUPS, type AgentMode, type ToolGroup } from "./types";

export const MODES: AgentMode[] = ["propose", "auto", "write"];

export const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

export function Copy({ text, label, block }: { text: string; label: string; block?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className={`agx-copy${block ? " block" : ""}`}>
      {block ? <pre>{text}</pre> : <code>{text}</code>}
      <button type="button" className="btn" aria-label={label} onClick={() => { void copyText(text); setDone(true); window.setTimeout(() => setDone(false), 1500); }}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function ModePicker({ value, onChange, label }: { value: AgentMode; onChange: (m: AgentMode) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} className={value === m ? "on" : ""} title={MODE_LABELS[m].hint} onClick={() => onChange(m)}>{MODE_LABELS[m].title}</button>
      ))}
    </div>
  );
}

export function WorkspaceChecks({ workspaces, value, onChange }: { workspaces: { id: string; name: string }[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="agx-checks">
      {workspaces.map((w) => <label key={w.id} className="check-row"><input type="checkbox" checked={value.includes(w.id)} onChange={(e) => onChange(toggle(value, w.id, e.target.checked))} />{w.name}</label>)}
    </div>
  );
}

export function ToolChecks({ value, onChange }: { value: ToolGroup[]; onChange: (tools: ToolGroup[]) => void }) {
  return (
    <div className="agx-checks">
      {TOOL_GROUPS.map((g) => <label key={g} className="check-row"><input type="checkbox" checked={value.includes(g)} onChange={(e) => onChange(toggle<ToolGroup>(value, g, e.target.checked))} />{TOOL_GROUP_LABELS[g]}</label>)}
    </div>
  );
}
