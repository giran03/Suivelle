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

/** A table row as "Header: cell" pairs, so a hit in a table reads as a record rather than a run of words. */
function RowContext({ link }: { link: Backlink }) {
  return (
    <span className="bl-row">
      {link.cells.map((cell, i) => {
        if (!cell) return null;
        const head = link.header[i];
        return (
          <span key={i} className="bl-cell">
            {head && <span className="bl-cell-head">{head}</span>}
            {cell}
          </span>
        );
      })}
    </span>
  );
}

function Items({ links }: { links: Backlink[] }) {
  return (
    <ul className="bl-list">
      {links.map((l) => (
        <li key={`${l.sourceBlockId}:${l.rowIndex ?? ""}`}>
          <button type="button" className="bl-item" onClick={() => void useWorkspace.getState().openPage(l.sourcePageId, l.sourceBlockId)}>
            <span className="bl-title">
              <Icon name="page" size={14} />
              {l.sourcePageTitle || "Untitled"}
              {l.parentTitle && <span className="bl-path">in {l.parentTitle}</span>}
            </span>
            {l.contextKind === "table_row" ? <RowContext link={l} /> : l.snippet && <span className="bl-snippet">{l.snippet}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Pages that mention or link to this page, and pages that name it without a link. Renders nothing when there are none. */
export function Backlinks({ pageId }: { pageId: string }) {
  const [links, setLinks] = useState<Backlink[]>([]);
  const [unlinked, setUnlinked] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(readOpen);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    setUnlinked([]);
    setUnlinkedOpen(false);
    ipc
      .pageBacklinks(pageId)
      .then((l) => !cancelled && setLinks(l))
      .catch(() => !cancelled && setLinks([]));
    ipc
      .pageUnlinkedMentions(pageId)
      .then((l) => !cancelled && setUnlinked(l))
      .catch(() => !cancelled && setUnlinked([]));
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (!links.length && !unlinked.length) return null;
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
    <section className="backlinks" aria-label="Linked to this page">
      <button type="button" className="backlinks-head" aria-expanded={open} onClick={toggle}>
        <span className={`bl-chevron${open ? " open" : ""}`}>
          <Icon name="chevron" size={14} />
        </span>
        Linked to this page
        <span className="bl-count">{links.length}</span>
      </button>
      <Collapse open={open}>
        <Items links={links} />
        {unlinked.length > 0 && (
          <>
            <button type="button" className="backlinks-head bl-unlinked" aria-expanded={unlinkedOpen} onClick={() => setUnlinkedOpen((o) => !o)}>
              <span className={`bl-chevron${unlinkedOpen ? " open" : ""}`}>
                <Icon name="chevron" size={14} />
              </span>
              Unlinked mentions
              <span className="bl-count">{unlinked.length}</span>
            </button>
            <Collapse open={unlinkedOpen}>
              <Items links={unlinked} />
            </Collapse>
          </>
        )}
      </Collapse>
    </section>
  );
}
