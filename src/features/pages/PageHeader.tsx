import { useEffect, useRef, useState } from "react";
import { EmojiPicker } from "../../components/LazyEmojiPicker";
import { Icon } from "../../components/Icon";
import { anchorOf, Popover, type Anchor } from "../../components/Popover";
import { attachmentUrl, thumbUrl } from "../../lib/attachments";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { PageGlyph } from "./PageGlyph";
import "./pages.css";
import { GRADIENTS, LINE_ICONS, gradientCss, parseCover, parseIcon, setAppearance, useAppearanceUi } from "./pageAppearance";

/** Full-width banner above the title; the controls appear on hover or keyboard focus. */
export function PageCover({ page }: { page: Page }) {
  const cover = parseCover(page.cover);
  const show = useAppearanceUi((s) => s.show);
  if (!cover) return null;
  return (
    <div className="page-cover" data-context-page={page.id}>
      {cover.kind === "gradient" ? (
        <div className="cover-fill" style={{ background: gradientCss(cover.id) }} />
      ) : (
        <img
          className="cover-fill"
          alt=""
          src={thumbUrl(cover.hash, 1280)}
          onError={(e) => {
            const full = attachmentUrl(cover.hash);
            if (e.currentTarget.src !== full) e.currentTarget.src = full;
          }}
        />
      )}
      <div className="cover-actions">
        <button className="cover-btn" onClick={() => show("cover")}>
          <Icon name="image" size={14} />
          Change cover
        </button>
        <button className="cover-btn" aria-label="Remove cover" title="Remove cover" onClick={() => void setAppearance(page, { cover: null })}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

/** The icon (large when set) plus the quiet "Add icon" and "Add cover" affordances above the title. */
export function PageIconRow({ page }: { page: Page }) {
  const open = useAppearanceUi((s) => s.open);
  const show = useAppearanceUi((s) => s.show);
  const hide = useAppearanceUi((s) => s.hide);
  const row = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const hasIcon = !!parseIcon(page.icon);
  const hasCover = !!parseCover(page.cover);

  // Re-anchor every time a picker opens, so a scrolled page does not leave it floating elsewhere.
  useEffect(() => {
    if (open && row.current) setAnchor(anchorOf(row.current));
  }, [open]);
  const request = show;

  return (
    <div className={`page-icon-row${hasCover && hasIcon ? " over-cover" : ""}`} ref={row}>
      {hasIcon ? (
        <button className="page-icon" aria-label="Change page icon" title="Change icon" onClick={() => request("icon")}>
          <PageGlyph page={page} size={52} />
        </button>
      ) : null}
      <div className="page-affordances">
        {!hasIcon && (
          <button className="afford" onClick={() => request("icon")}>
            <Icon name="smile" size={14} />
            Add icon
          </button>
        )}
        {!hasCover && (
          <button className="afford" onClick={() => request("cover")}>
            <Icon name="image" size={14} />
            Add cover
          </button>
        )}
      </div>
      {open && anchor && (
        <Popover anchor={anchor} onClose={hide} label={open === "icon" ? "Choose an icon" : "Choose a cover"} className="picker">
          {open === "icon" ? <IconPicker page={page} onDone={hide} /> : <CoverPicker page={page} onDone={hide} />}
        </Popover>
      )}
    </div>
  );
}

function IconPicker({ page, onDone }: { page: Page; onDone: () => void }) {
  const kind = parseIcon(page.icon)?.kind;
  const [tab, setTab] = useState<"emoji" | "icons" | "upload">(kind === "image" ? "upload" : kind === "icon" ? "icons" : "emoji");
  const { busy, error, pick, upload } = useImagePicker(page, "icon", onDone);
  return (
    <div className="picker-body">
      <div className="picker-head">
        <div className="seg" role="tablist" aria-label="Icon type">
          <button role="tab" disabled={busy} aria-selected={tab === "emoji"} className={tab === "emoji" ? "on" : ""} onClick={() => setTab("emoji")}>Emoji</button>
          <button role="tab" disabled={busy} aria-selected={tab === "icons"} className={tab === "icons" ? "on" : ""} onClick={() => setTab("icons")}>Icons</button>
          <button role="tab" disabled={busy} aria-selected={tab === "upload"} className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>Upload</button>
        </div>
        {parseIcon(page.icon) && (
          <button className="btn ghost" disabled={busy} onClick={() => void pick(null)}>Remove</button>
        )}
      </div>
      <div className="picker-scroll">
        {tab === "emoji" ? (
          <EmojiPicker value={page.icon} disabled={busy} onSelect={(emoji) => void pick(emoji)} />
        ) : tab === "icons" ? (
          <div className="picker-grid">
            {LINE_ICONS.map((name) => (
              <button key={name} className="pick-cell" disabled={busy} aria-label={name} title={name} onClick={() => void pick(`icon:${name}`)}>
                <Icon name={name} size={18} />
              </button>
            ))}
          </div>
        ) : (
          <div className="icon-upload">
            <div className="icon-upload-preview">{kind === "image" ? <PageGlyph page={page} size={52} /> : <Icon name="image" size={32} />}</div>
            <p>Use a photo or logo. Images fill the icon with a centered crop. GIFs keep playing.</p>
            <button className="btn" disabled={busy} onClick={() => void upload()}><Icon name="image" />{busy ? "Uploading…" : "Upload image…"}</button>
          </div>
        )}
      </div>
      {error && <p className="picker-error" role="alert">{error}</p>}
    </div>
  );
}

/** Icon and cover uploads use the same native image picker and attachment storage. */
function useImagePicker(page: Page, field: "icon" | "cover", onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string | null) => {
    if (await setAppearance(page, { [field]: value })) onDone();
    else setError(useWorkspace.getState().error ?? `Couldn’t save the ${field}. Try again.`);
  };
  const pick = async (value: string | null) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await save(value); } finally { setBusy(false); }
  };
  const upload = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const att = await ipc.attachmentImport(page.workspaceId, "image");
      if (att) await save(`image:${att.hash}`);
    } catch (e) {
      const message = toAppError(e).message;
      setError(message);
      useWorkspace.getState().setError(message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, pick, upload };
}

function CoverPicker({ page, onDone }: { page: Page; onDone: () => void }) {
  const { busy, error, pick, upload } = useImagePicker(page, "cover", onDone);
  return (
    <div className="picker-body">
      <div className="picker-head">
        <button className="btn" disabled={busy} onClick={() => void upload()}>
          <Icon name="image" />
          {busy ? "Uploading…" : "Upload image…"}
        </button>
        {parseCover(page.cover) && (
          <button className="btn ghost" disabled={busy} onClick={() => void pick(null)}>Remove</button>
        )}
      </div>
      <div className="picker-scroll">
        <h3>Gradients</h3>
        <div className="cover-grid">
          {GRADIENTS.map((g) => (
            <button key={g.id} className="cover-swatch" disabled={busy} aria-label={g.name} title={g.name} style={{ background: g.css }} onClick={() => void pick(`gradient:${g.id}`)} />
          ))}
        </div>
      </div>
      {error && <p className="picker-error" role="alert">{error}</p>}
    </div>
  );
}
