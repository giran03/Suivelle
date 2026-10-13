import type { JSONContent } from "@tiptap/core";

/**
 * Whether pasted plain text is worth turning into blocks: it must open a line with real block
 * syntax (a heading, list, quote, fence, task or table row). Inline marks alone are not enough,
 * so ordinary sentences and one-liners with an asterisk are pasted exactly as typed.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length > 2_000_000) return false;
  return /^(?:\s{0,3}#{1,6}\s+\S|\s{0,3}>\s?\S|\s{0,3}(?:```|~~~)|\s*[-*+]\s+\[[ xX]\]\s|\s*[-*+]\s+\S|\s*\d{1,3}[.)]\s+\S|\s*\|.+\|\s*$)/m.test(text);
}

interface Options {
  /** Title for a page mention, so copied text reads "[[Roadmap]]" rather than an id. */
  pageTitle?: (id: string) => string | undefined;
}

type Marks = NonNullable<JSONContent["marks"]>;
const hasMark = (marks: Marks | undefined, type: string) => marks?.find((m) => m.type === type);

function inline(nodes: JSONContent[] | undefined, opts: Options): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") {
      out += "  \n";
    } else if (n.type === "pageMention") {
      const id = String(n.attrs?.pageId ?? "");
      out += `[[${opts.pageTitle?.(id) || "page"}]]`;
    } else if (n.type === "text") {
      const text = n.text ?? "";
      const m = n.marks;
      const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? ["", "", text, ""];
      if (!body) {
        out += text;
        continue;
      }
      let t = body;
      if (hasMark(m, "code")) t = `\`${t}\``;
      else {
        if (hasMark(m, "bold")) t = `**${t}**`;
        if (hasMark(m, "italic")) t = `*${t}*`;
        if (hasMark(m, "strike")) t = `~~${t}~~`;
      }
      const link = hasMark(m, "link");
      const href = link?.attrs?.href;
      if (typeof href === "string" && href) t = `[${t}](${href})`;
      out += lead + t + trail;
    } else {
      out += inline(n.content, opts);
    }
  }
  return out;
}

const plainText = (nodes: JSONContent[] | undefined): string => (nodes ?? []).map((n) => n.text ?? plainText(n.content)).join("");
const indentLines = (s: string, pad: string) => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");

function list(n: JSONContent, opts: Options): string {
  const items = n.content ?? [];
  const lines = items.map((item, i) => {
    const marker = n.type === "orderedList" ? `${i + 1}.` : n.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-";
    const [first, ...rest] = item.content ?? [];
    const head = first?.type === "paragraph" ? inline(first.content, opts) : "";
    const children = first?.type === "paragraph" ? rest : (item.content ?? []);
    const body = children.map((c) => block(c, opts)).filter(Boolean).join("\n");
    const pad = " ".repeat(marker.length + 1);
    return `${marker} ${head}${body ? "\n" + indentLines(body, pad) : ""}`;
  });
  return lines.join("\n");
}

function table(n: JSONContent, opts: Options): string {
  const rows = (n.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((p) => inline(p.content, opts))
        .filter(Boolean)
        .join(" ")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length), 1);
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

const TONES: Record<string, string> = { note: "NOTE", tip: "TIP", warning: "WARNING" };

function block(n: JSONContent, opts: Options): string {
  switch (n.type) {
    case "paragraph":
      return inline(n.content, opts);
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} ${inline(n.content, opts)}`;
    case "bulletList":
    case "orderedList":
    case "taskList":
      return list(n, opts);
    case "quote":
      return indentLines(inline(n.content, opts) || " ", "> ");
    case "callout":
      return `> [!${TONES[String(n.attrs?.tone)] ?? "NOTE"}]\n${indentLines(inline(n.content, opts), "> ")}`;
    case "codeBlock": {
      const text = plainText(n.content);
      const fence = "`".repeat(Math.max(3, (text.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0) + 1));
      return `${fence}${n.attrs?.language ?? ""}\n${text}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "equation":
      return `$$\n${String(n.attrs?.latex ?? "")}\n$$`;
    case "table":
      return table(n, opts);
    case "details": {
      const [summary, body] = n.content ?? [];
      const inner = (body?.content ?? []).map((c) => block(c, opts)).filter(Boolean).join("\n\n");
      return `<details${n.attrs?.open ? " open" : ""}>\n<summary>${inline(summary?.content, opts)}</summary>\n\n${inner}${inner ? "\n" : ""}</details>`;
    }
    case "tabPanel":
      return `### ${String(n.attrs?.label ?? "Tab").replace(/\n/g, " ")}\n\n${(n.content ?? []).map((c) => block(c, opts)).filter(Boolean).join("\n\n")}`;
    case "tabs":
    case "columns":
    case "column":
      // Markdown has no columns: read them left to right, one after another.
      return (n.content ?? []).map((c) => block(c, opts)).filter(Boolean).join("\n\n");
    case "databaseView":
      return "";
    case "image":
    case "audio":
    case "video":
    case "pdf":
    case "file": {
      const label = { image: "Image", audio: "Audio", video: "Video", pdf: "PDF", file: "File" }[n.type];
      return n.attrs?.name ? `[${label}: ${String(n.attrs.name)}]` : "";
    }
    default:
      return inline(n.content, opts);
  }
}

/** Markdown for a run of editor blocks, as put on the clipboard when blocks are copied. */
export function jsonToMarkdown(nodes: JSONContent[], opts: Options = {}): string {
  return nodes.map((n) => block(n, opts)).filter((s) => s !== "").join("\n\n");
}
