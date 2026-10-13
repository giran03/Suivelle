import "../../lib/legacy";
import { useEffect, useState } from "react";
import { Collapse } from "../../components/Collapse";
import { Icon } from "../../components/Icon";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Backlink } from "../../types";

const STORAGE_KEY = "suivelle.backlinks.open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Pages that mention or link to this page. Renders nothing when there are none. */
export function Backlinks({ pageId }: { pageId: string }) {
  const [links, setLinks] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(readOpen);

  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    ipc
      .pageBacklinks(pageId)
      .then((l) => !cancelled && setLinks(l))
      .catch(() => !cancelled && setLinks([]));
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (!links.length) return null;
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(STORAGE_KEY, o ? "0" : "1");
      } catch {
        // a per-viewer convenience only
      }
      return !o;
    });
  };

  return (
    <section className="backlinks" aria-label="Backlinks">
      <button type="button" className="backlinks-head" aria-expanded={open} onClick={toggle}>
        <span className={`bl-chevron${open ? " open" : ""}`}>
          <Icon name="chevron" size={14} />
        </span>
        Backlinks
        <span className="bl-count">{links.length}</span>
      </button>
      <Collapse open={open}>
        <ul className="bl-list">
          {links.map((l) => (
            <li key={`${l.sourceBlockId}`}>
              <button type="button" className="bl-item" onClick={() => void useWorkspace.getState().openPage(l.sourcePageId, l.sourceBlockId)}>
                <span className="bl-title">
                  <Icon name="page" size={14} />
                  {l.sourcePageTitle || "Untitled"}
                  {l.parentTitle && <span className="bl-path">in {l.parentTitle}</span>}
                </span>
                {l.snippet && <span className="bl-snippet">{l.snippet}</span>}
              </button>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
