import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page, TemplateInfo } from "../../types";
import { PageGlyph } from "../pages/PageGlyph";
import { createFromPageTemplate, listPageTemplates } from "./pageTemplates";
import { syncDialog } from "../../lib/dialog";

import { useTemplateGallery } from "./store";
export { useTemplateGallery } from "./store";


const ICONS: Record<string, IconName> = { project_manager: "timeline", task_tracker: "todo", software_project: "code" };

function GalleryBody() {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [mine, setMine] = useState<Page[] | null>(null);
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createFromTemplate = useWorkspace((s) => s.createFromTemplate);
  const hide = useTemplateGallery((s) => s.hide);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .templateList()
      .then((t) => !cancelled && setTemplates(t))
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listPageTemplates()
      .then((t) => !cancelled && setMine(t))
      .catch(() => !cancelled && setMine([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (templates && mine) first.current?.focus();
  }, [templates, mine]);

  const pickMine = async (id: string) => {
    setBusy(id);
    setError(null);
    const message = await createFromPageTemplate(id);
    if (message) {
      setError(message);
      setBusy(null);
    } else hide();
  };

  const pick = async (id: string) => {
    setBusy(id);
    setError(null);
    const message = await createFromTemplate(id, sample);
    if (message) {
      setError(message);
      setBusy(null);
    } else hide();
  };

  return (
    <div className="tpl">
      <header className="tpl-head">
        <h2>New from template</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={hide}>
          <Icon name="close" />
        </button>
      </header>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <h3 className="tpl-section">Your page templates</h3>
      {mine && mine.length === 0 && <p className="picker-muted">Save any page as a template from its menu in the sidebar, and it will appear here.</p>}
      <ul className="tpl-list" aria-busy={!mine}>
        {mine?.map((t, i) => (
          <li key={t.id} className="tpl-mine">
            <button type="button" ref={i === 0 ? first : undefined} className="tpl-card" disabled={busy !== null} onClick={() => void pickMine(t.id)}>
              <PageGlyph page={t} size={20} />
              <span className="tpl-text">
                <b>{t.title || "Untitled"}</b>
              </span>
              {busy === t.id && <span className="picker-muted">Creating…</span>}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Edit the template ${t.title || "Untitled"}`}
              title="Edit this template"
              onClick={() => {
                hide();
                void useWorkspace.getState().selectPage(t.id);
              }}
            >
              <Icon name="edit" />
            </button>
          </li>
        ))}
      </ul>
      <h3 className="tpl-section">Project starters</h3>
      <p className="picker-muted">Each starter builds ordinary databases you can rename, extend or delete.</p>
      <ul className="tpl-list" aria-busy={!templates}>
        {templates?.map((t, i) => (
          <li key={t.id}>
            <button type="button" ref={mine && mine.length === 0 && i === 0 ? first : undefined} className="tpl-card" disabled={busy !== null} onClick={() => void pick(t.id)}>
              <Icon name={ICONS[t.id] ?? "page"} size={20} />
              <span className="tpl-text">
                <b>{t.name}</b>
                <span>{t.blurb}</span>
                <small>{t.databases.join(" · ")}</small>
              </span>
              {busy === t.id && <span className="picker-muted">Creating…</span>}
            </button>
          </li>
        ))}
      </ul>
      <label className="check-row">
        <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} />
        Add a few example records
      </label>
    </div>
  );
}

export function TemplateGallery() {
  const open = useTemplateGallery((s) => s.open);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="palette tpl-dialog"
      aria-label="New from template"
      onClose={() => useTemplateGallery.getState().hide()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useTemplateGallery.getState().hide();
      }}
    >
      {open && <GalleryBody />}
    </dialog>
  );
}
