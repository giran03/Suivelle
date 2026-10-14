import { useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { RecordLink, RecordTemplate, RecordRow } from "../../types";
import { SearchField } from "../../components/SearchField";
import { useTemplateGallery } from "../templates/store";
import { rememberTaskDestination, savedTaskRelations, taskDestinations, type TaskDestination } from "./projectTasks";
import { usePalette } from "./store";

/** Staged action inside the existing palette; no page or task is created until submission. */
export function ProjectTaskAction() {
  const workspaceId = useWorkspace(s => s.workspace?.id);
  const owner = useRef(workspaceId).current;
  const [destinations, setDestinations] = useState<TaskDestination[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [mapping, setMapping] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<RecordLink[]>([]);
  const [project, setProject] = useState<RecordLink | null>(null);
  const [title, setTitle] = useState("");
  const [templates, setTemplates] = useState<RecordTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templatesReady, setTemplatesReady] = useState(false);
  const [created, setCreated] = useState<RecordRow | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const destination = destinations.find(d => d.propertyId === destinationId);
  const projectList = useRef<HTMLDivElement>(null);
  const choices = mapping ? destinations : destinations.filter(d => known.includes(d.propertyId));
  useEffect(() => { projectList.current?.querySelector(`#task-project-${active}`)?.scrollIntoView?.({ block: "nearest" }); }, [active]);

  useEffect(() => { if (workspaceId !== owner) { usePalette.getState().setBusy(false); usePalette.getState().hide(); } }, [workspaceId, owner]);
  useEffect(() => {
    let live = true;
    (async () => {
      if (!owner) throw new Error("Open a workspace first.");
      const [refs, workspace] = await Promise.all([ipc.databaseList(owner), ipc.workspaceGet(owner)]);
      if (!workspace) throw new Error("This workspace is no longer available.");
      const details = await Promise.all(refs.map(d => ipc.databaseGet(d.pageId)));
      const paths = Object.fromEntries(await Promise.all(refs.map(async d => [d.pageId, (await ipc.pageAncestors(d.pageId)).map(p => p.title || "Untitled").concat(d.title).join(" / ")])));
      if (!live) return;
      const all = taskDestinations(details, paths);
      const ids = savedTaskRelations(workspace.settingsJson).filter(id => all.some(d => d.propertyId === id));
      setDestinations(all); setKnown(ids); setMapping(!ids.length);
      setDestinationId(ids[0] ?? all[0]?.propertyId ?? "");
    })().catch(e => { if (live) setError(toAppError(e).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [owner]);

  useEffect(() => {
    if (!destination || mapping || project || created) return;
    let live = true;
    setLoading(true); setProjects([]); setActive(0); setError(null);
    const timer = window.setTimeout(() => {
      ipc.recordLookup(destination.projectDatabaseId, query, 50).then(rows => { if (live) setProjects(rows); }, e => { if (live) setError(toAppError(e).message); }).finally(() => { if (live) setLoading(false); });
    }, 80);
    return () => { live = false; window.clearTimeout(timer); };
  }, [destination, mapping, query, project, created]);

  useEffect(() => {
    if (!destination || !project) return;
    let live = true;
    setTemplates([]); setTemplateId(""); setLoading(true); setTemplatesReady(false);
    ipc.recordTemplateList(destination.databaseId).then(items => { if (live) { setTemplates(items); setTemplateId(items.find(t => t.isDefault)?.id ?? ""); setTemplatesReady(true); } }, e => { if (live) setError(toAppError(e).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [destination, project]);

  const saveMapping = async () => {
    if (!owner || !destination || working.current) return;
    working.current = true; setBusy(true); setError(null);
    usePalette.getState().setBusy(true);
    try {
      if (useWorkspace.getState().workspace?.id !== owner) throw new Error("The workspace changed.");
      const updated = await rememberTaskDestination(owner, destination.propertyId);
      if (useWorkspace.getState().workspace?.id !== owner) return;
      useWorkspace.setState(s => ({ workspace: updated, workspaces: s.workspaces.map(w => w.id === updated.id ? updated : w) }));
      setKnown(savedTaskRelations(updated.settingsJson)); setMapping(false);
    } catch (e) { setError(toAppError(e).message); }
    finally { working.current = false; setBusy(false); usePalette.getState().setBusy(false); }
  };
  const create = async () => {
    if (!owner || !destination || !project || !title.trim() || loading || !templatesReady || working.current) return;
    working.current = true; setBusy(true); setError(null);
    usePalette.getState().setBusy(true);
    try {
      if (useWorkspace.getState().workspace?.id !== owner) throw new Error("The workspace changed.");
      // recordCreate validates the relation target and writes the task and reverse relation atomically.
      const row = await ipc.recordCreate({ databaseId: destination.databaseId, title: title.trim(), templateId: templateId || null, values: { [destination.propertyId]: [project.id] } });
      if (useWorkspace.getState().workspace?.id !== owner) return;
      setCreated(row);
      void useWorkspace.getState().reloadTree().catch(() => useWorkspace.getState().notify("Task created. Reopen the sidebar to refresh its pages."));
    } catch (e) { setError(toAppError(e).message); }
    finally { working.current = false; setBusy(false); usePalette.getState().setBusy(false); }
  };
  const back = () => { setProject(null); setCreated(null); setError(null); setTitle(""); };
  return <div className="project-task-action" onKeyDown={e => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Escape" && project && !created) { e.preventDefault(); e.stopPropagation(); if (!busy) back(); }
  }}>
    <h2>{created ? "Task created" : "Create task in project"}</h2>
    {error && <p className="field-error" role="alert">{error}</p>}
    {created ? <>
      <p role="status">“{created.title}” was added to “{project?.title || "Untitled"}”.</p>
      <button autoFocus type="button" className="btn primary" onClick={() => { usePalette.getState().hide(); void useWorkspace.getState().openPage(created.pageId); }}>Open task</button>
      <button type="button" className="btn" onClick={() => usePalette.getState().hide()}>Done</button>
    </> : <>
      {loading && !destinations.length && <p role="status">Loading project destinations…</p>}
      {!loading && !destinations.length && <>
        <p>No task-to-project relation is available. Use a project starter, or add a relation between your task and project databases.</p>
        <button type="button" className="btn" onClick={() => { usePalette.getState().hide(); useTemplateGallery.getState().show(); }}>Pick a project template</button>
      </>}
      {!!destinations.length && <>
        <label className="task-destination">{mapping ? "Choose task database → project relation" : "Task destination"}
          <select autoFocus={mapping} value={destinationId} disabled={busy || !!project} onChange={e => { setDestinationId(e.target.value); setError(null); }}>
            {choices.map(d => <option key={d.propertyId} value={d.propertyId}>{d.label}</option>)}
          </select>
        </label>
        {mapping ? <>
          <p className="picker-muted">Tasks will be created in the database on the left, linked through this relation. This choice is saved for this workspace.</p>
          <button type="button" className="btn primary" disabled={busy || !destination} onClick={() => void saveMapping()}>{busy ? "Saving…" : "Use this destination"}</button>
        </> : project ? <form onSubmit={e => { e.preventDefault(); void create(); }}>
          <p>Project: <b>{project.title || "Untitled"}</b></p>
          <label>Task title<input autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={500} disabled={busy} required /></label>
          {!!templates.length && <label>Task template<select value={templateId} disabled={busy || loading} onChange={e => setTemplateId(e.target.value)}><option value="">No template</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
          <div className="bak-actions"><button type="submit" className="btn primary" disabled={busy || loading || !templatesReady || !title.trim()}>{busy ? "Creating…" : "Create task"}</button><button type="button" className="btn" disabled={busy} onClick={back}>Back to projects</button></div>
        </form> : <>
          <SearchField autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a project" aria-label="Find a project" role="combobox" aria-expanded="true" aria-controls="task-projects" aria-activedescendant={projects.length ? `task-project-${active}` : undefined} onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a + (e.key === "ArrowDown" ? 1 : projects.length - 1)) % Math.max(projects.length, 1)); }
            if (e.key === "Enter" && projects[active] && !loading) { e.preventDefault(); setProject(projects[active]); }
          }} />
          <div ref={projectList} id="task-projects" role="listbox" aria-label="Projects" aria-busy={loading} className="palette-list">
            {projects.map((p, i) => <div key={p.id} id={`task-project-${i}`} role="option" aria-selected={active === i} className={`palette-item${active === i ? " active" : ""}`} onMouseMove={() => setActive(i)} onClick={() => setProject(p)}><span className="pi-text"><span className="pi-title">{p.title || "Untitled"}</span><span className="pi-sub">{destination?.label} · {p.id.slice(0, 8)}</span></span></div>)}
            {!loading && !projects.length && <p className="palette-note">{query ? "No projects match. Try another name." : "This project database has no records yet. Create a project first."}</p>}
          </div>
          <button type="button" className="btn" onClick={() => { setMapping(true); setQuery(""); setProjects([]); }}>Choose another destination…</button>
        </>}
      </>}
    </>}
  </div>;
}
