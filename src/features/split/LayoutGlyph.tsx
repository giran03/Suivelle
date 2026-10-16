import { paneCount, presetTree, type LayoutId } from "./layouts";
import { rects } from "./tree";

/** A tiny drawing of a layout, built from the same tree the real split uses. */
export function LayoutGlyph({ id, panes, width = 28, height = 20 }: { id: LayoutId; panes?: number; width?: number; height?: number }) {
  const n = id === "tiled" ? panes ?? 4 : paneCount(id);
  const spots = rects(presetTree(id, n));
  const pad = 1.5;
  const gap = 1.5;
  const w = width - pad * 2;
  const h = height - pad * 2;
  return (
    <svg className="layout-glyph" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {[...spots].map(([p, r]) => {
        const x = pad + r.x * w + (r.x > 0 ? gap / 2 : 0);
        const y = pad + r.y * h + (r.y > 0 ? gap / 2 : 0);
        const x2 = pad + (r.x + r.w) * w - (r.x + r.w < 0.999 ? gap / 2 : 0);
        const y2 = pad + (r.y + r.h) * h - (r.y + r.h < 0.999 ? gap / 2 : 0);
        return <rect key={p} x={x} y={y} width={Math.max(1, x2 - x)} height={Math.max(1, y2 - y)} rx={1.5} className={p === 0 ? "main" : undefined} />;
      })}
    </svg>
  );
}
