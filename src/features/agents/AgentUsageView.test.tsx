// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { UsageReport } from "./types";
vi.mock("../../lib/ipc", () => ({ ipc: { agentsUsage: vi.fn() }, toAppError: String }));
import { ipc } from "../../lib/ipc";
import { AgentUsageView } from "./AgentUsageView";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps empty buckets empty, scales stacks proportionally, and dismisses details with Escape", async () => {
  const report: UsageReport = {
    range: "7d",
    totals: { calls: 1, errors: 0, avgDurationMs: 0, inputTokens: 0, outputTokens: 900, totalTokens: 900, savedTokens: 100, savingsPct: 10, jevCalls: 0, jevCacheHits: 0, jevErrors: 0, jevTokens: 0, jevQuestions: 0, jevAvgMs: 0, jevPruned: 0 },
    hourlySeries: [
      { key: "2026-10-18T01", label: "01:00", calls: 1, inputTokens: 13044, outputTokens: 2202, savedTokens: 100, jevTokens: 0 },
      { key: "2026-10-18T02", label: "02:00", calls: 1, inputTokens: 18029, outputTokens: 3780, savedTokens: 0, jevTokens: 0 },
    ],
    agents: [], tools: [], recent: [],
    series: [
      { key: "empty", label: "Oct 17", calls: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0, jevTokens: 0 },
      { key: "active", label: "Oct 18", calls: 1, inputTokens: 0, outputTokens: 900, savedTokens: 100, jevTokens: 0 },
    ],
  };
  vi.mocked(ipc.agentsUsage).mockResolvedValue(report);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentUsageView mode="full" initialReport={report} />));
    const columns = host.querySelectorAll<HTMLButtonElement>(".agx-trend-col");
    expect(columns[0].querySelectorAll(".agx-trend-bar")).toHaveLength(0);
    expect(columns[1].querySelector<HTMLElement>(".used")?.style.height).toBe("60%");
    expect(parseFloat(columns[1].querySelector<HTMLElement>(".saved")!.style.height)).toBeCloseTo(100 / 15);
    expect(columns[1].getAttribute("aria-label")).toContain("900 context tokens");
    const hourly = host.querySelector('[aria-label="Hourly token usage"]')!;
    const hours = hourly.querySelectorAll<HTMLButtonElement>(".agx-trend-col");
    expect(hours).toHaveLength(2);
    expect(hours[0].querySelector(".agx-trend-tooltip-total")?.textContent).toContain("15,246");
    expect(hours[1].querySelector(".agx-trend-tooltip-total")?.textContent).toContain("21,809");
    expect(hours[0].querySelector(".agx-trend-tooltip")?.textContent).toContain("Input");
    expect(hours[0].querySelector(".agx-trend-tooltip")?.textContent).toContain("Output");
    expect(hours[0].getAttribute("aria-label")).toContain("13,044 in");
    await act(async () => columns[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(columns[1].classList.contains("dismissed")).toBe(true);
    await act(async () => columns[1].focus());
    expect(columns[1].classList.contains("dismissed")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
