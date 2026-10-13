import { mergeAttributes, Node } from "@tiptap/core";
import { attachmentUrl } from "../../../lib/attachments";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../../../components/Icon";
import { ipc, toAppError } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";
import type { AttachmentKind } from "../../../types";
import { syncDialog } from "../../../lib/dialog";
import { ImageBlock } from "../ImageBlock";
import { imagePresentation } from "../imageModel";

export const MEDIA_KINDS = ["image", "audio", "video", "file", "pdf"] as const;

const META: Record<
  AttachmentKind,
  { icon: IconName; add: string; noun: string }
> = {
  image: { icon: "image", add: "Add an image", noun: "image" },
  audio: { icon: "audio", add: "Add audio", noun: "audio file" },
  video: { icon: "video", add: "Add a video", noun: "video" },
  file: { icon: "page", add: "Add a file", noun: "file" },
  pdf: { icon: "page", add: "Add a PDF", noun: "PDF" },
};

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Runs the native picker and returns node attributes, or null if the user cancelled. */
export async function pickAttachment(
  kind: AttachmentKind,
): Promise<Record<string, unknown> | null> {
  const store = useWorkspace.getState();
  const ws = store.workspace;
  if (!ws) return null;
  try {
    const att = await ipc.attachmentImport(ws.id, kind);
    return att
      ? {
          attachmentId: att.id,
          hash: att.hash,
          name: att.originalName,
          mime: att.mimeType,
          size: att.size,
        }
      : null;
  } catch (e) {
    store.setError(toAppError(e).message);
    return null;
  }
}

function SaveCopy({
  id,
  label = "Save a copy",
}: {
  id: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        void ipc
          .attachmentSaveAs(id)
          .catch((e) => useWorkspace.getState().setError(toAppError(e).message))
      }
    >
      {label}
    </button>
  );
}

function ImageViewer({
  url,
  name,
  id,
  crop,
  onClose,
}: {
  url: string;
  name: string;
  id: string;
  crop?: import("../imageModel").Crop;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const pan = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const changeZoom = (factor: number) => {
    if (!size.width) return;
    setZoom((current) =>
      Math.min(
        8,
        Math.max(
          0.1,
          (current ??
            Math.min(
              (body.current?.clientWidth ?? size.width) / size.width,
              (body.current?.clientHeight ?? size.height) / size.height,
              1,
            )) * factor,
        ),
      ),
    );
  };
  useEffect(() => {
    const el = body.current;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        changeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      }
    };
    el?.addEventListener("wheel", wheel, { passive: false });
    return () => el?.removeEventListener("wheel", wheel);
  });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ref.current) syncDialog(ref.current, true);
  }, []);
  const close = () => {
    if (ref.current) syncDialog(ref.current, false);
  };
  return createPortal(
    <dialog
      ref={ref}
      className="palette media-viewer"
      closedby="any"
      aria-label={`View ${name}`}
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onCancel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          changeZoom(1.25);
        } else if (e.key === "-") {
          e.preventDefault();
          changeZoom(0.8);
        } else if (e.key === "0") {
          e.preventDefault();
          setZoom(null);
        } else if (
          zoom &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          body.current?.scrollBy({
            left: e.key === "ArrowLeft" ? -40 : e.key === "ArrowRight" ? 40 : 0,
            top: e.key === "ArrowUp" ? -40 : e.key === "ArrowDown" ? 40 : 0,
          });
        }
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < box.left ||
          e.clientX > box.right ||
          e.clientY < box.top ||
          e.clientY > box.bottom
        )
          close();
      }}
    >
      <header className="media-viewer-head">
        <span className="media-viewer-name" title={name}>
          {name}
        </span>
        <div className="image-zoom" role="toolbar" aria-label="Image zoom">
          <button className="btn ghost" onClick={() => setZoom(null)}>
            Fit
          </button>
          <button className="btn ghost" onClick={() => setZoom(1)}>
            Actual size
          </button>
          <button
            className="icon-btn"
            aria-label="Zoom out"
            onClick={() => changeZoom(0.8)}
          >
            −
          </button>
          <span>{zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
          <button
            className="icon-btn"
            aria-label="Zoom in"
            onClick={() => changeZoom(1.25)}
          >
            +
          </button>
        </div>
        {crop && (
          <button
            className="btn"
            onClick={() =>
              void ipc
                .imageSaveCrop(id, crop)
                .catch((e) =>
                  useWorkspace.getState().setError(toAppError(e).message),
                )
            }
          >
            Save displayed image
          </button>
        )}
        <SaveCopy id={id} label={crop ? "Save original" : "Save a copy"} />
        <button
          type="button"
          className="icon-btn"
          aria-label="Close image viewer"
          autoFocus
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>
      <div
        ref={body}
        className={`media-viewer-body${zoom ? " is-zoomed" : ""}`}
        tabIndex={0}
        role="region"
        aria-label="Image viewport"
        onPointerDown={(e) => {
          if (!zoom || e.button !== 0) return;
          e.preventDefault();
          const el = e.currentTarget;
          pan.current = {
            x: e.clientX,
            y: e.clientY,
            left: el.scrollLeft,
            top: el.scrollTop,
          };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const start = pan.current;
          if (!start) return;
          const el = e.currentTarget;
          const scale = el.getBoundingClientRect().width / el.offsetWidth;
          el.scrollLeft = start.left - (e.clientX - start.x) / scale;
          el.scrollTop = start.top - (e.clientY - start.y) / scale;
        }}
        onPointerUp={(e) => {
          pan.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          pan.current = null;
        }}
      >
        {failed ? (
          <div className="media-missing" role="alert">
            <Icon name="warning" />
            <span>
              This image can't be displayed. You can still save a copy.
            </span>
          </div>
        ) : (
          <img
            src={url}
            alt={name}
            draggable={false}
            style={
              zoom
                ? { width: size.width * zoom, height: size.height * zoom }
                : undefined
            }
            onLoad={(e) =>
              setSize({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </dialog>,
    document.body,
  );
}

function MediaView(props: NodeViewProps) {
  const { node, updateAttributes, selected, editor } = props;
  const kind = node.type.name as AttachmentKind;
  const meta = META[kind];
  const a = node.attrs as {
    attachmentId: string | null;
    hash: string | null;
    name: string | null;
    size: number | null;
    showName: boolean | null;
  };
  const [broken, setBroken] = useState(false);
  const [viewing, setViewing] = useState(false);

  if ((node.attrs as { pending?: string | null }).pending) {
    return (
      <NodeViewWrapper className="media" contentEditable={false}>
        <div
          className="media-empty media-pending"
          role="status"
          aria-busy="true"
        >
          <Icon name={meta.icon} />
          <span>Adding “{a.name ?? meta.noun}”…</span>
        </div>
      </NodeViewWrapper>
    );
  }

  if (!a.attachmentId || !a.hash) {
    return (
      <NodeViewWrapper className="media" contentEditable={false}>
        <button
          type="button"
          className="media-empty"
          disabled={!editor.isEditable}
          onClick={async () => {
            const attrs = await pickAttachment(kind);
            if (attrs) updateAttributes(attrs);
          }}
        >
          <Icon name={meta.icon} />
          {meta.add}
        </button>
      </NodeViewWrapper>
    );
  }

  const url = attachmentUrl(a.hash);
  const crop = imagePresentation(node.attrs.presentation).crop;
  const viewUrl = crop
    ? `${url}?crop=${crop.x},${crop.y},${crop.width},${crop.height}`
    : url;
  const name = a.name ?? meta.noun;
  const failed = (
    <div className="media-missing" role="alert">
      <Icon name="warning" />
      <span>
        This {meta.noun} can't be displayed. The stored file may be missing or
        unsupported.
      </span>
    </div>
  );

  let body: React.ReactNode;
  if (broken) body = failed;
  else if (kind === "image")
    body = (
      <ImageBlock
        {...props}
        replace={() => pickAttachment("image")}
        openViewer={() => setViewing(true)}
      />
    );
  else if (kind === "audio")
    body = (
      <audio
        controls
        preload="metadata"
        src={url}
        aria-label={name}
        onError={() => setBroken(true)}
      />
    );
  else if (kind === "video")
    body = (
      <video
        controls
        preload="metadata"
        src={url}
        aria-label={name}
        onError={() => setBroken(true)}
      />
    );
  else if (kind === "pdf")
    body = <iframe src={url} title={name} className="media-pdf" />;
  else
    body = (
      <div className="file-card">
        <Icon name="page" />
        <span className="file-card-name">{name}</span>
        <span className="file-card-size">{formatSize(a.size)}</span>
        <SaveCopy id={a.attachmentId} />
      </div>
    );

  return (
    // The name lives in a tooltip until the image is switched to a visible caption (context menu); never both.
    <NodeViewWrapper
      className={`media media-${kind}${selected ? " is-selected" : ""}`}
      contentEditable={false}
      title={kind !== "file" && !a.showName ? name : undefined}
    >
      {body}
      {kind === "image" && viewing && (
        <ImageViewer
          key={a.hash}
          url={viewUrl}
          crop={crop}
          name={name}
          id={a.attachmentId}
          onClose={() => setViewing(false)}
        />
      )}
      {kind !== "file" &&
        kind !== "image" &&
        !broken &&
        (a.showName || kind === "pdf") && (
          <div className="media-caption">
            {a.showName ? <span>{name}</span> : <span />}
            {kind === "pdf" && <SaveCopy id={a.attachmentId} />}
          </div>
        )}
    </NodeViewWrapper>
  );
}

function makeMedia(name: AttachmentKind) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,

    addAttributes() {
      const attr = { default: null };
      // `pending` marks a block whose file is still being stored. It is never saved.
      return {
        attachmentId: attr,
        hash: attr,
        name: attr,
        mime: attr,
        size: attr,
        ...(name === "image"
          ? {
              presentation: {
                default: null,
                rendered: false,
                parseHTML: (element: HTMLElement) => {
                  try {
                    return imagePresentation(
                      JSON.parse(
                        element.getAttribute("data-image-presentation") ??
                          "null",
                      ),
                    );
                  } catch {
                    return null;
                  }
                },
              },
            }
          : {}),
        showName: { default: false, rendered: false },
        pending: { default: null, rendered: false },
      };
    },

    parseHTML() {
      return [{ tag: `div[data-media="${name}"]` }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        "div",
        mergeAttributes(
          { "data-media": name },
          HTMLAttributes,
          name === "image"
            ? {
                "data-image-presentation": JSON.stringify(
                  imagePresentation(node.attrs.presentation),
                ),
              }
            : {},
        ),
      ];
    },

    addNodeView() {
      return ReactNodeViewRenderer(MediaView);
    },
  });
}

export const MediaNodes = MEDIA_KINDS.map(makeMedia);
