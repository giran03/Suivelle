const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Yesterday", a weekday for the last week, then a date: the heading above a day's records. */
export function dayHeading(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return DAYS[d.getDay()];
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** Time of day as "09:30" in local time. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Splits an ordered list into runs that share a day heading. */
export function groupByDay<T>(items: T[], stampOf: (item: T) => string, now: Date = new Date()): { heading: string; items: T[] }[] {
  const out: { heading: string; items: T[] }[] = [];
  for (const item of items) {
    const heading = dayHeading(stampOf(item), now);
    const last = out[out.length - 1];
    if (last && last.heading === heading) last.items.push(item);
    else out.push({ heading, items: [item] });
  }
  return out;
}
