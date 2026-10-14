import { useBoards } from "../canvas/store";
import { Icon } from "../../components/Icon";
import { useOutline } from "../outline/store";
import { useActiveEditor } from "../../stores/activeEditor";
import { useShortcut } from "../shortcuts/useShortcut";
import { READ_ONLY } from "../../lib/access";
import { canBack, canForward } from "../../lib/history";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { useHistoryPanel } from "../history/store";
import { usePalette } from "../palette/store";
import { sidebarInvisible, useLayout } from "../../stores/layout";
import { useSaveStatus } from "../../stores/saveStatus";
import { IconSwap, SwapText } from "../../components/Swap";

const label = (p: Page) => p.title || "Untitled";

function HistoryButton() {
  const open = useHistoryPanel((s) => s.open);
  const toggle = useHistoryPanel((s) => s.toggle);
  return (
    <button className={`icon-btn${open ? " on" : ""}`} aria-label="Version history" aria-pressed={open} title="Version history" onClick={toggle}>
      <Icon name="clock" />
    </button>
  );
}

function OutlineButton() {
  const open = useOutline((s) => s.open);
  const hasEditor = useActiveEditor((s) => !!s.editor);
  if (!hasEditor) return null;
  return (
    <button className={`icon-btn${open ? " on" : ""}`} aria-label="Outline and word count" aria-pressed={open} title="Outline and word count" onClick={() => useOutline.getState().toggle()}>
      <Icon name="bullet" />
    </button>
  );
}

/** "Saving…", a brief "Saved", or a retry when autosave failed. Silent the rest of the time. */
function SaveIndicator() {
  const status = useSaveStatus((s) => s.status);
  const detail = useSaveStatus((s) => s.detail);
  const retry = useSaveStatus((s) => s.retry);
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <span role="status">
        <button className="save-state failed" title={detail ?? "Changes are not saved yet"} onClick={() => retry?.()}>
          <Icon name="warning" size={14} />
          Not saved. Retry
        </button>
      </span>
    );
  }
  return (
    <span className={`save-state ${status}`} role="status">
      <IconSwap name={status === "saved" ? "check" : "clock"} size={14} />
      <SwapText value={status === "saved" ? "Saved" : "Saving…"} />
    </span>
  );
}

export function Topbar() {
  const searchShortcut = useShortcut("search");
  const backShortcut = useShortcut("back");
  const forwardShortcut = useShortcut("forward");
  const hidden = useLayout(sidebarInvisible);
  const sidebarAction = hidden ? "Show sidebar" : "Hide sidebar";
  const history = useWorkspace((s) => s.history);
  const view = useWorkspace((s) => s.view);
  const boardName = useBoards((s) => s.boards.find((b) => b.id === s.activeId)?.name);
  const page = useWorkspace((s) => s.selectedPage);
  const ancestors = useWorkspace((s) => s.ancestors);
  const { goBack, goForward, selectPage, toggleFavorite, trashPage } = useWorkspace.getState();

  // Long paths keep the root and the nearest parent; the middle collapses.
  const crumbs: (Page | "gap")[] = ancestors.length > 3 ? [ancestors[0], "gap", ancestors[ancestors.length - 1]] : ancestors;

  return (
    <div className="topbar" data-context-page={page?.id}>
      <div className="nav-buttons">
        <button
          type="button"
          className={`icon-btn sidebar-toggle${hidden ? " on" : ""}`}
          aria-label={sidebarAction}
          aria-expanded={!hidden}
          aria-controls="workspace-sidebar"
          title={sidebarAction}
          onClick={() => useLayout.getState().toggleSidebarVisibility()}
        >
          <IconSwap name={hidden ? "expandSidebar" : "sidebar"} />
        </button>
        <button className="icon-btn" aria-label="Back" title={`Back${backShortcut.label ? ` (${backShortcut.label})` : ""}`} disabled={!canBack(history)} onClick={() => void goBack()}>
          <Icon name="back" />
        </button>
        <button className="icon-btn" aria-label="Forward" title={`Forward${forwardShortcut.label ? ` (${forwardShortcut.label})` : ""}`} disabled={!canForward(history)} onClick={() => void goForward()}>
          <Icon name="forward" />
        </button>
      </div>

      {view === "trash" ? (
        <span className="crumbs"><span className="crumb-current">Trash</span></span>
      ) : view === "canvas" ? (
        <nav className="crumbs" aria-label="Breadcrumb"><ol><li><span className="crumb-current" aria-current="page">{boardName || "Canvas"}</span></li></ol></nav>
      ) : (
        page && (
          <>
            <nav className="crumbs" aria-label="Breadcrumb">
              <ol>
                {crumbs.map((c, i) => (
                  <li key={c === "gap" ? `gap${i}` : c.id}>
                    {c === "gap" ? (
                      <span className="crumb-gap" title={ancestors.slice(1, -1).map(label).join(" / ")}>…</span>
                    ) : (
                      <button data-context-page={c.id} className="crumb" onClick={() => void selectPage(c.id)}>
                        {label(c)}
                      </button>
                    )}
                    <span className="crumb-sep" aria-hidden="true">/</span>
                  </li>
                ))}
                <li>
                  <span className="crumb-current" aria-current="page">{label(page)}</span>
                </li>
              </ol>
            </nav>
            <div className="topbar-actions">
              <SaveIndicator />
              <button
                className={`icon-btn${page.favorite ? " on" : ""}`}
                aria-label={page.favorite ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={page.favorite}
                title={page.favorite ? "Remove from favorites" : "Add to favorites"}
                onClick={() => void toggleFavorite(page)}
              >
                <Icon name="star" filled={page.favorite} />
              </button>
              {page.kind !== "database" && page.kind !== "dashboard" && (
                <>
                  <OutlineButton />
                  <HistoryButton />
                </>
              )}
              <button className="icon-btn" aria-label="Move to trash" title="Move to trash" onClick={() => void trashPage(page)}>
                <Icon name="trash" />
              </button>
            </div>
          </>
        )
      )}
      {READ_ONLY && <span className="showcase-access" title="Browse pages, search, and explore views. Content is read-only.">Read-only showcase</span>}
      <button type="button" className="topbar-search" onClick={() => usePalette.getState().show()} aria-label={READ_ONLY ? "Search pages" : "Search or create a page"} aria-keyshortcuts={searchShortcut.aria}>
        <Icon name="search" />
        <span>{READ_ONLY ? "Search pages…" : "Search or create a page…"}</span>
        {searchShortcut.label && <kbd className="kbd">{searchShortcut.label}</kbd>}
      </button>
    </div>
  );
}
