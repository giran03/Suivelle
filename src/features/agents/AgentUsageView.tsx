import { useCallback, useEffect, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { ipc, toAppError } from "../../lib/ipc";
import { useAgents } from "./store";
import { UsageTrend } from "./UsageTrend";
import type { AgentUsage, UsageRange, UsageReport } from "./types";

const RANGES: [UsageRange, string][] = [
  ["24h", "24h"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["all", "All time"],
];

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatAgentUsageLine(u: AgentUsage | undefined): string | null {
  if (!u || u.calls <= 0) return null;
  const parts = [
    `${formatTokens(u.totalTokens)} tokens (${formatTokens(u.outputTokens)} out, ${formatTokens(u.inputTokens)} in)`,
  ];
  if (u.savedTokens > 0) {
    parts.push(`${formatTokens(u.savedTokens)} saved (${u.savingsPct}%)`);
  }
  if (u.jevCalls > 0 || u.jevCacheHits > 0) {
    parts.push(
      `Jev: ${u.jevCalls} API${u.jevCacheHits > 0 ? `, ${u.jevCacheHits} cached` : ""}`,
    );
  }
  parts.push(`${u.calls.toLocaleString()} call${u.calls === 1 ? "" : "s"} · avg ${u.avgDurationMs} ms`);
  return parts.join(" · ");
}

const shortTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function AgentUsageView({
  mode,
  jevConfigured,
  initialReport,
  onChanged,
}: {
  mode: "compact" | "full";
  jevConfigured?: boolean;
  initialReport?: UsageReport | null;
  onChanged?: (next: UsageReport) => void;
}) {
  const epoch = useAgents((s) => s.epoch);
  const [range, setRange] = useState<UsageRange>(initialReport?.range ?? "7d");
  const [agentId, setAgentId] = useState<string>("");
  const [report, setReport] = useState<UsageReport | null>(initialReport ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (r: UsageRange, aid: string) => {
      try {
        setError(null);
        const next = await ipc.agentsUsage(r, aid || null);
        setReport(next);
        onChanged?.(next);
      } catch (e) {
        setError(toAppError(e).message);
      }
    },
    [onChanged],
  );

  useEffect(() => {
    void load(range, agentId);
  }, [load, range, agentId, epoch]);

  const clearHistory = async () => {
    const scopeLabel =
      agentId && report
        ? (report.agents.find((a) => a.agentId === agentId)?.agentName ?? "this agent")
        : "all agents";
    if (!window.confirm(`Clear recorded token and Jev usage history for ${scopeLabel}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.agentsUsageClear(agentId || null);
      await load(range, agentId);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (!report) {
    return error ? <p className="field-error" role="alert">{error}</p> : <p className="picker-muted">Loading usage…</p>;
  }

  const t = report.totals;
  const showJev = Boolean(jevConfigured || t.jevCalls > 0 || t.jevCacheHits > 0 || t.jevErrors > 0 || t.jevPruned > 0);
  const peakAgent = Math.max(1, ...report.agents.map((a) => a.totalTokens + a.savedTokens));
  const visibleAgents = mode === "compact" ? report.agents.slice(0, 6) : report.agents;

  return (
    <div className={`agx-usage${mode === "full" ? " full" : ""}`}>
      <div className="agx-usage-head">
        <p className="picker-muted">
          {mode === "full"
            ? "Estimated tokens (~4 characters per token) sent to and returned from Suivelle across connected agents, plus context tokens saved by Jev filtering and unchanged-page skips."
            : "Estimated tokens (~4 characters per token) returned to connected agents and saved by Jev filtering and unchanged-page skips."}
        </p>
        <div className="agx-usage-controls">
          {mode === "full" && report.agents.length > 1 && (
            <select
              className="agx-usage-select"
              aria-label="Filter by agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">All agents</option>
              {report.agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.agentName}{a.clientName ? ` (${a.clientName})` : ""}
                </option>
              ))}
            </select>
          )}
          <div className="seg" role="radiogroup" aria-label="Usage time range">
            {RANGES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={range === id}
                className={range === id ? "on" : ""}
                onClick={() => setRange(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "compact" && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void import("../settings/store").then((m) => m.useSettingsDialog.getState().hide());
                useAgents.getState().show("usage");
              }}
            >
              Full analytics…
            </button>
          )}
          {!READ_ONLY && t.calls > 0 && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void clearHistory()}>
              {busy ? "Clearing…" : "Clear history"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}

      <dl className="health-stats agx-usage-stats">
        <div>
          <dt>Context tokens</dt>
          <dd>
            {formatTokens(t.totalTokens)}{" "}
            <small>({formatTokens(t.outputTokens)} out · {formatTokens(t.inputTokens)} in)</small>
          </dd>
        </div>
        <div>
          <dt>Tokens saved</dt>
          <dd>
            {formatTokens(t.savedTokens)}{" "}
            <small>({t.savingsPct > 0 ? `${t.savingsPct}% smaller` : "0%"})</small>
          </dd>
        </div>
        <div>
          <dt>MCP calls</dt>
          <dd>
            {t.calls.toLocaleString()}{" "}
            <small>
              ({t.avgDurationMs} ms avg{t.errors > 0 ? ` · ${t.errors} failed` : ""})
            </small>
          </dd>
        </div>
        <div>
          <dt>Jev memory filter</dt>
          <dd>
            {showJev ? (
              <>
                {formatTokens(t.jevTokens)} tokens{" "}
                <small>
                  ({t.jevCalls} API{t.jevCacheHits > 0 ? ` · ${t.jevCacheHits} cached` : ""}
                  {t.jevAvgMs > 0 ? ` · ${t.jevAvgMs} ms` : ""})
                </small>
              </>
            ) : (
              <>
                Off <small>(local search)</small>
              </>
            )}
          </dd>
        </div>
        {showJev && (
          <div>
            <dt>Jev decisions</dt>
            <dd>
              {t.jevPruned.toLocaleString()} pruned{" "}
              <small>
                ({t.jevQuestions.toLocaleString()} questions
                {t.jevErrors > 0 ? ` · ${t.jevErrors} fallback` : ""})
              </small>
            </dd>
          </div>
        )}
      </dl>

      {mode === "full" && t.calls > 0 && report.series.length > 0 && (
        <div className="agx-trend-pair">
          <UsageTrend series={report.series} total={t.totalTokens} formatTokens={formatTokens} />
          {report.hourlySeries && report.hourlySeries.length > 0 && (
            <UsageTrend series={report.hourlySeries} total={report.hourlySeries.reduce((sum, b) => sum + b.inputTokens + b.outputTokens, 0)} hourly formatTokens={formatTokens} />
          )}
        </div>
      )}

      {visibleAgents.length > 0 && (
        <section className="agx-usage-section" aria-label="Usage by agent">
          {mode === "full" && <h4>By connected agent</h4>}
          <ul className="agx-usage-rows">
            {visibleAgents.map((a) => {
              const usedPct = Math.round((a.totalTokens / peakAgent) * 100);
              const savedPct = Math.round((a.savedTokens / peakAgent) * 100);
              return (
                <li key={a.agentId} className="agx-usage-row">
                  <div className="agx-usage-row-top">
                    <div className="agx-usage-who">
                      <strong>{a.agentName}</strong>
                      {a.clientName && <span className="agx-chip on">{a.clientName}</span>}
                      {a.model && <small>{a.model}</small>}
                    </div>
                    <div className="agx-usage-nums">
                      <span>
                        <strong>{formatTokens(a.totalTokens)}</strong> tokens
                      </span>
                      {a.savedTokens > 0 && (
                        <span className="agx-saved-pill" title="Tokens saved via Jev pruning, body compression, deduplication, and hash skips">
                          {formatTokens(a.savedTokens)} saved ({a.savingsPct}%)
                        </span>
                      )}
                      <small>
                        {a.calls.toLocaleString()} call{a.calls === 1 ? "" : "s"}
                        {a.calls > 0 ? ` · ${a.avgDurationMs} ms` : ""}
                        {a.jevCalls + a.jevCacheHits > 0
                          ? ` · Jev ${a.jevCalls} API${a.jevCacheHits > 0 ? `, ${a.jevCacheHits} cached` : ""}`
                          : ""}
                      </small>
                    </div>
                  </div>
                  {(a.totalTokens > 0 || a.savedTokens > 0) && (
                    <div className="agx-bar-track" aria-hidden="true">
                      {a.totalTokens > 0 && (
                        <span className="agx-bar-fill used" style={{ width: `${Math.max(2, usedPct)}%` }} />
                      )}
                      {a.savedTokens > 0 && (
                        <span className="agx-bar-fill saved" style={{ width: `${Math.max(2, savedPct)}%` }} />
                      )}
                    </div>
                  )}
                  {mode === "full" && a.topTools.length > 0 && (
                    <small className="agx-meta">
                      Most used tools: {a.topTools.join(", ")} · {formatTokens(a.outputTokens)} out · {formatTokens(a.inputTokens)} in
                      {a.jevPruned > 0 ? ` · ${a.jevPruned} items filtered by Jev` : ""}
                    </small>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {mode === "full" && report.tools.length > 0 && (
        <section className="agx-usage-section" aria-label="Usage by tool">
          <h4>By MCP tool</h4>
          <ul className="agx-usage-rows">
            {report.tools.map((tl) => (
              <li key={tl.tool} className="agx-usage-row compact">
                <div className="agx-usage-row-top">
                  <div className="agx-usage-who">
                    <code>{tl.tool}</code>
                    <small>
                      {tl.calls.toLocaleString()} call{tl.calls === 1 ? "" : "s"} · avg {tl.avgDurationMs} ms
                      {tl.errors > 0 ? ` · ${tl.errors} failed` : ""}
                    </small>
                  </div>
                  <div className="agx-usage-nums">
                    <span>
                      <strong>{formatTokens(tl.totalTokens)}</strong> tokens{" "}
                      <small>({formatTokens(tl.outputTokens)} out · {formatTokens(tl.inputTokens)} in)</small>
                    </span>
                    {tl.savedTokens > 0 && (
                      <span className="agx-saved-pill">{formatTokens(tl.savedTokens)} saved</span>
                    )}
                    {(tl.jevCalls > 0 || tl.jevCacheHits > 0 || tl.jevPruned > 0) && (
                      <small>
                        Jev: {tl.jevCalls} API{tl.jevCacheHits > 0 ? `, ${tl.jevCacheHits} cached` : ""}
                        {tl.jevPruned > 0 ? ` · ${tl.jevPruned} pruned` : ""}
                      </small>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mode === "full" && report.recent.length > 0 && (
        <section className="agx-usage-section" aria-label="Recent MCP calls">
          <h4>Recent calls</h4>
          <ul className="agx-usage-rows">
            {report.recent.map((r, i) => (
              <li key={`${r.createdAt}-${r.tool}-${i}`} className="agx-usage-row compact">
                <div className="agx-usage-row-top">
                  <div className="agx-usage-who">
                    <code>{r.tool}</code>
                    <span>{r.agentName ?? "Agent"}</span>
                    <small>{shortTime(r.createdAt)} · {r.durationMs} ms{!r.ok ? " · failed" : ""}</small>
                  </div>
                  <div className="agx-usage-nums">
                    <small>
                      {formatTokens(r.outputTokens)} out · {formatTokens(r.inputTokens)} in
                    </small>
                    {r.savedTokens > 0 && (
                      <span className="agx-saved-pill">{formatTokens(r.savedTokens)} saved</span>
                    )}
                    {(r.jevCalls > 0 || r.jevCacheHits > 0 || r.jevErrors > 0) && (
                      <span className="agx-chip">
                        {r.jevCacheHits > 0 && r.jevCalls === 0
                          ? "Jev cached"
                          : r.jevErrors > 0 && r.jevCalls === 0
                            ? "Jev fallback"
                            : `Jev ${r.jevMs} ms${r.jevPruned > 0 ? ` · ${r.jevPruned} pruned` : ""}`}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {t.calls === 0 && (
        <p className="picker-muted">
          No MCP calls recorded in this time window yet. Connect an agent app and run a session to see token and Jev usage here.
        </p>
      )}
    </div>
  );
}
