import { useEffect, useRef } from "react";
import { Icon } from "../../components/Icon";
import { syncDialog } from "../../lib/dialog";
import { GraphPanel } from "./graph";
import { RemindersPanel, RemindPanel } from "./reminders";
import { useExplore, type ExplorePanel } from "./store";
import { TagsPanel } from "./tags";
import "./explore.css";

const TITLES: Record<ExplorePanel, string> = { remind: "Set a reminder", reminders: "Reminders", tags: "Tags", graph: "Link graph" };

/** One dialog for reminders, tags and the link graph; it loads on first use. */
export function ExploreDialog() {
  const panel = useExplore((s) => s.panel);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (ref.current) syncDialog(ref.current, !!panel); }, [panel]);
  const hide = () => useExplore.getState().hide();
  return <dialog ref={ref} className={`palette explore explore-${panel ?? "closed"}`} aria-label={panel ? TITLES[panel] : "Explore"} onClose={hide}
    onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}>
    {panel && <>
      <div className="explore-head">
        <h2>{TITLES[panel]}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={hide}><Icon name="close" /></button>
      </div>
      <div className="explore-body">
        {panel === "remind" && <RemindPanel />}
        {panel === "reminders" && <RemindersPanel />}
        {panel === "tags" && <TagsPanel />}
        {panel === "graph" && <GraphPanel />}
      </div>
    </>}
  </dialog>;
}
