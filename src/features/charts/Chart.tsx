import { useEffect, useMemo, useState } from "react";
import type { ChartData, ChartSpec, Property } from "../../types";
import "./charts.css";
import { arcPath, buildModel, clip, compactNumber, describeChart, fullNumber, niceScale, type ChartModel } from "./chartModel";
import { IconSwap } from "../../components/Swap";
import { PopNumber } from "../../components/Feedback";

const M = { top: 14, right: 14, bottom: 34, left: 46 };
const tone = (t: string) => `var(--tone-${t})`;

function useSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    const read = () => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size] as const;
}

interface Hover {
  ci: number;
  x: number;
  y: number;
}

function Tooltip({ model, hover, spec }: { model: ChartModel; hover: Hover; spec: ChartSpec }) {
  const cat = model.categories[hover.ci];
  const multi = model.series.length > 1;
  return (
    <div className="chart-tip" role="presentation" style={{ left: hover.x, top: hover.y }}>
      <b>{cat.label}</b>
      {model.series.map((s, si) => (
        <div key={s.key} className="chart-tip-row">
          <i style={{ background: tone(s.tone) }} aria-hidden="true" />
          <span>{multi ? s.label : model.valueLabel}</span>
          <span className="chart-tip-num">{fullNumber(model.values[si][hover.ci])}</span>
        </div>
      ))}
      {multi && model.stackable && (
        <div className="chart-tip-row total">
          <span>Total</span>
          <span className="chart-tip-num">{fullNumber(model.totals[hover.ci])}</span>
        </div>
      )}
      {spec.aggregation !== "count" && <div className="chart-tip-note">{model.records[hover.ci].toLocaleString()} records</div>}
    </div>
  );
}

function Cartesian({ spec, model, w, h }: { spec: ChartSpec; model: ChartModel; w: number; h: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const n = model.categories.length;
  const kind = spec.chartType as "bar" | "line" | "area";
  const horizontal = kind === "bar" && n > 8;
  const longest = Math.max(...model.categories.map((c) => c.label.length), 1);
  const left = horizontal ? Math.min(170, Math.max(70, longest * 6.4 + 12)) : M.left;
  const bottom = horizontal ? 28 : M.bottom;
  const pw = Math.max(40, w - left - M.right);
  const ph = Math.max(40, h - M.top - bottom);

  const max = model.stackable ? Math.max(...model.totals, 0) : Math.max(...model.values.flat(), 0);
  const scale = niceScale(max);
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
  const band = (horizontal ? ph : pw) / Math.max(n, 1);
  const val = (v: number) => (horizontal ? (v / scale.max) * pw : (v / scale.max) * ph);
  const labelStep = horizontal ? Math.max(1, Math.ceil(13 / band)) : n <= 8 ? 1 : Math.max(1, Math.ceil(46 / band));
  const maxChars = horizontal ? 24 : Math.max(3, Math.floor((band * labelStep) / 6));

  const bandStart = (ci: number) => ci * band;
  const px = (ci: number) => left + (horizontal ? 0 : bandStart(ci) + band / 2);

  const showTip = (ci: number, e: React.PointerEvent) => {
    const target = e.currentTarget as SVGElement;
    const box = (target.ownerSVGElement ?? target).getBoundingClientRect();
    setHover({ ci, x: Math.min(e.clientX - box.left + 12, w - 170), y: Math.max(0, e.clientY - box.top - 8) });
  };

  const bars = model.categories.flatMap((cat, ci) => {
    const inner = Math.min(band * 0.7, 56);
    const gap = (band - inner) / 2;
    const sub = model.stackable ? inner : inner / model.series.length;
    let acc = 0;
    return model.series.map((s, si) => {
      const v = model.values[si][ci];
      const from = model.stackable ? acc : 0;
      if (model.stackable) acc += v;
      const len = val(v);
      const off = model.stackable ? 0 : si * sub;
      const along = bandStart(ci) + gap + off;
      const rect = horizontal
        ? { x: left + val(from), y: M.top + along, width: len, height: sub }
        : { x: left + along, y: M.top + ph - val(from) - len, width: sub, height: len };
      const fill = model.series.length === 1 && cat.tone ? tone(cat.tone) : tone(s.tone);
      return <rect key={`${ci}-${s.key}`} {...rect} width={Math.max(0, rect.width)} height={Math.max(0, rect.height)} fill={fill} stroke="var(--bg)" strokeWidth={model.stackable && model.series.length > 1 ? 1 : 0} rx={2} />;
    });
  });

  const lineY = (v: number) => M.top + ph - val(v);
  const stackedTop = (si: number, ci: number) => model.values.slice(0, si + 1).reduce((a, row) => a + row[ci], 0);
  const lines =
    kind === "bar"
      ? null
      : model.series.map((s, si) => {
          const top = (ci: number) => (kind === "area" && model.stackable ? stackedTop(si, ci) : model.values[si][ci]);
          const base = (ci: number) => (kind === "area" && model.stackable && si > 0 ? stackedTop(si - 1, ci) : 0);
          const pts = model.categories.map((_, ci) => [px(ci), lineY(top(ci))] as const);
          const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
          const area = kind === "area" ? `${line}${[...model.categories.keys()].reverse().map((ci) => `L${px(ci).toFixed(1)} ${lineY(base(ci)).toFixed(1)}`).join("")}Z` : null;
          return (
            <g key={s.key}>
              {area && <path d={area} fill={tone(s.tone)} fillOpacity={model.stackable ? 0.78 : 0.3} />}
              <path d={line} fill="none" stroke={tone(s.tone)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.length <= 40 && pts.map(([x, y], ci) => <circle key={ci} cx={x} cy={y} r={3} fill="var(--bg)" stroke={tone(s.tone)} strokeWidth={2} />)}
            </g>
          );
        });

  return (
    <>
      <svg width={w} height={h} role="presentation" onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const pos = horizontal ? left + val(t) : M.top + ph - val(t);
          return (
            <g key={t}>
              {horizontal ? <line x1={pos} x2={pos} y1={M.top} y2={M.top + ph} className="chart-grid" /> : <line x1={left} x2={left + pw} y1={pos} y2={pos} className="chart-grid" />}
              {horizontal ? (
                <text x={pos} y={h - 8} textAnchor="middle" className="chart-tick">
                  {compactNumber(t)}
                </text>
              ) : (
                <text x={left - 8} y={pos + 4} textAnchor="end" className="chart-tick">
                  {compactNumber(t)}
                </text>
              )}
            </g>
          );
        })}
        {bars}
        {lines}
        {model.categories.map((c, ci) =>
          ci % labelStep ? null : horizontal ? (
            <text key={c.key} x={left - 8} y={M.top + bandStart(ci) + band / 2 + 4} textAnchor="end" className="chart-label">
              {clip(c.label, maxChars)}
            </text>
          ) : (
            <text key={c.key} x={px(ci)} y={M.top + ph + 18} textAnchor="middle" className="chart-label">
              {clip(c.label, maxChars)}
            </text>
          ),
        )}
        {model.categories.map((c, ci) => (
          <rect
            key={c.key}
            x={horizontal ? left : left + bandStart(ci)}
            y={horizontal ? M.top + bandStart(ci) : M.top}
            width={horizontal ? pw : band}
            height={horizontal ? band : ph}
            fill={hover?.ci === ci ? "var(--fg)" : "transparent"}
            fillOpacity={0.06}
            onPointerMove={(e) => showTip(ci, e)}
          />
        ))}
      </svg>
      {hover && <Tooltip model={model} hover={hover} spec={spec} />}
    </>
  );
}

function Radial({ spec, model, w, h }: { spec: ChartSpec; model: ChartModel; w: number; h: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = model.totals.reduce((a, b) => a + b, 0);
  const r = Math.max(30, Math.min(w, h) / 2 - 10);
  const cx = w / 2;
  const cy = h / 2;
  let angle = 0;
  const slices = model.categories.map((c, i) => {
    const v = model.totals[i];
    const a0 = angle;
    angle += total > 0 ? (v / total) * Math.PI * 2 : 0;
    const fill = c.tone ? tone(c.tone) : tone(["violet", "blue", "green", "orange", "red", "gray"][i % 6]);
    return { c, v, a0, a1: angle, fill };
  });
  return (
    <svg width={w} height={h} role="presentation" onPointerLeave={() => setHover(null)}>
      {slices
        .filter((s) => s.v > 0)
        .map((s) => {
          const i = slices.indexOf(s);
          return (
            <path
              key={s.c.key}
              d={arcPath(cx, cy, hover === i ? r + 4 : r, spec.chartType === "donut" ? r * 0.62 : 0, s.a0, s.a1)}
              fill={s.fill}
              stroke="var(--bg)"
              strokeWidth={2}
              data-tooltip={`${s.c.label}: ${fullNumber(s.v)} (${Math.round((s.v / total) * 100)}%)`}
              aria-label={`${s.c.label}: ${fullNumber(s.v)} (${Math.round((s.v / total) * 100)}%)`}
              onPointerEnter={() => setHover(i)}
            />
          );
        })}
      {spec.chartType === "donut" && (
        <>
          <text x={cx} y={cy + 2} textAnchor="middle" className="chart-center">
            {hover !== null ? compactNumber(slices[hover].v) : compactNumber(total)}
          </text>
          <text x={cx} y={cy + 20} textAnchor="middle" className="chart-tick">
            {hover !== null ? clip(slices[hover].c.label, 18) : model.valueLabel}
          </text>
        </>
      )}
    </svg>
  );
}

function Legend({ spec, model }: { spec: ChartSpec; model: ChartModel }) {
  const radial = spec.chartType === "pie" || spec.chartType === "donut";
  const total = model.totals.reduce((a, b) => a + b, 0);
  const items = radial
    ? model.categories.map((c, i) => ({ key: c.key, label: c.label, color: c.tone ? tone(c.tone) : tone(["violet", "blue", "green", "orange", "red", "gray"][i % 6]), note: `${fullNumber(model.totals[i])}${total > 0 ? ` · ${Math.round((model.totals[i] / total) * 100)}%` : ""}` }))
    : model.series.length > 1
      ? model.series.map((s) => ({ key: s.key, label: s.label, color: tone(s.tone), note: "" }))
      : [];
  if (items.length === 0) return null;
  return (
    <ul className="chart-legend" aria-label="Legend">
      {items.map((it) => (
        <li key={it.key}>
          <i style={{ background: it.color }} aria-hidden="true" />
          <span className="chart-legend-label">{it.label}</span>
          {it.note && <span className="chart-legend-note">{it.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The same numbers as text, for reading, screen readers and copying. */
export function ChartTable({ model, xName }: { model: ChartModel; xName: string }) {
  const multi = model.series.length > 1;
  return (
    <div className="chart-table-wrap">
      <table className="chart-table">
        <thead>
          <tr>
            <th scope="col">{xName}</th>
            {model.series.map((s) => (
              <th key={s.key} scope="col" className="num">
                {multi ? s.label : model.valueLabel}
              </th>
            ))}
            {multi && model.stackable && (
              <th scope="col" className="num">
                Total
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {model.categories.map((c, ci) => (
            <tr key={c.key}>
              <th scope="row">{c.label}</th>
              {model.series.map((s, si) => (
                <td key={s.key} className="num">
                  {fullNumber(model.values[si][ci])}
                </td>
              ))}
              {multi && model.stackable && <td className="num">{fullNumber(model.totals[ci])}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A chart drawn as SVG from a query result. Bars, lines and areas share one set of axes; pies and
 * donuts have a legend with values; a number shows one figure. Every chart has a table twin.
 */
export function Chart({ spec, props, data, compact = false }: { spec: ChartSpec; props: Property[]; data: ChartData; compact?: boolean }) {
  const model = useMemo(() => buildModel(spec, props, data), [spec, props, data]);
  const [box, size] = useSize<HTMLDivElement>();
  const [asTable, setAsTable] = useState(false);
  const name = describeChart(spec, props);
  const xName = props.find((p) => p.id === spec.xPropertyId)?.name ?? "Category";

  if (spec.chartType === "kpi") {
    const p = data.points[0];
    const value = p ? (spec.aggregation === "count" ? p.count : p.value) : 0;
    return (
      <figure className={`kpi${compact ? " compact" : ""}`} aria-label={name}>
        <div className="kpi-number"><PopNumber text={value === null || value === undefined ? "–" : fullNumber(value)} /></div>
        <figcaption className="kpi-label">{model.valueLabel}</figcaption>
        {spec.aggregation !== "count" && <div className="kpi-sub">{data.records.toLocaleString()} {data.records === 1 ? "record" : "records"}</div>}
      </figure>
    );
  }
  if (model.empty) return <p className="chart-empty">No records match, so there is nothing to chart.</p>;

  const radial = spec.chartType === "pie" || spec.chartType === "donut";
  return (
    <figure className={`chart${compact ? " compact" : ""}`} aria-label={name}>
      <button type="button" className="icon-btn chart-toggle" aria-pressed={asTable} aria-label={asTable ? "Show the chart" : "Show the data as a table"} title={asTable ? "Show the chart" : "Show as a table"} onClick={() => setAsTable((v) => !v)}>
        <IconSwap name={asTable ? "columns" : "table"} size={14} />
      </button>
      {asTable ? (
        <ChartTable model={model} xName={xName} />
      ) : (
        <>
          <div className={`chart-plot${radial ? " radial" : ""}`} ref={box} role="img" aria-label={`${name}. ${model.categories.slice(0, 6).map((c, i) => `${c.label}: ${fullNumber(model.totals[i])}`).join("; ")}${model.categories.length > 6 ? "; and more" : ""}.`}>
            {size.w > 0 && size.h > 0 && (radial ? <Radial spec={spec} model={model} w={size.w} h={size.h} /> : <Cartesian spec={spec} model={model} w={size.w} h={size.h} />)}
          </div>
          <Legend spec={spec} model={model} />
          {data.truncated && <p className="chart-note">Only the first {data.points.length.toLocaleString()} groups are shown. Narrow the chart with a filter.</p>}
        </>
      )}
    </figure>
  );
}
