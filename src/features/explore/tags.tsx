import { useEffect, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { PageGlyph } from "../pages/PageGlyph";
import type { PageTitle, TagCount } from "../../types";
import { useExplore } from "./store";

/** Every #tag written in the workspace, and the pages that use the chosen one. */
export function TagsPanel() {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const chosen = useExplore((s) => s.tag);
  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [pages, setPages] = useState<PageTitle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (workspaceId) ipc.tagList(workspaceId).then(setTags, (e) => setError(toAppError(e).message)); }, [workspaceId]);
  useEffect(() => {
    setPages(null);
    if (workspaceId && chosen) ipc.tagPages(workspaceId, chosen).then(setPages, (e) => setError(toAppError(e).message));
  }, [workspaceId, chosen]);

  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!tags) return <p className="picker-muted" role="status">Collecting tags…</p>;
  if (!tags.length) return <p className="picker-muted">No tags yet. Write #something in any page and it shows up here.</p>;
  return <div className="explore-tags">
    <div className="tag-cloud" role="group" aria-label="Tags">
      {tags.map((t) => <button key={t.tag} type="button" className={`tag-chip${t.tag === chosen ? " on" : ""}`} aria-pressed={t.tag === chosen}
        onClick={() => useExplore.getState().show("tags", t.tag)}>#{t.tag} <small>{t.pages}</small></button>)}
    </div>
    {chosen && <ul className="explore-list" aria-label={`Pages tagged #${chosen}`}>
      {(pages ?? []).map((p) => <li key={p.id}>
        <button type="button" className="explore-row" onClick={() => { useExplore.getState().hide(); void useWorkspace.getState().selectPage(p.id); }}>
          <PageGlyph page={{ icon: p.icon, kind: "page" }} size={16} />
          <span className="explore-row-main">{p.title || "Untitled"}</span>
        </button>
      </li>)}
      {!pages && <li className="picker-muted" role="status">Loading…</li>}
    </ul>}
  </div>;
}
