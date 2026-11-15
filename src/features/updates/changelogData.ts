/** The release history, read from the archived changelogs in docs/changelog (one Markdown file per version). */
const files = import.meta.glob("../../../docs/changelog/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export interface ChangelogGroup { title: string | null; items: string[] }
export interface ChangelogEntry {
  version: string;
  /** "Released October 21, 2026." as written, or null for a version still in development. */
  released: string | null;
  unreleased: boolean;
  groups: ChangelogGroup[];
}

const versionParts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Turns one changelog file into groups of bullets. Lines that continue a bullet are joined to it. */
export function parseChangelog(text: string): ChangelogEntry | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.find((l) => /^#\s+/.test(l));
  const version = /(\d+\.\d+\.\d+(?:[-.\w]*)?)/.exec(heading ?? "")?.[1];
  if (!version) return null;
  let released: string | null = null;
  let unreleased = false;
  const groups: ChangelogGroup[] = [];
  let current: ChangelogGroup | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || /^#\s+/.test(line)) continue;
    if (/^##\s+/.test(line)) { current = { title: line.replace(/^##\s+/, "").trim(), items: [] }; groups.push(current); continue; }
    if (/^unreleased\.?$/i.test(line.trim())) { unreleased = true; continue; }
    if (/^released\s/i.test(line.trim()) && !groups.length) { released = line.trim().replace(/\.$/, ""); continue; }
    if (/^[-*]\s+/.test(line)) {
      if (!current) { current = { title: null, items: [] }; groups.push(current); }
      current.items.push(line.replace(/^[-*]\s+/, ""));
    } else if (current?.items.length) current.items[current.items.length - 1] += ` ${line.trim()}`;
    else if (current) current.items.push(line.trim());
  }
  return { version, released, unreleased, groups: groups.filter((g) => g.items.length) };
}

/** Every archived release, newest first. */
export const CHANGELOG: ChangelogEntry[] = Object.values(files)
  .map(parseChangelog)
  .filter((e): e is ChangelogEntry => e !== null)
  .sort((a, b) => compareVersions(b.version, a.version));
