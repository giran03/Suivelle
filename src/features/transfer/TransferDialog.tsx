import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { ExportPreview } from "./ExportPreview";
import { flushAllEditors } from "../editor/flushRegistry";
import type { ColumnPlan, ExportOptions, ExportShape, ExportWritten, ImportEntry, ImportPreview, ImportResult, ImportTarget, WorkspaceImported } from "../../types";
import { formatBytes } from "../../lib/formatBytes";
import "./transfer.css";
import { DEFAULT_EXPORT, EXPORT_FORMATS, columnKinds, defaultTarget, describeOrigin, effectiveOptions, exportWorkspaceArchive, importedWorkspaceName, plural, savesText, summarize } from "./transfer";
import { useBackupsDialog } from "../backup/store";
import { WorkspaceBadge } from "../workspaces/WorkspaceBadge";
import { syncDialog } from "../../lib/dialog";
import { SuccessCheck } from "../../components/Feedback";
import { PageSlide } from "../../components/PageSlide";

import { useTransferDialog } from "./store";
export { useTransferDialog } from "./store";


const ENTRY_ICON = { page: "page", database: "table", folder: "layers" } as const;

function Columns({ entry, kinds, onChange }: { entry: ImportEntry; kinds: string[]; onChange: (next: string[]) => void }) {
  const cols = entry.columns as ColumnPlan[];
  return (
    <table className="imp-cols">
      <caption className="sr-only">Columns of {entry.name}</caption>
      <thead>
        <tr>
          <th scope="col">Column</th>
          <th scope="col">Becomes</th>
          <th scope="col">Examples</th>
        </tr>
      </thead>
      <tbody>
        {cols.map((c, i) => (
          <tr key={i}>
            <th scope="row">
              {c.name}
              {c.note && <span className="imp-note">{c.note}</span>}
            </th>
            <td>
              {i === 0 ? (
                <span className="picker-muted">Title of each record</span>
              ) : (
                <select aria-label={`Type of ${c.name}`} value={kinds[i] ?? c.kind} onChange={(e) => onChange(kinds.map((k, j) => (j === i ? e.target.value : k)))}>
                  {columnKinds(c.kind).map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              )}
            </td>
            <td className="picker-muted">{c.samples.join(" · ") || "(empty)"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ImportTab({ onDone, workspaceOnly }: { onDone: () => void; workspaceOnly: boolean }) {
  const workspace = useWorkspace((s) => s.workspace);
  const selected = useWorkspace((s) => s.selectedPage);
  const view = useWorkspace((s) => s.view);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [kinds, setKinds] = useState<Record<number, string[]>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [workspaceResult, setWorkspaceResult] = useState<WorkspaceImported | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(true);
  const [target, setTarget] = useState<ImportTarget["kind"]>("container");
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const previewId = useRef<string | null>(null);
  previewId.current = preview?.id ?? null;
  useEffect(() => { void useWorkspace.getState().refreshWorkspaces(); }, []);
  const working = (value: string | null) => { setBusy(value); useTransferDialog.getState().setBusy(!!value); };
  // Imported pages can go under the open page, if it is an ordinary page.
  const host = view === "page" && selected?.kind === "page" ? selected : null;

  // Leaving with a preview open frees what was parsed for it.
  useEffect(
    () => () => {
      if (previewId.current) void ipc.importCancel(previewId.current);
    },
    [],
  );

  const pick = async (mode: "files" | "folder" | "workspace") => {
    working("pick");
    setError(null);
    setResult(null);
    setWorkspaceResult(null);
    try {
      if (preview) void ipc.importCancel(preview.id);
      const p = await ipc.importPick(mode);
      if (p) {
        setPreview(p);
        setNewWorkspace(true);
        setAppearance(true);
        setTarget(defaultTarget(p.origin));
        const existing = useWorkspace.getState().workspaces.map((w) => w.name);
        setName(importedWorkspaceName(p.archive?.workspaceName ?? p.origin?.name ?? "", existing));
        setKinds(Object.fromEntries(p.entries.filter((e) => e.columns).map((e) => [e.index, (e.columns as ColumnPlan[]).map((c) => c.kind)])));
        setOpen(null);
      } else setPreview((cur) => (cur ? null : cur));
    } catch (e) {
      setError(toAppError(e).message);
      setPreview(null);
    } finally {
      working(null);
    }
  };

  const addWorkspace = async (w: NonNullable<ImportResult["workspace"]>) => {
    // The import is already committed. A list refresh failure must not offer a duplicate retry.
    useWorkspace.setState((s) => ({ workspaces: [...s.workspaces.filter((x) => x.id !== w.id), w] }));
    try { await useWorkspace.getState().refreshWorkspaces(); } catch { /* The imported workspace remains available. */ }
  };

  const run = async () => {
    if (!preview || (!workspace && !preview.archive)) return;
    working("apply");
    setError(null);
    try {
      if (preview.archive && newWorkspace) {
        const r = await ipc.workspaceImport(preview.id, name.trim(), appearance);
        setWorkspaceResult(r);
        setPreview(null);
        await addWorkspace(r.workspace);
      } else if (workspace) {
        const to: ImportTarget = preview.archive ? { kind: "container" }
          : target === "workspace" ? { kind: "workspace", name: name.trim() }
          : target === "page" && host ? { kind: "page", pageId: host.id }
          : { kind: "container" };
        const r = await ipc.importApply(workspace.id, preview.id, kinds, to);
        setResult(r);
        setPreview(null);
        if (r.workspace) await addWorkspace(r.workspace);
        else await useWorkspace.getState().reloadTree();
      }
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      working(null);
    }
  };

  const cancel = () => {
    if (preview) void ipc.importCancel(preview.id);
    setPreview(null);
  };

  const openWorkspace = async (id: string) => {
    working("open"); setError(null);
    try { await useWorkspace.getState().switchWorkspace(id); working(null); onDone(); } catch (e) { setError(toAppError(e).message); working(null); }
  };

  if (workspaceResult) return <div className="imp">
    <p className="imp-done" role="status"><SuccessCheck size={16} />Created “{workspaceResult.workspace.name}”.</p>
    <p className="picker-muted">Imported {summarize({ ...workspaceResult.counts, pages: workspaceResult.counts.pages + workspaceResult.counts.dashboards })} into a separate workspace. Your other workspaces are unchanged.</p>
    {!!workspaceResult.counts.automations && <p className="picker-muted">{plural(workspaceResult.counts.automations, "automation", "automations")} imported paused. Enable them when you are ready.</p>}
    {error && <p className="field-error" role="alert">The workspace was imported, but could not be opened: {error}</p>}
    <div className="picker-actions"><button className="btn" type="button" disabled={!!busy} onClick={() => { setWorkspaceResult(null); setError(null); }}>Import another</button><button className="btn primary" type="button" disabled={!!busy} onClick={() => void openWorkspace(workspaceResult.workspace.id)}>{busy === "open" ? "Opening…" : "Open workspace"}</button></div>
  </div>;

  if (result) {
    const made = result.workspace;
    return (
      <div className="imp">
        <p role="status" className="imp-done">
          <SuccessCheck size={16} /> {made ? <>Created “{made.name}” with {summarize(result)}.</> : <>Imported {summarize(result)}.</>}
        </p>
        <p className="picker-muted">{made ? "Your other workspaces are unchanged." : "Everything is under one page, so you can review it and move or delete it as a whole."}</p>
        {result.warnings.length > 0 && (
          <ul className="imp-warn" aria-label="Things to know">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        {error && <p className="field-error" role="alert">The workspace was imported, but could not be opened: {error}</p>}
        <div className="picker-actions">
          <button type="button" className="btn" disabled={!!busy} onClick={() => { setResult(null); setError(null); }}>
            Import more
          </button>
          {made ? (
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => void openWorkspace(made.id)}>
              {busy === "open" ? "Opening…" : "Open workspace"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onDone();
                void useWorkspace.getState().selectPage(result.pageId);
              }}
            >
              Open the imported pages
            </button>
          )}
        </div>
      </div>
    );
  }

  if (preview) {
    const arch = preview.archive;
    const origin = preview.origin;
    const containerName = origin?.kind === "notion" ? "Imported from Notion" : "Imported";
    return (
      <div className="imp">
        {origin?.kind === "notion" && (
          <p className="imp-source">
            <span className="imp-chip"><Icon name="download" size={13} />Notion export</span>
            <span className="picker-muted">{describeOrigin(origin)}</span>
          </p>
        )}
        <p role="status">
          <b>Ready to import</b> {arch ? `the archive “${arch.workspaceName || "Untitled"}”: ` : ""}
          {summarize(preview)} ({formatBytes(preview.bytes)}). Nothing has been changed yet.
        </p>
        {arch && <>
          <div className="imp-workspace-identity"><WorkspaceBadge workspace={{ icon: arch.workspaceIcon ?? null, settingsJson: JSON.stringify(arch.settings ?? {}) }} /><div><strong>{arch.workspaceName || "Untitled workspace"}</strong><span className="picker-muted">{arch.createdAt && !Number.isNaN(Date.parse(arch.createdAt)) ? `Exported ${new Date(arch.createdAt).toLocaleString()}` : "Portable workspace archive"}{arch.appVersion ? ` · Suivelle ${arch.appVersion}` : ""}</span></div></div>
          {!workspaceOnly && <fieldset className="imp-destination" disabled={!!busy}><legend>Import destination</legend><label><input type="radio" name="destination" checked={newWorkspace} onChange={() => setNewWorkspace(true)} />Create a separate workspace</label><label><input type="radio" name="destination" checked={!newWorkspace} disabled={!workspace} onChange={() => setNewWorkspace(false)} />Add pages to “{workspace?.name ?? "current workspace"}”</label></fieldset>}
          {newWorkspace && <fieldset className="imp-workspace-fields" disabled={!!busy}><label className="field"><span>Workspace name</span><input autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label><label className="imp-check"><input type="checkbox" checked={appearance} onChange={(e) => setAppearance(e.target.checked)} />Use this workspace’s icon color and spacing</label><p className="picker-muted">A new workspace will be created. A matching name gets a separate copy.</p></fieldset>}
          {!!arch.counts.automations && <p className="picker-muted">{plural(arch.counts.automations, "automation", "automations")} will be imported paused.</p>}
        </>}
        {!arch && (
          <fieldset className="imp-destination" disabled={!!busy}>
            <legend>Import destination</legend>
            <label><input type="radio" name="target" checked={target === "container"} onChange={() => setTarget("container")} />Inside a new page, “{containerName} …”</label>
            <label><input type="radio" name="target" checked={target === "page"} disabled={!host} onChange={() => setTarget("page")} />{host ? `Inside “${host.title || "Untitled"}”` : "Inside the open page (open an ordinary page first)"}</label>
            <label><input type="radio" name="target" checked={target === "workspace"} onChange={() => setTarget("workspace")} />As a new workspace{origin?.workspace ? ", like the export" : ""}</label>
            {target === "workspace" && (
              <label className="field imp-target-name"><span>Workspace name</span><input maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
            )}
          </fieldset>
        )}
        {preview.warnings.length > 0 && (
          <ul className="imp-warn" aria-label="Things to know">
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        {preview.entries.length > 0 && (
          <ul className="imp-tree" aria-label="What will be created">
            {preview.entries.map((e) => (
              <li key={e.index} style={{ paddingLeft: e.depth * 18 }}>
                <div className="imp-row">
                  <Icon name={ENTRY_ICON[e.kind]} size={14} />
                  <span className="imp-name">{e.name || "Untitled"}</span>
                  <span className="picker-muted">{e.detail}</span>
                  {e.columns && (
                    <button type="button" className="link" aria-expanded={open === e.index} onClick={() => setOpen(open === e.index ? null : e.index)}>
                      {open === e.index ? "Hide columns" : "Columns"}
                    </button>
                  )}
                </div>
                {e.columns && open === e.index && <Columns entry={e} kinds={kinds[e.index] ?? e.columns.map((c) => c.kind)} onChange={(next) => setKinds({ ...kinds, [e.index]: next })} />}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="picker-actions">
          <button type="button" className="btn" disabled={busy === "apply"} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!!busy || (((!!arch && newWorkspace) || (!arch && target === "workspace")) && !name.trim())} onClick={() => void run()}>
            {busy === "apply" ? "Importing…" : (arch && newWorkspace) || (!arch && target === "workspace") ? "Create workspace" : "Import"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="imp">
      <p className="picker-muted">{workspaceOnly ? "Bring a Suivelle workspace from another computer or an exported copy. Preview its contents before creating a separate workspace." : "Bring in a Notion export, Markdown, text, HTML, CSV and PDF files, a whole folder of notes, or a Suivelle archive. You see what will be created before anything changes."}</p>
      <div className="bak-actions">
        <button type="button" className="btn primary" disabled={!!busy} onClick={() => void pick(workspaceOnly ? "workspace" : "files")}>
          {busy === "pick" ? "Reading and verifying…" : workspaceOnly ? "Choose workspace archive…" : "Choose files…"}
        </button>
        {!workspaceOnly && <button type="button" className="btn" disabled={!!busy} onClick={() => void pick("folder")}>
          Choose a folder…
        </button>}
      </div>
      {!workspaceOnly && <ul className="imp-help">
        <li>Notion exports are recognized on their own: choose the zip as Notion saved it, or its unpacked folder. Subpages, databases with their column types, record pages and relations come back as they were; Markdown & CSV and HTML exports both work.</li>
        <li>Markdown and HTML become pages; headings, lists, tasks, code, tables, images and links are kept. Images and files next to them are stored with the page.</li>
        <li>CSV becomes a database. The first column is the title and the types are guessed; you can change them first. A PDF becomes a page that shows it.</li>
        <li>Folders become nested pages, and links between files become page links.</li>
      </ul>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const writtenText = (w: ExportWritten) =>
  `Saved ${w.fileName ? `“${w.fileName}”` : plural(w.files, "file", "files")}${w.fileName && w.files > 1 ? ` with ${plural(w.files, "file", "files")}` : ""}${w.attachments ? ` and ${plural(w.attachments, "attachment", "attachments")}` : ""}.${w.skipped.length ? ` Not included: ${w.skipped.join(" ")}` : ""}`;

/** One switch row of the export form. */
function SwitchRow({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="exp-row">
      <span className="exp-label">
        <span id={`${id}-l`}>{label}</span>
        {hint && <span className="exp-hint" id={`${id}-h`}>{hint}</span>}
      </span>
      <label className="switch">
        <input type="checkbox" role="switch" aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch-track" aria-hidden="true" />
      </label>
    </div>
  );
}

/** The page (or database) export, with the choices of Notion's export dialog. */
function PageExport({ page }: { page: { id: string; title: string; kind: string } }) {
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT);
  const [shape, setShape] = useState<ExportShape | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof ipc.exportPagePreview>> | null>(null);
  const isDatabase = page.kind === "database";
  const eff = effectiveOptions(opts, isDatabase ? "database" : "page");
  const key = JSON.stringify(eff);
  const set = (patch: Partial<ExportOptions>) => { setMessage(null); setOpts((o) => ({ ...o, ...patch })); };

  useEffect(() => {
    let live = true;
    ipc.exportShape(page.id, eff).then((s) => { if (live) setShape(s); }, (e) => { if (live) setError(toAppError(e).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, key]);

  const run = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    useTransferDialog.getState().setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(null);
      useTransferDialog.getState().setBusy(false);
    }
  };
  const save = () => run("save", async () => {
    await flushAllEditors(true);
    const w = await ipc.exportPage(page.id, eff);
    if (w) setPreview(null);
    return w ? writtenText(w) : null;
  });
  const pdf = eff.format === "pdf";
  const subpages = isDatabase ? "Include record pages" : "Include subpages";
  // Nothing below the page: both switches read off, whatever was chosen before.
  const none = !!shape && !shape.hasChildren;

  return (
    <section className="exp-block" aria-label={isDatabase ? "This database" : "This page"}>
      <h3>“{page.title || "Untitled"}”</h3>
      <p className="picker-muted">{isDatabase
        ? "Saved the way Notion exports, so it imports into Notion, or back into Suivelle, with its records, their pages and relations."
        : "Saved the way Notion exports, so it imports into Notion, or back into Suivelle, with its subpages, databases and links."}</p>
      <div className="exp-form">
        <label className="exp-row">
          <span className="exp-label">Export format</span>
          <select value={eff.format} disabled={!!busy} onChange={(e) => set({ format: e.target.value as ExportOptions["format"] })}>
            {EXPORT_FORMATS.filter((f) => !(isDatabase && f.value === "pdf")).map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        {shape?.hasDatabases && !pdf && (
          <label className="exp-row">
            <span className="exp-label">Database rows</span>
            <select value={eff.rows} disabled={!!busy} onChange={(e) => set({ rows: e.target.value as ExportOptions["rows"] })}>
              <option value="all">All rows</option>
              <option value="view">Only rows the first view shows</option>
            </select>
          </label>
        )}
        <label className="exp-row">
          <span className="exp-label">Page content</span>
          <select value={eff.files ? "all" : "text"} disabled={!!busy} onChange={(e) => set({ files: e.target.value === "all" })}>
            <option value="all">Everything</option>
            <option value="text">Without files and images</option>
          </select>
        </label>
        <SwitchRow label={subpages} hint={pdf ? "A PDF holds this page only." : none ? (isDatabase ? "This database has no records yet." : "This page has no subpages.") : undefined} checked={eff.includeSubpages && !none} disabled={!!busy || pdf || none} onChange={(v) => set({ includeSubpages: v })} />
        <SwitchRow label="Create folders for subpages" hint={eff.includeSubpages && !eff.folders && !none ? "Every file sits side by side; links between them still work." : undefined} checked={eff.folders && !none} disabled={!!busy || !eff.includeSubpages || none} onChange={(v) => set({ folders: v })} />
      </div>
      <div className="exp-foot">
        <p className="exp-saves" aria-live="polite">{shape ? savesText(shape, eff) : " "}</p>
        <div className="bak-actions">
          {!pdf && !isDatabase && (
            <button type="button" className="btn" disabled={!!busy} onClick={() => void run("preview", async () => { await flushAllEditors(true); setPreview(await ipc.exportPagePreview(page.id, eff.format === "html" ? "html" : "markdown")); return null; })}>
              {busy === "preview" ? "Preparing…" : "Preview"}
            </button>
          )}
          <button type="button" className="btn primary" disabled={!!busy || !shape} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Export…"}
          </button>
        </div>
      </div>
      {preview && <ExportPreview preview={preview} format={eff.format === "html" ? "html" : "markdown"} busy={!!busy} error={error} onClose={() => setPreview(null)} onSave={() => void save()} />}
      {message && (
        <p role="status" className="imp-done">
          <SuccessCheck size={16} /> {message}
        </p>
      )}
      {error && !preview && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ExportTab({ workspaceOnly, workspaceId }: { workspaceOnly: boolean; workspaceId: string | null }) {
  const workspace = useWorkspace((s) => workspaceId ? s.workspaces.find((w) => w.id === workspaceId) : s.workspace);
  const page = useWorkspace((s) => s.selectedPage);
  const view = useWorkspace((s) => s.view);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = !workspaceOnly && view === "page" ? page : null;

  const run = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    useTransferDialog.getState().setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(null);
      useTransferDialog.getState().setBusy(false);
    }
  };

  return (
    <div className="imp">
      {current && ["page", "record", "database"].includes(current.kind) && <PageExport key={current.id} page={current} />}
      <section className="exp-block" aria-label="The whole workspace">
        <h3>{workspace ? `“${workspace.name}”` : "The whole workspace"}</h3>
        <p className="picker-muted">One ZIP with pages, databases, records, views, templates, dashboards, files, workspace appearance and automation definitions. Pending edits are saved first. Import it to create a separate workspace.</p>
        <p className="picker-muted">Trash, page version history, backups and automation run logs are excluded. For exact installation recovery, <button className="link" type="button" disabled={!!busy} onClick={() => { useTransferDialog.getState().hide(); useBackupsDialog.getState().show(); }}>use Backups</button>.</p>
        <div className="bak-actions">
          <button
            type="button"
            className="btn"
            disabled={!!busy || !workspace}
            onClick={() =>
              void run("zip", async () => {
                const c = workspace ? await exportWorkspaceArchive(workspace.id) : null;
                return c ? `Saved ${c.fileName || "the workspace archive"}: ${plural(c.pages + c.dashboards, "page", "pages")}, ${plural(c.databases, "database", "databases")}, ${plural(c.records, "record", "records")}, ${plural(c.attachments, "attachment", "attachments")}${c.automations ? ` and ${plural(c.automations, "automation", "automations")}` : ""}.` : null;
              })
            }
          >
            {busy === "zip" ? "Saving…" : "Export workspace archive…"}
          </button>
        </div>
      </section>
      {message && (
        <p role="status" className="imp-done">
          <SuccessCheck size={16} /> {message}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Body() {
  const { tab, scope, workspaceId, busy, hide, show } = useTransferDialog();
  return (
    <div className="bak">
      <header className="tpl-head">
        <h2>{scope === "workspace" ? tab === "import" ? "Import workspace" : "Export workspace" : "Import and export"}</h2>
        <button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={hide}>
          <Icon name="close" />
        </button>
      </header>
      <div className="seg" role="group" aria-label="Import or export">
        {(["import", "export"] as const).map((t) => (
          <button key={t} type="button" disabled={busy} aria-pressed={tab === t} className={`seg-btn${tab === t ? " on" : ""}`} onClick={() => show(t, scope, workspaceId ?? undefined)}>
            {t === "import" ? "Import" : "Export"}
          </button>
        ))}
      </div>
      <PageSlide page={tab} order={["import", "export"]}>
        {tab === "import" ? <ImportTab key={scope} onDone={hide} workspaceOnly={scope === "workspace"} /> : <ExportTab key={`${scope}:${workspaceId}`} workspaceOnly={scope === "workspace"} workspaceId={workspaceId} />}
      </PageSlide>
    </div>
  );
}

export function TransferDialog() {
  const open = useTransferDialog((s) => s.open);
  const busy = useTransferDialog((s) => s.busy);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="palette tpl-dialog transfer-dialog"
      aria-label="Import and export"
      aria-busy={busy}
      onCancel={(e) => { e.preventDefault(); useTransferDialog.getState().hide(); }}
      onClose={() => useTransferDialog.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useTransferDialog.getState().hide();
      }}
    >
      {open && <Body />}
    </dialog>
  );
}
