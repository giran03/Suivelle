// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrbit, type OrbitState } from "./orbit";
vi.mock("../../stores/workspace", () => ({ useWorkspace: { setState: vi.fn() } }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  let blocker: "off" | "paused" | "reduced" | null = null;
  const tick = vi.fn(), stopped = vi.fn(), states: OrbitState[] = [];
  const orbit = createOrbit({ blocked: () => blocker, tick, stopped, status: state => states.push(state) });
  return { orbit, tick, stopped, states, block: (next: typeof blocker) => { blocker = next; } };
}
describe("continuous auto-orbit", () => {
  it("starts immediately, caps its loop and never restarts an already running loop", () => {
    const s = setup(); s.orbit.refresh(); expect(s.states).toEqual(["running"]);
    vi.advanceTimersByTime(1000);
    expect(s.tick.mock.calls.length).toBeGreaterThan(10); expect(s.tick.mock.calls.length).toBeLessThanOrEqual(30);
    s.orbit.refresh(); s.orbit.refresh(); expect(s.stopped).not.toHaveBeenCalled();
    const count = s.tick.mock.calls.length; vi.advanceTimersByTime(100); expect(s.tick.mock.calls.length).toBeGreaterThan(count);
    s.orbit.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("stays still while off, reduced, hidden or in 2D and resumes immediately when eligible", () => {
    const s = setup();
    for (const reason of ["off", "reduced", "paused"] as const) {
      s.block(reason); s.orbit.refresh(); vi.advanceTimersByTime(20000);
      expect(s.tick).not.toHaveBeenCalled(); expect(s.states[s.states.length - 1]).toBe(reason); expect(vi.getTimerCount()).toBe(0);
    }
    s.block(null); s.orbit.refresh(); expect(s.states[s.states.length - 1]).toBe("running");
    vi.advanceTimersByTime(100); expect(s.tick).toHaveBeenCalled(); s.orbit.dispose();
  });
  it("saves on stop, bounds time steps and cancels all work on disposal", () => {
    const s = setup(); s.orbit.refresh(); vi.advanceTimersByTime(200);
    expect(s.tick.mock.calls.every(([seconds]) => seconds > 0 && seconds <= .1)).toBe(true);
    s.block("off"); s.orbit.refresh(); s.orbit.refresh(); expect(s.stopped).toHaveBeenCalledTimes(1);
    const count = s.tick.mock.calls.length; vi.advanceTimersByTime(1000); expect(s.tick).toHaveBeenCalledTimes(count);
    s.orbit.dispose(); vi.advanceTimersByTime(20000); expect(vi.getTimerCount()).toBe(0);
  });
});

it("remembers the orbit toggle across map store reloads", async () => {
  localStorage.clear(); vi.resetModules();
  const first = await import("./store");
  expect(first.useNodeMap.getState().autoOrbit).toBe(true);
  first.useNodeMap.getState().configure({ autoOrbit: false });
  expect(JSON.parse(localStorage.getItem("suivelle.node-map")!).autoOrbit).toBe(false);
  vi.resetModules();
  const reloaded = await import("./store");
  expect(reloaded.useNodeMap.getState().autoOrbit).toBe(false);
  reloaded.useNodeMap.getState().configure({ autoOrbit: true });
  expect(JSON.parse(localStorage.getItem("suivelle.node-map")!).autoOrbit).toBe(true);
});
