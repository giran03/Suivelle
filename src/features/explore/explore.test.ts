import { describe, expect, it } from "vitest";
import { layout } from "./graph";
import { reminderStamp } from "./reminders";

describe("reminder times", () => {
  const now = new Date(2026, 9, 13, 15, 0);
  it("reads natural phrases, defaulting to nine in the morning", () => {
    expect(reminderStamp("tomorrow 9am", now)).toBe("2026-10-14T09:00:00");
    expect(reminderStamp("tomorrow", now)).toBe("2026-10-14T09:00:00");
    expect(reminderStamp("in 3 days at 14:30", now)).toBe("2026-10-16T14:30:00");
    expect(reminderStamp("whenever", now)).toBeNull();
  });
});

describe("graph layout", () => {
  const node = (id: string) => ({ id, title: id, icon: null, deleted: false });
  it("places linked pages nearer each other than unlinked ones, the same way every time", () => {
    const graph = { nodes: ["a", "b", "c", "d"].map(node), edges: [["a", "b"], ["b", "c"]] as [string, string][] };
    const points = layout(graph);
    const at = Object.fromEntries(points.map((p) => [p.id, p]));
    const dist = (p: string, q: string) => Math.hypot(at[p].x - at[q].x, at[p].y - at[q].y);
    expect(dist("a", "b")).toBeLessThan(dist("a", "d"));
    expect(at.b.degree).toBe(2);
    expect(layout(graph)).toEqual(points);
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});
