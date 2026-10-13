import type { ReactNode } from "react";

/** Private-use markers that the Rust search wraps around matched terms. */
export const MARK_START = "";
export const MARK_END = "";

/** Renders a snippet with matches in <mark>. No HTML is parsed, so snippet text can never inject markup. */
export function Marked({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let open = false;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    parts.push(open ? <mark key={parts.length}>{buf}</mark> : buf);
    buf = "";
  };
  for (const ch of text) {
    if (ch === MARK_START) {
      flush();
      open = true;
    } else if (ch === MARK_END) {
      flush();
      open = false;
    } else buf += ch;
  }
  flush();
  return <>{parts}</>;
}

export const stripMarks = (text: string) => text.replaceAll(MARK_START, "").replaceAll(MARK_END, "");
