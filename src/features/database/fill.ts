import type { PropertyType } from "../../types";

const DAY = 86_400_000;
const dayNumber = (iso: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY : null;
};
const isoDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** A constant step between the numbers, or null when they do not form a pattern. */
function stepOf(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const step = nums[1] - nums[0];
  for (let i = 2; i < nums.length; i++) if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) return null;
  return step;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * The values that continue `source` for `count` more cells. Two or more numbers (or whole days)
 * with a constant step carry on counting; anything else repeats the source in a cycle.
 */
export function continueSeries(source: unknown[], count: number, type: PropertyType): unknown[] {
  if (count <= 0 || source.length === 0) return [];
  const cycle = () => Array.from({ length: count }, (_, i) => source[i % source.length]);
  if (type === "number" && source.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const nums = source as number[];
    const step = stepOf(nums);
    if (step === null) return cycle();
    const last = nums[nums.length - 1];
    return Array.from({ length: count }, (_, i) => round(last + step * (i + 1)));
  }
  if (type === "date") {
    const days = source.map((v) => {
      const d = v as { start?: string; end?: string } | null;
      return d && typeof d.start === "string" && !d.end ? dayNumber(d.start) : null;
    });
    if (days.every((d): d is number => d !== null)) {
      const step = stepOf(days);
      if (step !== null) {
        const last = days[days.length - 1];
        return Array.from({ length: count }, (_, i) => ({ start: isoDay(last + step * (i + 1)) }));
      }
    }
  }
  return cycle();
}
