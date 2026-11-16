import { Fragment, type ReactNode } from "react";

const MAX_MARKDOWN_LENGTH = 65536;
const SAFE_LINK = /^https?:\/\//i;
const INLINE_TOKEN = /\\([\\`*_{}[\]()#+\-.!~])|`([^`\n]+)`|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu;

/** Renders safe inline Markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[links](https://...)`) as React nodes. */
export function inlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [, escaped, code, imgAlt, , linkLabel, linkUrl, boldStar, boldUnder, strike, emStar, emUnder] = match;
    if (escaped !== undefined) {
      out.push(escaped);
    } else if (code !== undefined) {
      out.push(<code key={key++}>{code}</code>);
    } else if (imgAlt !== undefined) {
      if (imgAlt) out.push(imgAlt);
    } else if (linkLabel !== undefined && linkUrl !== undefined) {
      if (SAFE_LINK.test(linkUrl)) {
        out.push(
          <a key={key++} href={linkUrl} target="_blank" rel="noopener noreferrer">
            {inlineMarkdown(linkLabel)}
          </a>
        );
      } else {
        out.push(<Fragment key={key++}>{inlineMarkdown(linkLabel)}</Fragment>);
      }
    } else if (boldStar !== undefined || boldUnder !== undefined) {
      out.push(<strong key={key++}>{inlineMarkdown((boldStar ?? boldUnder)!)}</strong>);
    } else if (strike !== undefined) {
      out.push(<del key={key++}>{inlineMarkdown(strike)}</del>);
    } else if (emStar !== undefined || emUnder !== undefined) {
      out.push(<em key={key++}>{inlineMarkdown((emStar ?? emUnder)!)}</em>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface ListItemNode {
  text: string;
  task: boolean | null;
  children: ListNode[];
}

interface ListNode {
  ordered: boolean;
  start: number;
  items: ListItemNode[];
}

const FENCE_RE = /^```/;
const HR_RE = /^(?:([-*_])(?:\s*\1){2,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const LIST_RE = /^([ \t]*)(?:[-*+]|(\d+)\.)\s+(.*)$/;
const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;

function indentWidth(raw: string): number {
  let width = 0;
  for (const ch of raw) width += ch === "\t" ? 2 : 1;
  return width;
}

function parseList(lines: string[], startIndex: number, baseIndent: number): { node: ListNode; nextIndex: number } {
  const firstMatch = LIST_RE.exec(lines[startIndex]);
  const ordered = firstMatch?.[2] !== undefined;
  const start = firstMatch?.[2] ? Number.parseInt(firstMatch[2], 10) || 1 : 1;
  const items: ListItemNode[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) {
      // Peek past blank lines to see if the list continues at this indent level.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? LIST_RE.exec(lines[j]) : null;
      if (next && indentWidth(next[1]) === baseIndent && (next[2] !== undefined) === ordered) {
        i = j;
        continue;
      }
      break;
    }

    const match = LIST_RE.exec(raw);
    if (match) {
      const indent = indentWidth(match[1]);
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        if (!items.length) break;
        const nested = parseList(lines, i, indent);
        items[items.length - 1].children.push(nested.node);
        i = nested.nextIndex;
        continue;
      }
      if ((match[2] !== undefined) !== ordered) break;
      const body = match[3];
      const taskMatch = TASK_RE.exec(body);
      items.push({
        text: taskMatch ? taskMatch[2] : body,
        task: taskMatch ? taskMatch[1].toLowerCase() === "x" : null,
        children: [],
      });
      i++;
      continue;
    }

    // Continuation line for the current list item.
    if (items.length && /^[ \t]+\S/.test(raw) && !FENCE_RE.test(raw.trim())) {
      items[items.length - 1].text += ` ${raw.trim()}`;
      i++;
      continue;
    }
    break;
  }

  return { node: { ordered, start, items }, nextIndex: i };
}

function renderList(node: ListNode, key: string | number): ReactNode {
  const Tag = node.ordered ? "ol" : "ul";
  return (
    <Tag key={key} start={node.ordered && node.start !== 1 ? node.start : undefined}>
      {node.items.map((item, idx) => (
        <li key={idx} className={item.task !== null ? "cl-task" : undefined}>
          {item.task !== null && (
            <span
              className={`cl-check${item.task ? " on" : ""}`}
              role="img"
              aria-label={item.task ? "Completed" : "Incomplete"}
            />
          )}
          {inlineMarkdown(item.text)}
          {item.children.map((child, childIdx) => renderList(child, `${idx}-${childIdx}`))}
        </li>
      ))}
    </Tag>
  );
}

function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line.trim()) ||
    HR_RE.test(line.trim()) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line)
  );
}

/** Plain, escaped Markdown structure: no release HTML or remotely loaded media. */
export function ChangelogMarkdown({ text }: { text: string }) {
  const lines = text.slice(0, MAX_MARKDOWN_LENGTH).split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (FENCE_RE.test(trimmed)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        <pre key={blocks.length}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (HR_RE.test(trimmed)) {
      blocks.push(<hr key={blocks.length} />);
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const content = inlineMarkdown(heading[2]);
      blocks.push(level <= 2 ? <h3 key={blocks.length}>{content}</h3> : <h4 key={blocks.length}>{content}</h4>);
      i++;
      continue;
    }

    if (QUOTE_RE.test(raw)) {
      const quoteParagraphs: string[] = [];
      let currentQuote: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        if (!q[1].trim()) {
          if (currentQuote.length) {
            quoteParagraphs.push(currentQuote.join(" "));
            currentQuote = [];
          }
        } else {
          currentQuote.push(q[1].trim());
        }
        i++;
      }
      if (currentQuote.length) quoteParagraphs.push(currentQuote.join(" "));
      blocks.push(
        <blockquote key={blocks.length}>
          {quoteParagraphs.map((p, idx) => (
            <p key={idx}>{inlineMarkdown(p)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    const list = LIST_RE.exec(raw);
    if (list) {
      const parsed = parseList(lines, i, indentWidth(list[1]));
      blocks.push(renderList(parsed.node, blocks.length));
      i = parsed.nextIndex;
      continue;
    }

    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push(<p key={blocks.length}>{inlineMarkdown(paraLines.join(" "))}</p>);
  }

  return <>{blocks}</>;
}
