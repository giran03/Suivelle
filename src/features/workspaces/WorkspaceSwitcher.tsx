import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyText } from "../../components/editingMenu";
import { useWorkspace } from "../../stores/workspace";
import { toAppError } from "../../lib/ipc";
import { useWorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceBadge } from "./WorkspaceBadge";
import { workspaceOptions } from "./model";
import { SearchField } from "../../components/SearchField";
import { useTransferDialog } from "../transfer/store";

export function WorkspaceSwitcher() {
  const workspace = useWorkspace((s) => s.workspace);
  const workspaces = useWorkspace((s) => s.workspaces);
  const busy = useWorkspace((s) => s.workspaceBusy);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const show = (mode: "manage" | "create" | "delete") => { setAnchor(null); useWorkspaceDialog.getState().show(mode); };
  const items: MenuItem[] = [
    { label: "Workspace settings…", onSelect: () => show("manage") },
    { label: "New workspace…", onSelect: () => show("create") },
    { label: "Import workspace…", onSelect: () => { setAnchor(null); useTransferDialog.getState().show("import", "workspace"); } },
    { label: "Export workspace…", onSelect: () => { setAnchor(null); useTransferDialog.getState().show("export", "workspace"); } },
    { label: "Copy workspace name", onSelect: () => void copyText(workspace?.name ?? "") },
    { label: "Delete workspace…", danger: true, separated: true, disabled: workspaces.length <= 1, onSelect: () => show("delete") },
  ];
  return <>
    <button className="ws-switcher" type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={!!anchor} aria-label={`Workspace: ${workspace?.name ?? "Workspace"}. Switch or manage workspaces`} onClick={(e) => { setSearch(""); setError(null); setAnchor(anchor ? null : anchorOf(e.currentTarget)); void useWorkspace.getState().refreshWorkspaces(); }} onContextMenu={(e) => { e.preventDefault(); if (!busy) setMenu({ x: e.clientX, y: e.clientY }); }}>
      <WorkspaceBadge workspace={workspace} /><span className="ws-name">{workspace?.name ?? "Workspace"}</span><Icon name="chevron" size={14} />
    </button>
    {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} label="Switch workspace" className="ws-switch-popover">
      <p className="ws-switch-heading">Workspaces on this computer</p>
      {workspaces.length > 5 && <SearchField type="search" aria-label="Find workspace" placeholder="Find a workspace…" value={search} onChange={(e) => setSearch(e.target.value)} />}
      <ul className="ws-switch-list">{workspaces.filter((w) => w.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((w) => <li key={w.id}><button type="button" className="ws-directory-row" aria-current={w.id === workspace?.id ? "true" : undefined} disabled={busy} onClick={async () => { if (w.id === workspace?.id) { setAnchor(null); return; } try { await useWorkspace.getState().switchWorkspace(w.id); setAnchor(null); } catch (e) { setError(toAppError(e).message); } }}><WorkspaceBadge workspace={w} /><span className="ws-directory-name">{w.name}<small>{workspaceOptions(w).description || "Local workspace"}</small></span>{w.id === workspace?.id && <Icon name="check" size={14} />}</button></li>)}</ul>
      {workspaces.every((w) => !w.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="picker-muted">No matching workspace.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="ws-switch-actions"><button type="button" className="btn" disabled={busy} onClick={() => show("create")}><Icon name="plus" size={14} />New workspace</button><button type="button" className="btn" disabled={busy} onClick={() => show("manage")}>Settings…</button></div>
      <div className="ws-switch-actions"><button type="button" className="btn" disabled={busy} onClick={() => { setAnchor(null); useTransferDialog.getState().show("import", "workspace"); }}><Icon name="download" size={14} />Import workspace…</button><button type="button" className="btn" disabled={busy} onClick={() => { setAnchor(null); useTransferDialog.getState().show("export", "workspace"); }}>Export workspace…</button></div>
    </Popover>}
    {menu && <ContextMenu {...menu} items={items} onClose={() => setMenu(null)} />}
  </>;
}
