import { useState } from "react";
import type { UsageBucket } from "./types";

export function UsageTrend({ series, total, hourly = false, formatTokens }: { series: UsageBucket[]; total: number; hourly?: boolean; formatTokens: (value: number) => string }) {
  const [dismissedBucket, setDismissedBucket] = useState<string | null>(null);
  const peakBucket = Math.max(1, ...series.map((b) => b.outputTokens + b.inputTokens + (hourly ? 0 : b.savedTokens)));
  const tickMagnitude = 10 ** Math.floor(Math.log10(peakBucket / 3));
  const tickStep = ([1, 2, 5, 10].find((step) => step * tickMagnitude >= peakBucket / 3) ?? 10) * tickMagnitude;
  const chartMax = tickStep * 3;
  const labelStride = Math.max(1, Math.ceil((series.length - 1) / 6));
  return (
    <section className="agx-usage-section" aria-label={hourly ? "Hourly token usage" : "Token trend"}>
      <div className="agx-usage-subhead">
        <h4>{hourly ? "Hour by hour (last 24 hours)" : "Activity and savings trend"}</h4>
        <span className="agx-trend-total">{total.toLocaleString()} <small>context tokens</small></span>
      </div>
      <div className="agx-trend-legend">
        <span className="agx-legend">
          <span className="agx-dot used" aria-hidden="true" /> {hourly ? "Input" : "Context tokens"}
          <span className="agx-dot saved" aria-hidden="true" /> {hourly ? "Output" : "Saved"}
        </span>
      </div>
      <div className="agx-trend">
        <div className="agx-trend-scale" aria-hidden="true">
          {[3, 2, 1, 0].map((tick) => <span key={tick}>{formatTokens(tick * tickStep)}</span>)}
        </div>
        <div className="agx-trend-plot">
          <div className="agx-trend-grid" aria-hidden="true">
            {[3, 2, 1, 0].map((tick) => <span key={tick} />)}
          </div>
          <div className="agx-trend-columns">
            {series.map((b, index) => {
              const used = hourly ? b.inputTokens : b.outputTokens + b.inputTokens;
              const upper = hourly ? b.outputTokens : b.savedTokens;
              const hour = hourly ? new Date(`${b.key}:00:00Z`) : null;
              const label = hour && !Number.isNaN(hour.getTime()) ? hour.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }) : b.label;
              const usedPct = (used / chartMax) * 100;
              const savedPct = (upper / chartMax) * 100;
              return (
                <button
                  key={b.key}
                  type="button"
                  className={`agx-trend-col${dismissedBucket === b.key ? " dismissed" : ""}`}
                  onPointerEnter={() => setDismissedBucket(null)}
                  onFocus={() => setDismissedBucket(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setDismissedBucket(b.key);
                    }
                  }}
                  aria-label={`${label}: ${(b.inputTokens + b.outputTokens).toLocaleString()} context tokens (${b.outputTokens.toLocaleString()} out, ${b.inputTokens.toLocaleString()} in), ${b.savedTokens.toLocaleString()} saved across ${b.calls} calls`}
                >
                  <span className="agx-trend-bars" aria-hidden="true">
                    {upper > 0 && (
                      <span
                        className="agx-trend-bar saved"
                        style={{ height: `${savedPct}%` }}
                      />
                    )}
                    {used > 0 && (
                      <span
                        className="agx-trend-bar used"
                        style={{ height: `${usedPct}%` }}
                      />
                    )}
                  </span>
                  <span className="agx-trend-tooltip" aria-hidden="true" style={{ left: `clamp(0px, calc(${((index + 0.5) / series.length) * 100}% - 110px), calc(100% - 220px))` }}>
                    <strong>{label}</strong>
                    <span><span><i className="agx-dot used" />{hourly ? "Input" : "Context tokens"}</span><b>{used.toLocaleString()}</b></span>
                    {!hourly && <span className="agx-trend-detail">{b.outputTokens.toLocaleString()} out · {b.inputTokens.toLocaleString()} in</span>}
                    <span><span><i className="agx-dot saved" />{hourly ? "Output" : "Saved"}</span><b>{upper.toLocaleString()}</b></span>
                    <span className="agx-trend-tooltip-total">{hourly ? "Total" : "Calls"} <b>{(hourly ? b.inputTokens + b.outputTokens : b.calls).toLocaleString()}</b></span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="agx-trend-labels" aria-hidden="true">
            {series.map((b, index) => <span key={b.key}>{(index % labelStride === 0 && index < series.length - Math.max(1, labelStride / 2)) || index === series.length - 1 ? (hourly ? new Date(`${b.key}:00:00Z`).toLocaleTimeString(undefined, { hour: "numeric" }) : b.label) : ""}</span>)}
          </div>
        </div>
      </div>
    </section>
  );
}
