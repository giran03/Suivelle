import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { syncDialog } from "../../lib/dialog";
import { CHANGELOG, type ChangelogEntry } from "./changelogData";
import { inlineMarkdown } from "./changelogMarkdown";

export { inlineMarkdown as inline };

/** One release's groups and bullets, in the Octopolis changelog style. */
export function ChangelogBody({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="cl">
      {entry.groups.map((g, i) => (
        <section key={i}>
          {g.title && <h5 className="cl-group">{g.title}</h5>}
          {g.items.map((item, j) => <p className="cl-item" key={j}>{inlineMarkdown(item)}</p>)}
        </section>
      ))}
      {!entry.groups.length && <p className="cl-item">No notes were written for this version.</p>}
    </div>
  );
}

export const entryLabel = (e: ChangelogEntry) => e.unreleased ? "In development" : (e.released ?? "").replace(/^Released\s+/i, "");

/** Every version's notes, newest first; the newest opens by default and the others fold away. */
export function ChangelogHistory({ open, onClose, current }: { open: boolean; onClose: () => void; current?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    if (ref.current) syncDialog(ref.current, open);
    if (open) setExpanded(current && CHANGELOG.some((e) => e.version === current) ? current : CHANGELOG[0]?.version ?? null);
  }, [open, current]);
  return (
    <dialog ref={ref} className="palette changelog-history" aria-labelledby="clh-title" onClose={onClose} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header className="clh-head">
        <h2 id="clh-title">Changelogs</h2>
        <button type="button" className="icon-btn" aria-label="Close changelogs" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="clh-body">
        {CHANGELOG.map((e) => {
          const on = expanded === e.version;
          return (
            <section key={e.version} className={`clh-entry${on ? " on" : ""}`}>
              <button type="button" className="clh-toggle" aria-expanded={on} onClick={() => setExpanded(on ? null : e.version)}>
                <Icon name="chevron" size={14} />
                <span className="clh-version">{e.version}</span>
                {e.version === current && <span className="clh-tag">Installed</span>}
                {e.unreleased && <span className="clh-tag soft">In development</span>}
                {!e.unreleased && <span className="clh-date">{entryLabel(e)}</span>}
              </button>
              {on && <div className="clh-content"><ChangelogBody entry={e} /></div>}
            </section>
          );
        })}
        {!CHANGELOG.length && <p className="set-hint">No changelogs are bundled with this build.</p>}
      </div>
    </dialog>
  );
}
