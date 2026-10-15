import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { syncDialog } from "../../lib/dialog";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
import { lineDiff, withContext } from "./diff";
import { useAgents, type ReviewTab } from "./store";
import type { Changeset, Finding, Proposal } from "./types";
import "./agents.css";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function openPage(id: string) {
  useAgents.getState().hide();
  void useWorkspace.getState().selectPage(id);
}

function PageLink({ id, title }: { id: string | null; title: string | null }) {
  if (!id) return null;
  return <button type="button" className="agx-link" onClick={() => openPage(id)}>{title?.trim() || "Untitled"}</button>;
}

function Diff({ before, after }: { before: string | null; after: string | null }) {
  const lines = useMemo(() => withContext(lineDiff(before ?? "", after ?? ""), 2), [before, after]);
  if (before === null && after) return <pre className="agx-diff" aria-label="New content">{after}</pre>;
  if (!lines.some((l) => l && l.kind !== "same")) return <p className="picker-muted">No change to the text.</p>;
  return (
    <pre className="agx-diff" aria-label="Changes to the page text">
      {lines.map((l, i) => l === null
        ? <span key={i} className="agx-gap">⋯</span>
        : <span key={i} className={`agx-${l.kind}`}><span aria-hidden="true">{l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}</span><span className="sr-only">{l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}</span>{l.text || " "}</span>)}
    </pre>
  );
}

function ProposalView({ id, onDone }: { id: string; onDone: () => void }) {
  const [p, setP] = useState<Proposal | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setP(null);
    setError(null);
    ipc.proposalDetail(id).then((d) => { if (live) { setP(d); setPicked(new Set(d.ops.map((_, i) => i))); } }).catch((e) => live && setError(toAppError(e).message));
    return () => { live = false; };
  }, [id]);
  if (error && !p) return <p className="field-error" role="alert">{error}</p>;
  if (!p) return <p className="picker-muted">Loading…</p>;
  const pending = p.status === "pending";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); onDone(); } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); }
  };
  const all = picked.size === p.ops.length;
  return (
    <div className="agx-detail">
      <header>
        <h3>{p.title}</h3>
        <p className="picker-muted">{p.actorKind === "mirror" ? "Mirror folder" : p.agentName ?? "Removed agent"} · {when(p.createdAt)} · {p.status}</p>
      </header>
      {pending && p.resume && p.agentName && (
        <p className="agx-note" role="status">
          {p.agentWaiting
            ? `${p.agentName} is waiting for your decision and continues as soon as you approve or reject.`
            : `${p.agentName} asked to hear the decision; it gets a “Continue” task with your note.`}
        </p>
      )}
      {p.rationale && <p className="agx-rationale">{p.rationale}</p>}
      {p.error && <p className="field-error" role="alert">{p.error}</p>}
      {p.decisionNote && !pending && <p className="picker-muted">Note: {p.decisionNote}</p>}
      <ol className="agx-ops">
        {p.ops.map((o, i) => (
          <li key={i}>
            <label className="agx-op-head">
              {pending && p.ops.length > 1 && <input type="checkbox" checked={picked.has(i)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />}
              <span>{o.summary}</span>
              {o.pageId && <PageLink id={o.pageId} title={o.pageTitle} />}
            </label>
            {(o.before !== null || o.after) && <Diff before={o.before} after={o.after} />}
          </li>
        ))}
      </ol>
      {pending && !READ_ONLY && (
        <div className="agx-decide">
          <label htmlFor="agx-note">Note to the agent (optional)</label>
          <textarea id="agx-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or what to do instead" />
          <div className="picker-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => ipc.proposalReject(p.id, note.trim() || null))}>Reject</button>
            <button type="button" className="btn primary" disabled={busy || picked.size === 0} onClick={() => void act(() => ipc.proposalApprove(p.id, all ? null : [...picked], note.trim() || null))}>
              {busy ? "Applying…" : all ? "Approve" : `Approve ${picked.size} of ${p.ops.length}`}
            </button>
          </div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

function ReviewTabView() {
  const epoch = useAgents((s) => s.epoch);
  const [showDecided, setShowDecided] = useState(false);
  const [list, setList] = useState<Proposal[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const l = await ipc.proposalList(showDecided ? "all" : "pending");
      setList(l);
      setSelected((s) => (s && l.some((p) => p.id === s) ? s : l[0]?.id ?? null));
    } catch (e) { setError(toAppError(e).message); }
  }, [showDecided]);
  useEffect(() => void load(), [load, epoch]);
  return (
    <div className="agx-split">
      <div className="agx-list">
        <label className="check-row"><input type="checkbox" checked={showDecided} onChange={(e) => setShowDecided(e.target.checked)} /> Show decided</label>
        {error && <p className="field-error" role="alert">{error}</p>}
        {list?.length === 0 && <p className="picker-muted">Nothing is waiting for review. Agents in Propose mode, and edits made in mirror folders, show up here.</p>}
        <ul role="listbox" aria-label="Proposals">
          {list?.map((p) => (
            <li key={p.id} role="option" aria-selected={selected === p.id}>
              <button type="button" onClick={() => setSelected(p.id)}>
                <strong>{p.title}</strong>
                <small>{p.actorKind === "mirror" ? "Mirror folder" : p.agentName ?? "Removed agent"} · {p.opCount} change{p.opCount === 1 ? "" : "s"} · {p.status === "pending" ? when(p.createdAt) : p.status}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="agx-pane">
        {selected ? <ProposalView key={selected} id={selected} onDone={() => { void useAgents.getState().refresh(); void load(); }} /> : <p className="picker-muted">Choose a proposal to see what it changes.</p>}
      </div>
    </div>
  );
}

const ACTOR: Record<Changeset["actorKind"], string> = { agent: "Agent", mirror: "Mirror folder", janitor: "Vault upkeep", user: "You" };
const OP: Record<string, string> = { created: "created", updated: "edited", renamed: "renamed", moved: "moved", trashed: "trashed", values: "properties set", aliases: "aliases set" };

function ActivityTab() {
  const epoch = useAgents((s) => s.epoch);
  const [list, setList] = useState<Changeset[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setList(await ipc.changesetList(null, null)); } catch (e) { setError(toAppError(e).message); }
  }, []);
  useEffect(() => void load(), [load, epoch]);
  const revert = async (c: Changeset) => {
    if (!window.confirm(`Revert “${c.summary}”? Edited pages go back to how they were before, created pages go to the trash. Each page keeps a version from before the revert in its history.`)) return;
    setBusy(c.id);
    setError(null);
    try { await ipc.changesetRevert(c.id); await load(); } catch (e) { setError(toAppError(e).message); } finally { setBusy(null); }
  };
  return (
    <div className="agx-activity">
      <p className="picker-muted">Every change made by agents, mirror folders and vault upkeep, newest first. Reverting restores the pages as they were before that change.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      {list?.length === 0 && <p className="picker-muted">No agent activity yet.</p>}
      <ul>
        {list?.map((c) => (
          <li key={c.id} className={c.revertedAt ? "reverted" : undefined}>
            <div className="agx-activity-head">
              <div>
                <strong>{c.summary || "Changes"}</strong>
                <small>{c.actorKind === "agent" ? c.actorName ?? "Removed agent" : ACTOR[c.actorKind]} · {when(c.createdAt)}{c.revertedAt ? ` · reverted ${when(c.revertedAt)}` : ""}</small>
              </div>
              {!c.revertedAt && !READ_ONLY && <button type="button" className="btn" disabled={busy !== null} onClick={() => void revert(c)}>{busy === c.id ? "Reverting…" : "Revert"}</button>}
            </div>
            <p className="agx-pages">{c.pages.map((p, i) => <span key={p.pageId + p.op}>{i > 0 && ", "}<PageLink id={p.pageId} title={p.title} /> {OP[p.op] ?? p.op}</span>)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CHECKS: Record<string, string> = {
  broken_links: "Broken links",
  unresolved_links: "Links to missing pages",
  duplicate_titles: "Duplicate titles",
  empty_pages: "Empty pages",
  isolated_pages: "Isolated pages",
  tag_variants: "Tag spellings",
  memory: "Agent memory",
  tasks: "Agent tasks",
  proposals: "Waiting proposals",
};

function HealthTab() {
  const workspace = useWorkspace((s) => s.workspace);
  const [list, setList] = useState<Finding[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!workspace) return;
    setError(null);
    try { setList(await ipc.janitorReport(workspace.id)); setPicked(new Set()); } catch (e) { setError(toAppError(e).message); }
  }, [workspace]);
  useEffect(() => void load(), [load]);
  const groups = useMemo(() => {
    const m = new Map<string, { f: Finding; i: number }[]>();
    list?.forEach((f, i) => m.set(f.check, [...(m.get(f.check) ?? []), { f, i }]));
    return [...m.entries()];
  }, [list]);
  const fix = async () => {
    if (!workspace || !list) return;
    setBusy(true);
    setError(null);
    try {
      const fixes = [...picked].map((i) => list[i].fix).filter((f): f is NonNullable<typeof f> => !!f);
      const pages = await ipc.janitorFix(workspace.id, fixes);
      setMessage(`Applied ${fixes.length} fix${fixes.length === 1 ? "" : "es"} (${pages.length} page${pages.length === 1 ? "" : "s"}). Undo them from Activity.`);
      void useAgents.getState().refresh();
      await load();
    } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); }
  };
  return (
    <div className="agx-health">
      <div className="agx-health-head">
        <p className="picker-muted">Checks {workspace ? `“${workspace.name}”` : "this workspace"} for loose ends. Nothing changes until you apply a fix; fixes can be reverted from Activity.</p>
        <button type="button" className="btn" onClick={() => void load()}>Check again</button>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {message && <p className="picker-muted" role="status">{message}</p>}
      {list?.length === 0 && <p className="picker-muted">Nothing to tidy up.</p>}
      {groups.map(([check, items]) => (
        <section key={check}>
          <h4>{CHECKS[check] ?? check} <small>{items.length}</small></h4>
          <ul>
            {items.map(({ f, i }) => (
              <li key={i} className={`agx-${f.severity}`}>
                <label className="agx-op-head">
                  {f.fix && !READ_ONLY && <input type="checkbox" checked={picked.has(i)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} aria-label={`Fix: ${f.title}`} />}
                  <span><strong>{f.title}</strong> — {f.detail}</span>
                  {f.pageId && <PageLink id={f.pageId} title="Open" />}
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {picked.size > 0 && <div className="picker-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void fix()}>{busy ? "Applying…" : `Apply ${picked.size} fix${picked.size === 1 ? "" : "es"}`}</button></div>}
    </div>
  );
}

const TABS: [ReviewTab, string][] = [["review", "Review"], ["activity", "Activity"], ["health", "Vault health"]];

export function ReviewDialog() {
  const open = useAgents((s) => s.open);
  const tab = useAgents((s) => s.tab);
  const pending = useAgents((s) => s.pending);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (ref.current) syncDialog(ref.current, open); }, [open]);
  return (
    <dialog ref={ref} className="palette tpl-dialog agx-dialog" aria-label="Agents inbox" onClose={() => useAgents.getState().hide()} onMouseDown={(e) => { if (e.target === e.currentTarget) useAgents.getState().hide(); }}>
      {open && (
        <div className="agx">
          <header className="tpl-head">
            <h2>Agents</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => useAgents.getState().hide()}><Icon name="close" /></button>
          </header>
          <div role="tablist" aria-label="Agents views" className="agx-tabs">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => useAgents.getState().setTab(id)}>
                {label}{id === "review" && pending > 0 && <span className="agx-badge" aria-label={`${pending} waiting`}>{pending}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="agx-body">
            {tab === "review" && <ReviewTabView />}
            {tab === "activity" && <ActivityTab />}
            {tab === "health" && <HealthTab />}
          </div>
        </div>
      )}
    </dialog>
  );
}
