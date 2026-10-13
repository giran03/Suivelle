export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ImagePresentation {
  align?: "left" | "center" | "right";
  width?: number;
  widthMode?: "px" | "percent";
  caption?: string;
  alt?: string;
  link?: string;
  crop?: Crop;
  note?: string;
}

export function imagePresentation(raw: unknown): ImagePresentation {
  const a = raw && typeof raw === "object" ? (raw as ImagePresentation) : {};
  const out: ImagePresentation = {};
  if (["left", "center", "right"].includes(a.align ?? "")) out.align = a.align;
  if (
    typeof a.width === "number" &&
    Number.isFinite(a.width) &&
    a.width > 0 &&
    a.width <= 100000
  ) {
    out.widthMode = a.widthMode === "percent" ? "percent" : "px";
    out.width = out.widthMode === "percent" ? Math.min(100, a.width) : a.width;
  }
  for (const key of ["caption", "alt", "link", "note"] as const)
    if (typeof a[key] === "string") out[key] = a[key].slice(0, 10000);
  const c = a.crop;
  if (
    c &&
    [c.x, c.y, c.width, c.height].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) &&
    c.x >= 0 &&
    c.y >= 0 &&
    c.width > 0 &&
    c.height > 0 &&
    c.x + c.width <= 1.000001 &&
    c.y + c.height <= 1.000001
  )
    out.crop = c;
  return out;
}
