import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyText } from "../../components/editingMenu";
import { useWorkspace } from "../../stores/workspace";
import { toAppError } from "../../lib/ipc";
import { useWorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceList } from "./WorkspaceList";
import { WorkspaceBadge } from "./WorkspaceBadge";
import { workspaceOptions } from "./model";
import { SearchField } from "../../components/SearchField";
import { useTransferDialog } from "../transfer/store";

export function WorkspaceSwitcher({ iconOnly = false }: { iconOnly?: boolean }) {
  const workspace = useWorkspace((s) => s.workspace);
  const workspaces = useWorkspace((s) => s.workspaces);
  const busy = useWorkspace((s) => s.workspaceBusy);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const show = (mode: "manage" | "create" | "delete") => { setAnchor(null); useWorkspaceDialog.getState().show(mode); };
  const items: MenuItem[] = [
    { label: "Workspace settings…", shortcut: "workspace-settings", onSelect: () => show("manage") },
    { label: "New workspace…", shortcut: "new-workspace", onSelect: () => show("create") },
    { label: "Import workspace…", shortcut: "import-workspace", onSelect: () => { setAnchor(null); useTransferDialog.getState().show("import", "workspace"); } },
    { label: "Export workspace…", shortcut: "export-workspace", onSelect: () => { setAnchor(null); useTransferDialog.getState().show("export", "workspace"); } },
    { label: "Copy workspace name", onSelect: () => void copyText(workspace?.name ?? "") },
    { label: "Delete workspace…", danger: true, separated: true, disabled: workspaces.length <= 1, onSelect: () => show("delete") },
  ];
  return <>
    <button className="ws-switcher" type="button" title={iconOnly ? `Workspace: ${workspace?.name ?? "Workspace"}` : undefined} disabled={busy} aria-haspopup="dialog" aria-expanded={!!anchor} aria-label={`Workspace: ${workspace?.name ?? "Workspace"}. Switch or manage workspaces`} onClick={(e) => { setSearch(""); setError(null); setAnchor(anchor ? null : anchorOf(e.currentTarget)); void useWorkspace.getState().refreshWorkspaces(); }} onContextMenu={(e) => { e.preventDefault(); if (!busy) setMenu({ x: e.clientX, y: e.clientY }); }}>
      <WorkspaceBadge workspace={workspace} />{!iconOnly && <><span className="ws-name">{workspace?.name ?? "Workspace"}</span><Icon name="chevron" size={14} /></>}
    </button>
    {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} label="Switch workspace" className="ws-switch-popover">
      <p className="ws-switch-heading">Workspaces on this computer</p>
      {workspaces.length > 5 && <SearchField type="search" aria-label="Find workspace" placeholder="Find a workspace…" value={search} onChange={(e) => setSearch(e.target.value)} />}
      <WorkspaceList className="ws-switch-list" disabled={busy || !!search} workspaces={workspaces.filter((w) => w.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))}>{(w) => <button type="button" className="ws-directory-row" aria-current={w.id === workspace?.id ? "true" : undefined} disabled={busy} onClick={async () => { if (w.id === workspace?.id) { setAnchor(null); return; } try { await useWorkspace.getState().switchWorkspace(w.id); setAnchor(null); } catch (e) { setError(toAppError(e).message); } }}><WorkspaceBadge workspace={w} /><span className="ws-directory-name">{w.name}<small>{workspaceOptions(w).description || "Local workspace"}</small></span>{w.id === workspace?.id && <Icon name="check" size={14} />}</button>}</WorkspaceList>
      {workspaces.every((w) => !w.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="picker-muted">No matching workspace.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="ws-switch-actions" role="group" aria-label="Workspace actions">
        <button type="button" className="icon-btn" aria-label="New workspace" title="New workspace" disabled={busy} onClick={() => show("create")}><Icon name="plus" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Workspace settings" title="Workspace settings" disabled={busy} onClick={() => show("manage")}><Icon name="gear" size={18} /></button>
        <span className="ws-switch-action-space" aria-hidden="true" />
        <button type="button" className="icon-btn" aria-label="Import workspace" title="Import workspace" disabled={busy} onClick={() => { setAnchor(null); useTransferDialog.getState().show("import", "workspace"); }}><Icon name="download" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Export workspace" title="Export workspace" disabled={busy} onClick={() => { setAnchor(null); useTransferDialog.getState().show("export", "workspace"); }}><Icon name="upload" size={18} /></button>
      </div>
    </Popover>}
    {menu && <ContextMenu {...menu} items={items} onClose={() => setMenu(null)} />}
  </>;
}
