import { useEffect, useRef, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon, type IconName } from "../../components/Icon";
import { copyText } from "../../components/editingMenu";
import { attachmentUrl, thumbUrl } from "../../lib/attachments";
import { ipc, toAppError } from "../../lib/ipc";
import { pageLinkTarget } from "../../lib/legacy";
import { useWorkspace } from "../../stores/workspace";
import { normalizeHref } from "./SelectionToolbar";
import { selectBlockAt } from "./commands";
import { imagePresentation, type ImagePresentation } from "./imageModel";
import { imageItems } from "./imageActions";
import { closeHistory } from "@tiptap/pm/history";
import { ImageCrop } from "./ImageCrop";
import "./images.css";

export function ImageBlock({
  node,
  editor,
  getPos,
  updateAttributes,
  replace,
  openViewer,
}: NodeViewProps & {
  replace: () => Promise<Record<string, unknown> | null>;
  openViewer: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const [panel, setPanel] = useState<
    "caption" | "alt" | "link" | "width" | "note" | null
  >(null);
  const [naturalWidth, setNaturalWidth] = useState<number>(640);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const gesture = useRef<{
    start: number;
    width: number;
    side: number;
    scale: number;
    max: number;
    value: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [animated, setAnimated] = useState<boolean | null>(null);
  const [sourceRatio, setSourceRatio] = useState(1);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const p = imagePresentation(node.attrs.presentation);
  const name = node.attrs.name || "image";
  const url = attachmentUrl(node.attrs.hash);
  const patch = (change: Partial<ImagePresentation>) =>
    updateAttributes({ presentation: imagePresentation({ ...p, ...change }) });
  const run = async (action: string) => {
    setError("");
    setMessage("");
    if (action === "view") {
      openViewer();
      return;
    }
    if (action === "note") {
      setDraft(p.note ?? "");
      setPanel("note");
      return;
    }
    if (action === "copy-link") {
      if (p.link) await copyText(p.link);
      return;
    }
    if (action === "open-link" && p.link) {
      const id = pageLinkTarget(p.link);
      if (id) {
        const page = useWorkspace.getState().pageTitles[id];
        if (!page || page.deleted)
          throw Error("The linked page is no longer available.");
        await useWorkspace.getState().selectPage(id);
      } else {
        const href = normalizeHref(p.link);
        if (!href) throw Error("This link cannot be opened.");
        await ipc.imageOpenLink(href);
      }
      return;
    }
    if (action === "save") {
      if (p.crop) await ipc.imageSaveCrop(node.attrs.attachmentId, p.crop);
      else await ipc.attachmentSaveAs(node.attrs.attachmentId);
      return;
    }
    if (action === "copy-image" || action === "copy-still") {
      await ipc.imageCopy(
        node.attrs.attachmentId,
        p.crop,
        action === "copy-still",
      );
      setMessage(
        action === "copy-still" ? "Still frame copied." : "Image copied.",
      );
      return;
    }
    if (!editor.isEditable) return;
    if (action === "crop") {
      if (animated === null)
        throw Error("Image details are still loading. Try again.");
      if (animated)
        throw Error(
          "Cropping animated images is unavailable. The original animation is preserved.",
        );
      setCropOpen(true);
      return;
    }
    if (action === "reset-crop") {
      patch({ crop: undefined });
      return;
    }
    if (action === "reset-size") {
      patch({ width: undefined, widthMode: undefined });
      return;
    }
    if (action === "width") {
      setDraft(
        String(
          p.widthMode === "percent"
            ? (root.current?.offsetWidth ?? 480)
            : (p.width ?? root.current?.offsetWidth ?? 480),
        ),
      );
      setPanel("width");
      return;
    }
    if (action === "replace") {
      const attrs = await replace();
      if (attrs && !editor.isDestroyed) {
        const pos = getPos();
        const live = pos === undefined ? null : editor.state.doc.nodeAt(pos);
        if (!live || live.type.name !== "image" || !editor.isEditable) return;
        updateAttributes({
          ...attrs,
          presentation: {
            ...imagePresentation(live.attrs.presentation),
            crop: undefined,
          },
        });
        setBroken(false);
      }
      return;
    }
    if (action === "remove-link") {
      patch({ link: undefined });
      return;
    }
    if (["caption", "alt", "link"].includes(action)) {
      const key = action as "caption" | "alt" | "link";
      setDraft(p[key] ?? "");
      setPanel(key);
    }
  };
  const perform = (action: string) =>
    void run(action).catch((e) => setError(toAppError(e).message));
  useEffect(() => {
    const el = root.current;
    const receive = (event: Event) =>
      perform((event as CustomEvent<string>).detail);
    el?.addEventListener("image-action", receive);
    return () => el?.removeEventListener("image-action", receive);
  });
  useEffect(() => setBroken(false), [node.attrs.hash]);
  useEffect(() => {
    let active = true;
    setAnimated(null);
    void ipc
      .imageInfo(node.attrs.attachmentId)
      .then((info) => {
        if (active) {
          setAnimated(info.animated);
          setNaturalWidth(info.width);
          setSourceRatio(info.width / info.height);
        }
      })
      .catch((e) => {
        if (active) setError(toAppError(e).message);
      });
    return () => {
      active = false;
    };
  }, [node.attrs.attachmentId]);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gesture.current) {
        e.preventDefault();
        e.stopPropagation();
        gesture.current = null;
        setPreviewWidth(undefined);
      }
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, []);
  const button = (
    label: string,
    icon: IconName,
    click: (e: React.MouseEvent<HTMLButtonElement>) => void,
  ) => (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={click}
    >
      <Icon name={icon} size={16} />
      {label.startsWith("Alignment:") && (
        <span className="image-align-chevron">
          <Icon name="chevron" size={9} />
        </span>
      )}
    </button>
  );
  return (
    <div
      ref={root}
      className={`image-block${menu || panel || previewWidth ? " has-controls" : ""}`}
      data-align={p.align ?? "left"}
      data-animated={animated === null ? "unknown" : String(animated)}
      style={{
        width: previewWidth
          ? `${previewWidth}px`
          : p.width
            ? `${p.width}${p.widthMode === "percent" ? "%" : "px"}`
            : naturalWidth
              ? `${naturalWidth}px`
              : undefined,
      }}
    >
      <div
        className={`image-frame${p.crop ? " is-cropped" : ""}`}
        style={
          p.crop
            ? {
                aspectRatio: String(
                  (sourceRatio * p.crop.width) / p.crop.height,
                ),
              }
            : undefined
        }
      >
        {broken ? (
          <p className="media-missing" role="alert">
            This image can't be displayed.
          </p>
        ) : (
          <img
            src={thumbUrl(node.attrs.hash, 1280)}
            alt={p.alt ?? name}
            role="button"
            tabIndex={0}
            aria-label={`View ${name}`}
            title="Double-click to view image"
            loading="lazy"
            style={
              p.crop
                ? {
                    width: `${100 / p.crop.width}%`,
                    maxWidth: "none",
                    position: "absolute",
                    left: `${(-p.crop.x / p.crop.width) * 100}%`,
                    top: `${(-p.crop.y / p.crop.height) * 100}%`,
                  }
                : undefined
            }
            onLoad={(e) => {
              setSourceRatio(
                e.currentTarget.naturalWidth / e.currentTarget.naturalHeight,
              );
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.focus();
              openViewer();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                openViewer();
              }
            }}
            onError={(e) => {
              if (e.currentTarget.src === url) setBroken(true);
              else e.currentTarget.src = url;
            }}
          />
        )}
        {!broken && (
          <div
            className="image-toolbar"
            role="toolbar"
            aria-label="Image controls"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(editor.isEditable || p.note) && (
              <button
                type="button"
                className={`icon-btn${p.note ? " image-has-note" : ""}`}
                aria-label={
                  p.note ? "View private image note" : "Add private image note"
                }
                title={p.note ? "Private image note" : "Add private image note"}
                onClick={() => perform("note")}
              >
                <Icon name="comment" size={16} />
              </button>
            )}
            {editor.isEditable &&
              button(
                `Alignment: ${p.align ?? "left"}`,
                p.align === "right"
                  ? "alignRight"
                  : p.align === "center"
                    ? "alignCenter"
                    : "alignLeft",
                (e) => {
                  const pos = getPos();
                  if (pos === undefined) return;
                  const box = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    x: box.left,
                    y: box.bottom,
                    items: imageItems(editor, pos, node).filter((i) =>
                      i.label.includes("Align "),
                    ),
                  });
                },
              )}
            {editor.isEditable &&
              button("Edit caption", "caption", () => perform("caption"))}
            {editor.isEditable && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Crop image"
                title={
                  animated
                    ? "Animated images retain their original frames"
                    : "Crop image"
                }
                disabled={animated !== false}
                onClick={() => perform("crop")}
              >
                <Icon name="crop" size={16} />
              </button>
            )}
            {button("View image", "expand", () => openViewer())}
            {button("Save image…", "download", () => perform("save"))}
            {button("More image options", "more", (e) => {
              const pos = getPos();
              if (pos === undefined) return;
              selectBlockAt(editor, pos);
              const box = e.currentTarget.getBoundingClientRect();
              root.current?.dispatchEvent(
                Object.assign(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: box.left,
                    clientY: box.top,
                  }),
                  { imageBlockPos: pos },
                ),
              );
            })}
          </div>
        )}
        {!broken &&
          editor.isEditable &&
          (
            [
              [-1, "left"],
              [1, "right"],
            ] as const
          ).map(([side, label]) => (
            <button
              key={label}
              type="button"
              className={`image-resize image-resize-${label}`}
              aria-label={`Resize image from ${label}`}
              title="Drag to resize; double-click or press Enter for precise width"
              onClick={(e) => {
                e.stopPropagation();
                if (e.detail === 0) perform("width");
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!suppressClick.current) perform("width");
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || !root.current) return;
                e.preventDefault();
                e.stopPropagation();
                const box = root.current.getBoundingClientRect();
                gesture.current = {
                  start: e.clientX,
                  width: root.current.offsetWidth,
                  side,
                  scale: box.width / root.current.offsetWidth,
                  max:
                    root.current.parentElement?.clientWidth ??
                    root.current.offsetWidth,
                  value: root.current.offsetWidth,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const g = gesture.current;
                if (!g) return;
                const n = Math.min(
                  g.max,
                  Math.max(
                    Math.min(80, g.max),
                    g.width +
                      ((e.clientX - g.start) / g.scale) *
                        g.side *
                        (p.align === "center" ? 2 : 1),
                  ),
                );
                g.value = Math.round(n);
                setPreviewWidth(g.value);
              }}
              onPointerUp={(e) => {
                const g = gesture.current;
                gesture.current = null;
                suppressClick.current = !g || g.value !== g.width;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
                if (g && g.value !== g.width) {
                  const pos = getPos();
                  if (pos !== undefined)
                    editor.view.dispatch(
                      closeHistory(editor.state.tr).setNodeAttribute(
                        pos,
                        "presentation",
                        { ...p, width: g.value, widthMode: "px" },
                      ),
                    );
                }
                setPreviewWidth(undefined);
              }}
              onPointerCancel={() => {
                gesture.current = null;
                setPreviewWidth(undefined);
              }}
            />
          ))}
      </div>
      {(p.caption || node.attrs.showName) && (
        <div className="media-caption">{p.caption || name}</div>
      )}
      {panel && (
        <form
          className={`image-edit${panel === "width" ? " image-width-edit" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!editor.isEditable) return;
            if (panel === "width") {
              const width = Number(draft);
              if (!Number.isFinite(width) || width <= 0 || width > 100000) {
                setError("Enter a width from 1 to 100000 pixels.");
                return;
              }
              patch({ width, widthMode: "px" });
              setPanel(null);
              return;
            }
            const link =
              panel === "link" && draft.trim()
                ? normalizeHref(draft)
                : undefined;
            if (panel === "link" && draft.trim() && !link) {
              setError("Enter a valid URL or Suivelle page link.");
              return;
            }
            patch({ [panel]: panel === "link" ? link : draft });
            setPanel(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              setPanel(null);
            }
          }}
        >
          <label>
            {panel === "note"
              ? "Private image note"
              : panel === "width"
                ? "Width in pixels"
                : panel === "alt"
                  ? "Image description"
                  : panel === "link"
                    ? "Page link or URL"
                    : "Caption"}
            {panel === "note" ? (
              <textarea
                aria-label="Private image note"
                autoFocus
                rows={4}
                maxLength={10000}
                readOnly={!editor.isEditable}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <input
                autoFocus
                type={panel === "width" ? "number" : "text"}
                min={panel === "width" ? 1 : undefined}
                max={panel === "width" ? 100000 : undefined}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </label>
          {panel === "note" && (
            <p className="set-hint image-note-hint">
              Private to this workspace. Included in native backups; omitted
              from Markdown and HTML exports.
            </p>
          )}
          {panel === "width" && (
            <div
              className="image-width-presets"
              role="group"
              aria-label="Image width presets"
            >
              {[25, 50, 75, 100].map((width) => (
                <button
                  type="button"
                  className="image-width-preset"
                  key={width}
                  aria-pressed={p.widthMode === "percent" && p.width === width}
                  onClick={() => {
                    patch({ widthMode: "percent", width });
                    setPanel(null);
                  }}
                >
                  {width === 100 ? "Full width" : `${width}%`}
                </button>
              ))}
            </div>
          )}
          <div className="image-edit-actions">
            {editor.isEditable && (
              <button className="btn" type="submit">
                Save
              </button>
            )}
            <button
              className="btn ghost"
              type="button"
              onClick={() => setPanel(null)}
            >
              {editor.isEditable ? "Cancel" : "Close"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="set-hint" role="status">
          {message}
        </p>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {cropOpen && (
        <ImageCrop
          url={url}
          initial={p.crop}
          onApply={(crop) => patch({ crop })}
          onClose={() => setCropOpen(false)}
        />
      )}
    </div>
  );
}
