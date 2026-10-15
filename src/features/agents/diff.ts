export interface DiffLine { kind: "same" | "add" | "del"; text: string }

const MAX_CELLS = 4_000_000;

/** A line diff (longest common subsequence). Very large inputs fall back to "all removed, all added". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common head and tail first; most edits touch a small middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  if (x.length * y.length > MAX_CELLS) {
    out.push(...x.map((text) => ({ kind: "del" as const, text })), ...y.map((text) => ({ kind: "add" as const, text })));
  } else {
    const n = x.length;
    const m = y.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { out.push({ kind: "same", text: x[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: x[i++] });
      else out.push({ kind: "add", text: y[j++] });
    }
    while (i < n) out.push({ kind: "del", text: x[i++] });
    while (j < m) out.push({ kind: "add", text: y[j++] });
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ kind: "same" as const, text })));
  return out;
}

/** Keeps changed lines with `context` unchanged lines around them; long unchanged runs become a gap marker (null). */
export function withContext(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
