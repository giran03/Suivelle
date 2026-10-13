import { useEffect, useRef } from "react";
import { Icon } from "../../components/Icon";
import { formatBytes } from "../../lib/formatBytes";
import { syncDialog } from "../../lib/dialog";
import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "../../lib/ipc";
import { READ_ONLY } from "../../lib/access";
import { useWorkspace } from "../../stores/workspace";
import { useSettingsDialog } from "../settings/store";
import { isPreparing, startUpdateScheduler, useUpdates, type Release } from "./store";
import "./updates.css";

function releaseDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function UpdatesSection() {
  const { snapshot, phase, error, progress, check, download, preferences, install, showChangelog } = useUpdates();
  const target = useSettingsDialog((s) => s.section);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { void useUpdates.getState().init(); }, []);
  useEffect(() => {
    if (target !== "updates") return;
    // The containing dialog opens in its own effect; focus after native autofocus runs.
    const frame = window.requestAnimationFrame(() => {
      heading.current?.scrollIntoView({ block: "start" });
      heading.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [target]);
  const busy = phase !== "idle";
  const status = phase === "checking" ? "Checking for updates…" : phase === "downloading" ? "Downloading update…" : snapshot?.ready ? `Version ${snapshot.available?.version} is ready to install` : snapshot?.available ? `Version ${snapshot.available.version} is available` : error ? "Update check could not complete" : snapshot?.lastCheck ? "You're up to date" : "Not checked yet";
  return (
    <section className="updates-section" aria-labelledby="updates-title">
      <h3 id="updates-title" ref={heading} tabIndex={-1}>Updates</h3>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Version {snapshot?.installed.version ?? "…"}</div>
          <div className="set-hint" role="status">{snapshot?.unsupported ? "Manual updates for this installation" : status}</div>
          {snapshot?.ready && <div className="set-hint">Saves changes and makes a backup before closing.</div>}
          {snapshot?.lastCheck && <div className="set-hint">Last checked {new Date(snapshot.lastCheck).toLocaleString()}</div>}
        </div>
        {snapshot?.ready ? <button className="btn primary" disabled={busy} onClick={() => void install()}>Install and restart</button> : <button className="btn" disabled={busy || !snapshot || !!snapshot.unsupported} onClick={() => void check()}>Check for updates</button>}
      </div>
      {snapshot?.unsupported ? <p className="set-hint update-explanation">{snapshot.unsupported}</p> : <>
        <p className="set-hint update-explanation">Update checks and downloads contact GitHub. Your workspace content stays on this computer.</p>
        {([['autoCheck', 'Check for updates automatically'], ['autoDownload', 'Download updates automatically']] as const).map(([key, label]) => (
          <div className="set-row" key={key}>
            <div className="set-text"><div className="set-title">{label}</div><div className="set-hint">{key === "autoCheck" ? "At startup and every six hours while Suivelle is running." : "You choose when to install and restart."}</div></div>
            <label className="switch"><input type="checkbox" aria-label={label} checked={snapshot?.preferences[key] ?? true} disabled={busy || !snapshot || (key === "autoDownload" && !snapshot.preferences.autoCheck)} onChange={(e) => void preferences({ [key]: e.target.checked })} /><span className="switch-track" aria-hidden="true" /></label>
          </div>
        ))}
      </>}
      {snapshot?.available && <div className="update-available">
        <div className="set-title">Suivelle {snapshot.available.version}</div>
        {snapshot.available.date && <p className="set-hint">{releaseDate(snapshot.available.date)}</p>}
        {phase === "downloading" && <div className="update-progress">
          <progress aria-label="Update download" max={progress.total ?? 1} value={progress.total ? Math.min(progress.downloaded, progress.total) : undefined} />
          <span>{formatBytes(progress.downloaded)}{progress.total ? ` of ${formatBytes(progress.total)}` : " downloaded"}</span>
        </div>}
        <div className="update-actions">
          {!snapshot.ready && <button className="btn primary" disabled={busy} onClick={() => void download()}>{phase === "downloading" ? "Downloading…" : error ? "Retry download" : "Download update"}</button>}
          <button className="btn ghost" disabled={isPreparing(phase)} onClick={() => showChangelog(snapshot.available!)}>View changes</button>
        </div>
        {snapshot.ready && <p className="set-hint">Suivelle will save your changes, make a safety backup, and close to update. You can keep working until you're ready.</p>}
      </div>}
      {snapshot?.installationFailed && <p className="set-hint update-explanation">The previous update did not complete. This copy is still running version {snapshot.installed.version}. Check for updates to retry.</p>}
      {snapshot?.recoveryBackup && <p className="set-hint update-explanation">Recovery backup: {snapshot.recoveryBackup}. Find it in Data and safety → Backups.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="update-actions">
        <button className="btn" disabled={!snapshot || isPreparing(phase)} onClick={() => showChangelog()}>View changelog</button>
        {READ_ONLY ? <a className="btn ghost" href="https://github.com/giran03/Suivelle/releases" target="_blank" rel="noopener noreferrer">GitHub releases <Icon name="forward" /></a> : <button className="btn ghost" onClick={() => void invoke("update_open_releases").catch((e) => useUpdates.setState({ error: toAppError(e).message }))}>GitHub releases <Icon name="forward" /></button>}
      </div>
    </section>
  );
}

/** Plain, escaped Markdown structure: no release HTML or remotely loaded media. */
function Notes({ release }: { release: Release }) {
  const blocks: React.ReactNode[] = [];
  let items: string[] = [];
  const finishList = () => {
    if (!items.length) return;
    blocks.push(<ul key={blocks.length}>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>);
    items = [];
  };
  for (const line of release.notes.slice(0, 65536).split(/\r?\n/)) {
    if (/^[-*]\s/.test(line)) { items.push(line.replace(/^[-*]\s+/, "")); continue; }
    finishList();
    if (!line.trim()) continue;
    if (/^#{1,6}\s/.test(line)) blocks.push(<h3 key={blocks.length}>{line.replace(/^#{1,6}\s+/, "")}</h3>);
    else blocks.push(<p key={blocks.length}>{line}</p>);
  }
  finishList();
  return <div className="changelog-notes">{blocks}</div>;
}

export function UpdatesRoot() {
  const { snapshot, phase, preparation, changelog, returnToSettings, notice, hideChangelog } = useUpdates();
  const workspaceReady = useWorkspace((s) => s.ready);
  const changelogRef = useRef<HTMLDialogElement>(null);
  const preparingRef = useRef<HTMLDialogElement>(null);
  const preparing = isPreparing(phase);
  useEffect(() => { void useUpdates.getState().init(); return startUpdateScheduler(); }, []);
  useEffect(() => {
    if (!workspaceReady) return;
    let presenting = false;
    let canceled = false;
    let checkingVisibility = false;
    const tick = async () => {
      let current = useUpdates.getState();
      if (checkingVisibility || (!current.changelog && !current.snapshot?.pendingChangelog) || document.visibilityState !== "visible" || document.querySelector("dialog[open]") || isPreparing(current.phase)) return;
      checkingVisibility = true;
      let visible = false;
      try { visible = READ_ONLY || await invoke<boolean>("update_window_visible"); }
      catch { return; }
      finally { checkingVisibility = false; }
      current = useUpdates.getState();
      if (canceled || !visible || document.querySelector("dialog[open]") || isPreparing(current.phase)) return;
      if (current.changelog) {
        const dialog = changelogRef.current;
        if (dialog && !dialog.open) {
          syncDialog(dialog, true);
          if (current.changelog.version === current.snapshot?.installed.version && !presenting) {
            presenting = true;
            void current.acknowledge();
          }
        }
      } else if (current.snapshot?.pendingChangelog) current.showChangelog();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 250);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [workspaceReady, changelog, snapshot?.pendingChangelog]);
  useEffect(() => { if (changelogRef.current && !changelog) syncDialog(changelogRef.current, false); }, [changelog]);
  useEffect(() => {
    const dialog = preparingRef.current;
    if (!dialog) return;
    if (!preparing) { syncDialog(dialog, false); return; }
    const show = () => { if (!document.querySelector("dialog[open]:not(.update-preparing)")) syncDialog(dialog, true); };
    show();
    const timer = window.setInterval(show, 50);
    return () => window.clearInterval(timer);
  }, [preparing]);
  // Keep the mounted content through the dialog's shared close animation.
  const lastRelease = useRef<Release | null>(null);
  if (changelog) lastRelease.current = changelog;
  return <>
    {notice && snapshot?.ready && !preparing && <div className="toast update-notice" role="status">
      <span>Suivelle {snapshot.available?.version} is ready to install.</span>
      <button onClick={() => { useUpdates.setState({ notice: false }); useSettingsDialog.getState().show("updates"); }}>View update</button>
      <button className="icon-btn" aria-label="Dismiss update notice" onClick={() => useUpdates.setState({ notice: false })}><Icon name="close" /></button>
    </div>}
    <dialog ref={changelogRef} className="palette changelog" aria-labelledby="changelog-title" onClose={() => { if (useUpdates.getState().changelog) hideChangelog(); }} onMouseDown={(e) => { if (e.target === e.currentTarget) hideChangelog(); }}>
      <div className="set-head"><h2 id="changelog-title">What's new in Suivelle</h2><button className="icon-btn" aria-label="Close changelog" onClick={hideChangelog}><Icon name="close" /></button></div>
      {lastRelease.current && <div className="changelog-body"><p className="changelog-meta">Version {lastRelease.current.version}{lastRelease.current.date ? ` · ${releaseDate(lastRelease.current.date)}` : ""}</p><Notes release={lastRelease.current} /></div>}
      <div className="changelog-footer"><button className="btn primary" onClick={hideChangelog}>{returnToSettings ? "Back to updates" : "Continue"}</button></div>
    </dialog>
    <dialog ref={preparingRef} className="palette update-preparing" aria-labelledby="update-preparing-title" onCancel={(e) => e.preventDefault()}>
      <div className="set-head"><h2 id="update-preparing-title">Updating Suivelle</h2></div>
      <div className="changelog-body"><p role="status">{preparation}</p><p className="set-hint">Suivelle will reopen when installation finishes.</p></div>
    </dialog>
  </>;
}
