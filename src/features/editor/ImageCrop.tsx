import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { syncDialog } from "../../lib/dialog";
import { radioKeys } from "../settings/radioKeys";
import type { Crop } from "./imageModel";

const cropHandles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type CropHandle = (typeof cropHandles)[number];

export function resizeCrop(
  crop: Crop,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null,
  sourceRatio: number,
): Crop {
  const west = handle.includes("w"),
    east = handle.includes("e");
  const north = handle.includes("n"),
    south = handle.includes("s");
  const centerX = crop.x + crop.width / 2,
    centerY = crop.y + crop.height / 2;
  const maxWidth = west
    ? crop.x + crop.width
    : east
      ? 1 - crop.x
      : 2 * Math.min(centerX, 1 - centerX);
  const maxHeight = north
    ? crop.y + crop.height
    : south
      ? 1 - crop.y
      : 2 * Math.min(centerY, 1 - centerY);
  let width =
    west || east ? Math.max(0.01, crop.width + (west ? -dx : dx)) : crop.width;
  let height =
    north || south
      ? Math.max(0.01, crop.height + (north ? -dy : dy))
      : crop.height;
  if (ratio) {
    const relative = ratio / sourceRatio;
    const useWidth =
      (west || east) &&
      (!(north || south) || Math.abs(dx) >= Math.abs(dy * relative));
    width = Math.min(
      useWidth ? width : height * relative,
      maxWidth,
      maxHeight * relative,
    );
    height = width / relative;
  } else {
    width = Math.min(width, maxWidth);
    height = Math.min(height, maxHeight);
  }
  return {
    x: west ? crop.x + crop.width - width : east ? crop.x : centerX - width / 2,
    y: north
      ? crop.y + crop.height - height
      : south
        ? crop.y
        : centerY - height / 2,
    width,
    height,
  };
}

export function presetCrop(
  current: Crop,
  ratio: number | null,
  sourceRatio: number,
): Crop {
  if (!ratio) return current;
  const relative = ratio / sourceRatio;
  let width = current.width,
    height = width / relative;
  if (height > current.height) {
    height = current.height;
    width = height * relative;
  }
  return {
    x: Math.max(
      0,
      Math.min(1 - width, current.x + (current.width - width) / 2),
    ),
    y: Math.max(
      0,
      Math.min(1 - height, current.y + (current.height - height) / 2),
    ),
    width,
    height,
  };
}

export function ImageCrop({
  url,
  initial,
  onApply,
  onClose,
}: {
  url: string;
  initial?: Crop;
  onApply: (crop?: Crop) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [crop, setCrop] = useState<Crop>(
    initial ?? { x: 0, y: 0, width: 1, height: 1 },
  );
  const [preset, setPreset] = useState("free");
  const [sourceRatio, setSourceRatio] = useState(1);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{
    x: number;
    y: number;
    crop: Crop;
    mode: string;
  } | null>(null);
  useEffect(() => {
    if (dialog.current) syncDialog(dialog.current, true);
  }, []);
  const close = () => {
    if (dialog.current) syncDialog(dialog.current, false);
  };
  const ratio =
    preset === "original"
      ? sourceRatio
      : preset === "square"
        ? 1
        : preset === "4:3"
          ? 4 / 3
          : preset === "16:9"
            ? 16 / 9
            : null;
  const edit = (key: keyof Crop, value: number) => {
    if (!Number.isFinite(value)) return;
    setCrop((c) => {
      const next = {
        ...c,
        [key]: Math.max(
          key === "width" || key === "height" ? 0.01 : 0,
          Math.min(1, value),
        ),
      };
      next.width = Math.min(next.width, 1 - next.x);
      next.height = Math.min(next.height, 1 - next.y);
      if (next.width <= 0 || next.height <= 0) return c;
      return presetCrop(next, ratio, sourceRatio);
    });
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="palette image-crop-dialog"
      aria-label="Crop image"
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onCancel={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="media-viewer-head">
        <strong>Crop image</strong>
      </header>
      <div className="image-crop-content">
        <div className="image-crop-preview">
          <div
            className="image-crop-source"
            style={{
              width: `min(100%, calc((var(--crop-preview-height) - 48px) * ${sourceRatio}))`,
            }}
            onPointerDown={(e) => {
              const target = e.target as HTMLElement;
              const mode =
                target.dataset.cropResize ??
                (target.dataset.cropMove ? "move" : null);
              if (e.button !== 0 || failed || !mode) return;
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              drag.current = {
                x: (e.clientX - box.left) / box.width,
                y: (e.clientY - box.top) / box.height,
                crop,
                mode,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const box = e.currentTarget.getBoundingClientRect();
              const dx = (e.clientX - box.left) / box.width - d.x,
                dy = (e.clientY - box.top) / box.height - d.y;
              if (d.mode === "move")
                setCrop({
                  ...d.crop,
                  x: Math.min(1 - d.crop.width, Math.max(0, d.crop.x + dx)),
                  y: Math.min(1 - d.crop.height, Math.max(0, d.crop.y + dy)),
                });
              else {
                setCrop(
                  resizeCrop(
                    d.crop,
                    d.mode as CropHandle,
                    dx,
                    dy,
                    ratio,
                    sourceRatio,
                  ),
                );
              }
            }}
            onPointerUp={(e) => {
              drag.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <img
              src={url}
              alt="Original for cropping"
              draggable={false}
              onLoad={(e) =>
                setSourceRatio(
                  e.currentTarget.naturalWidth / e.currentTarget.naturalHeight,
                )
              }
              onError={() => setFailed(true)}
            />
            {!failed && (
              <>
                <div
                  className="image-crop-shade"
                  style={{ inset: `0 0 ${100 - crop.y * 100}% 0` }}
                />
                <div
                  className="image-crop-shade"
                  style={{ inset: `${(crop.y + crop.height) * 100}% 0 0 0` }}
                />
                <div
                  className="image-crop-shade"
                  style={{
                    top: `${crop.y * 100}%`,
                    left: 0,
                    width: `${crop.x * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                />
                <div
                  className="image-crop-shade"
                  style={{
                    top: `${crop.y * 100}%`,
                    right: 0,
                    width: `${Math.max(0, 1 - crop.x - crop.width) * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                />
                <div
                  className="image-crop-selection"
                  data-crop-move="true"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                >
                  <div className="image-crop-grid" aria-hidden="true">
                    {[1, 2].map((third) => (
                      <span
                        key={`vertical-${third}`}
                        className="image-crop-guide vertical"
                        style={{ left: `${(third / 3) * 100}%` }}
                      />
                    ))}
                    {[1, 2].map((third) => (
                      <span
                        key={`horizontal-${third}`}
                        className="image-crop-guide horizontal"
                        style={{ top: `${(third / 3) * 100}%` }}
                      />
                    ))}
                  </div>
                  {cropHandles.map((handle) => (
                    <span
                      key={handle}
                      className="image-crop-handle"
                      data-crop-resize={handle}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          {failed && (
            <p role="alert" className="field-error">
              The original image could not be loaded.
            </p>
          )}
        </div>
        <div className="image-crop-controls">
          <div className="image-crop-options">
            <div className="image-crop-ratio-label">Aspect ratio</div>
            <div
              className="image-crop-ratios"
              role="radiogroup"
              aria-label="Aspect ratio"
              onKeyDown={radioKeys}
            >
              {[
                ["free", "Freeform"],
                ["original", "Original"],
                ["square", "Square"],
                ["4:3", "4:3"],
                ["16:9", "16:9"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={preset === value}
                  tabIndex={preset === value ? 0 : -1}
                  onClick={() => {
                    setPreset(value);
                    setCrop((c) =>
                      presetCrop(
                        c,
                        value === "original"
                          ? sourceRatio
                          : value === "square"
                            ? 1
                            : value === "4:3"
                              ? 4 / 3
                              : value === "16:9"
                                ? 16 / 9
                                : null,
                        sourceRatio,
                      ),
                    );
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="image-crop-values">
              {(["x", "y", "width", "height"] as const).map((key) => (
                <label key={key}>
                  {key === "x"
                    ? "Left (%)"
                    : key === "y"
                      ? "Top (%)"
                      : `${key === "width" ? "Width" : "Height"} (%)`}
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(crop[key] * 10000) / 100}
                    onChange={(e) => edit(key, Number(e.target.value) / 100)}
                  />
                </label>
              ))}
            </div>
            <p className="set-hint">
              Drag inside the selection to move it; drag an edge or corner
              handle to resize. The original is preserved.
            </p>
          </div>
          <footer className="image-crop-actions">
            <button
              className="btn ghost"
              onClick={() => {
                setCrop({ x: 0, y: 0, width: 1, height: 1 });
                setPreset("free");
              }}
            >
              Reset crop
            </button>
            <div className="image-crop-confirm">
              <button className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={failed}
                onClick={() => {
                  onApply(
                    crop.x === 0 &&
                      crop.y === 0 &&
                      crop.width === 1 &&
                      crop.height === 1
                      ? undefined
                      : crop,
                  );
                  close();
                }}
              >
                Apply crop
              </button>
            </div>
          </footer>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
