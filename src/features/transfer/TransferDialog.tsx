import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { ExportPreview } from "./ExportPreview";
import { flushAllEditors } from "../editor/flushRegistry";
import type { ColumnPlan, ImportEntry, ImportPreview, ImportResult, WorkspaceImported } from "../../types";
import { formatBytes } from "../../lib/formatBytes";
import "./transfer.css";
import { COLUMN_KINDS, exportWorkspaceArchive, importedWorkspaceName, plural, summarize } from "./transfer";
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
            <th scope="row">{c.name}</th>
            <td>
              {i === 0 ? (
                <span className="picker-muted">Title of each record</span>
              ) : (
                <select aria-label={`Type of ${c.name}`} value={kinds[i] ?? c.kind} onChange={(e) => onChange(kinds.map((k, j) => (j === i ? e.target.value : k)))}>
                  {COLUMN_KINDS.map((k) => (
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
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [kinds, setKinds] = useState<Record<number, string[]>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [workspaceResult, setWorkspaceResult] = useState<WorkspaceImported | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(true);
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const previewId = useRef<string | null>(null);
  previewId.current = preview?.id ?? null;
  useEffect(() => { void useWorkspace.getState().refreshWorkspaces(); }, []);
  const working = (value: string | null) => { setBusy(value); useTransferDialog.getState().setBusy(!!value); };

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
        setName(importedWorkspaceName(p.archive?.workspaceName ?? "", useWorkspace.getState().workspaces.map((w) => w.name)));
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

  const run = async () => {
    if (!preview || (!workspace && !preview.archive)) return;
    working("apply");
    setError(null);
    try {
      if (preview.archive && newWorkspace) {
        const r = await ipc.workspaceImport(preview.id, name.trim(), appearance);
        setWorkspaceResult(r);
        setPreview(null);
        // The import is already committed. A list refresh failure must not offer a duplicate retry.
        useWorkspace.setState((s) => ({ workspaces: [...s.workspaces.filter((w) => w.id !== r.workspace.id), r.workspace] }));
        try { await useWorkspace.getState().refreshWorkspaces(); } catch { /* The imported workspace remains available. */ }
      } else if (workspace) {
        const r = await ipc.importApply(workspace.id, preview.id, kinds);
        setResult(r);
        setPreview(null);
        await useWorkspace.getState().reloadTree();
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

  if (workspaceResult) return <div className="imp">
    <p className="imp-done" role="status"><SuccessCheck size={16} />Created “{workspaceResult.workspace.name}”.</p>
    <p className="picker-muted">Imported {summarize({ ...workspaceResult.counts, pages: workspaceResult.counts.pages + workspaceResult.counts.dashboards })} into a separate workspace. Your other workspaces are unchanged.</p>
    {!!workspaceResult.counts.automations && <p className="picker-muted">{plural(workspaceResult.counts.automations, "automation", "automations")} imported paused. Enable them when you are ready.</p>}
    {error && <p className="field-error" role="alert">The workspace was imported, but could not be opened: {error}</p>}
    <div className="picker-actions"><button className="btn" type="button" disabled={!!busy} onClick={() => { setWorkspaceResult(null); setError(null); }}>Import another</button><button className="btn primary" type="button" disabled={!!busy} onClick={async () => {
      working("open"); setError(null);
      try { await useWorkspace.getState().switchWorkspace(workspaceResult.workspace.id); working(null); onDone(); } catch (e) { setError(toAppError(e).message); working(null); }
    }}>{busy === "open" ? "Opening…" : "Open workspace"}</button></div>
  </div>;

  if (result) {
    return (
      <div className="imp">
        <p role="status" className="imp-done">
          <SuccessCheck size={16} /> Imported {summarize(result)}.
        </p>
        <p className="picker-muted">Everything is under one new page, so you can review it and move or delete it as a whole.</p>
        {result.warnings.length > 0 && (
          <ul className="imp-warn" aria-label="Things to know">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <div className="picker-actions">
          <button type="button" className="btn" onClick={() => setResult(null)}>
            Import more
          </button>
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
        </div>
      </div>
    );
  }

  if (preview) {
    const arch = preview.archive;
    return (
      <div className="imp">
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
          <button type="button" className="btn primary" disabled={!!busy || (!!arch && newWorkspace && !name.trim())} onClick={() => void run()}>
            {busy === "apply" ? "Importing…" : arch && newWorkspace ? "Create workspace" : "Import"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="imp">
      <p className="picker-muted">{workspaceOnly ? "Bring a Suivelle workspace from another computer or an exported copy. Preview its contents before creating a separate workspace." : "Bring in Markdown, text, HTML and CSV files, a whole folder of notes, or a Suivelle archive. You see what will be created before anything changes."}</p>
      <div className="bak-actions">
        <button type="button" className="btn primary" disabled={!!busy} onClick={() => void pick(workspaceOnly ? "workspace" : "files")}>
          {busy === "pick" ? "Reading and verifying…" : workspaceOnly ? "Choose workspace archive…" : "Choose files…"}
        </button>
        {!workspaceOnly && <button type="button" className="btn" disabled={!!busy} onClick={() => void pick("folder")}>
          Choose a folder…
        </button>}
      </div>
      {!workspaceOnly && <ul className="imp-help">
        <li>Markdown and HTML become pages; headings, lists, tasks, code, tables, images and links are kept. Images and files next to them are stored with the page.</li>
        <li>CSV becomes a database. The first column is the title and the types are guessed; you can change them first.</li>
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

function ExportTab({ workspaceOnly }: { workspaceOnly: boolean }) {
  const [preview, setPreview] = useState<{ data:Awaited<ReturnType<typeof ipc.exportPagePreview>>; format:"markdown"|"html" } | null>(null);
  const workspace = useWorkspace((s) => s.workspace);
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

  const writtenText = (w: { files: number; attachments: number; skipped: string[] }) =>
    `Saved ${plural(w.files, "file", "files")}${w.attachments ? ` and ${plural(w.attachments, "attachment", "attachments")}` : ""}.${w.skipped.length ? ` Not included: ${w.skipped.join("; ")}.` : ""}`;

  return (
    <div className="imp">
      {current && (current.kind === "page" || current.kind === "record") && (
        <section className="exp-block" aria-label="This page">
          <h3>“{current.title || "Untitled"}”</h3>
          <p className="picker-muted">The page, its subpages and the files in them. A page with files or subpages is saved into a folder you choose.</p>
          <div className="bak-actions">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void run("md", async () => { await flushAllEditors(true); setPreview({data:await ipc.exportPagePreview(current.id,"markdown"),format:"markdown"}); return null; })}>
              {busy === "md" ? "Saving…" : "Export as Markdown"}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void run("html", async () => { await flushAllEditors(true); setPreview({data:await ipc.exportPagePreview(current.id,"html"),format:"html"}); return null; })}>
              {busy === "html" ? "Saving…" : "Export as HTML"}
            </button>
          </div>
        </section>
      )}
      {preview && current && <ExportPreview preview={preview.data} format={preview.format} busy={!!busy} error={error} onClose={() => setPreview(null)} onSave={() => void run(preview.format, async () => { const written = await ipc.exportPage(current.id,preview.format); if (written) setPreview(null); return fmt(written,writtenText); })} />}
      {current?.kind === "database" && (
        <section className="exp-block" aria-label="This database">
          <h3>“{current.title || "Untitled"}”</h3>
          <p className="picker-muted">Every record as a spreadsheet file: option names, dates and related records as plain text.</p>
          <div className="bak-actions">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void run("csv", async () => ((await ipc.exportDatabase(current.id)) === null ? null : "Saved the CSV file."))}>
              {busy === "csv" ? "Saving…" : "Export as CSV"}
            </button>
          </div>
        </section>
      )}
      <section className="exp-block" aria-label="The whole workspace">
        <h3>{workspace ? `“${workspace.name}”` : "The whole workspace"}</h3>
        <p className="picker-muted">One ZIP with pages, databases, records, views, templates, dashboards, files, workspace appearance and automation definitions. Pending edits are saved first. Import it to create a separate workspace.</p>
        <p className="picker-muted">Trash, page version history, backups and automation run logs are excluded. For exact installation recovery, <button className="link" type="button" disabled={!!busy} onClick={() => { useTransferDialog.getState().hide(); useBackupsDialog.getState().show(); }}>use Backups</button>.</p>
        <div className="bak-actions">
          <button
            type="button"
            className="btn primary"
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

const fmt = (w: { files: number; attachments: number; skipped: string[] } | null, text: (w: { files: number; attachments: number; skipped: string[] }) => string) => (w ? text(w) : null);

function Body() {
  const { tab, scope, busy, hide, show } = useTransferDialog();
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
          <button key={t} type="button" disabled={busy} aria-pressed={tab === t} className={`seg-btn${tab === t ? " on" : ""}`} onClick={() => show(t, scope)}>
            {t === "import" ? "Import" : "Export"}
          </button>
        ))}
      </div>
      <PageSlide page={tab} order={["import", "export"]}>
        {tab === "import" ? <ImportTab key={scope} onDone={hide} workspaceOnly={scope === "workspace"} /> : <ExportTab workspaceOnly={scope === "workspace"} />}
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
