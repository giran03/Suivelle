import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { jsonToMarkdown, looksLikeMarkdown } from "./markdown";

const text = (t: string, ...marks: string[]): JSONContent => ({ type: "text", text: t, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

describe("looksLikeMarkdown", () => {
  it("recognises block syntax", () => {
    expect(looksLikeMarkdown("# Title\n\ntext")).toBe(true);
    expect(looksLikeMarkdown("some intro\n\n- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
    expect(looksLikeMarkdown("- [ ] task")).toBe(true);
    expect(looksLikeMarkdown("> quoted")).toBe(true);
    expect(looksLikeMarkdown("text\n```js\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(true);
  });
  it("leaves ordinary text alone", () => {
    expect(looksLikeMarkdown("Just a sentence.")).toBe(false);
    expect(looksLikeMarkdown("Two lines\nof prose, with *emphasis* inside")).toBe(false);
    expect(looksLikeMarkdown("price is 3 * 4 = 12")).toBe(false);
    expect(looksLikeMarkdown("Visit #hashtag today")).toBe(false);
    expect(looksLikeMarkdown("2026-10-08 was a Thursday")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
  });
});

describe("jsonToMarkdown", () => {
  it("writes headings, paragraphs and marks", () => {
    const md = jsonToMarkdown([
      { type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
      p(text("Some "), text("bold", "bold"), text(" and "), text("italic", "italic"), text(" and "), text("code", "code")),
    ]);
    expect(md).toBe("## Plan\n\nSome **bold** and *italic* and `code`");
  });

  it("keeps spaces outside the marks", () => {
    expect(jsonToMarkdown([p(text(" spaced ", "bold"))])).toBe(" **spaced** ");
  });

  it("writes links", () => {
    const link: JSONContent = { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://x.test" } }] };
    expect(jsonToMarkdown([p(link)])).toBe("[site](https://x.test)");
  });

  it("writes lists, tasks and nesting", () => {
    const item = (t: string, ...rest: JSONContent[]): JSONContent => ({ type: "listItem", content: [p(text(t)), ...rest] });
    const md = jsonToMarkdown([
      { type: "bulletList", content: [item("one", { type: "bulletList", content: [item("inner")] }), item("two")] },
      { type: "orderedList", content: [item("a"), item("b")] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(text("done"))] }, { type: "taskItem", attrs: { checked: false }, content: [p(text("todo"))] }] },
    ]);
    expect(md).toBe("- one\n  - inner\n- two\n\n1. a\n2. b\n\n- [x] done\n- [ ] todo");
  });

  it("writes code with a fence longer than any backticks inside", () => {
    const md = jsonToMarkdown([{ type: "codeBlock", attrs: { language: "md" }, content: [text("a ``` b")] }]);
    expect(md).toBe("````md\na ``` b\n````");
  });

  it("writes quotes, callouts, dividers and equations", () => {
    expect(jsonToMarkdown([{ type: "quote", content: [text("wise")] }])).toBe("> wise");
    expect(jsonToMarkdown([{ type: "callout", attrs: { tone: "warning" }, content: [text("careful")] }])).toBe("> [!WARNING]\n> careful");
    expect(jsonToMarkdown([{ type: "horizontalRule" }])).toBe("---");
    expect(jsonToMarkdown([{ type: "equation", attrs: { latex: "a^2" } }])).toBe("$$\na^2\n$$");
  });

  it("writes tables with escaped pipes", () => {
    const cell = (type: string, t: string): JSONContent => ({ type, content: [p(text(t))] });
    const md = jsonToMarkdown([
      { type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B")] }, { type: "tableRow", content: [cell("tableCell", "1|2"), cell("tableCell", "3")] }] },
    ]);
    expect(md).toBe("| A | B |\n| --- | --- |\n| 1\\|2 | 3 |");
  });

  it("flattens columns left to right and skips embedded databases", () => {
    const md = jsonToMarkdown([
      { type: "columns", content: [{ type: "column", content: [p(text("left"))] }, { type: "column", content: [p(text("right"))] }] },
      { type: "databaseView", attrs: { pageId: "x" } },
    ]);
    expect(md).toBe("left\n\nright");
  });

  it("names page mentions and files", () => {
    const mention: JSONContent = { type: "pageMention", attrs: { pageId: "p1" } };
    expect(jsonToMarkdown([p(text("see "), mention)], { pageTitle: () => "Roadmap" })).toBe("see [[Roadmap]]");
    expect(jsonToMarkdown([{ type: "image", attrs: { name: "cat.png" } }, { type: "file", attrs: { name: "a.zip" } }])).toBe("[Image: cat.png]\n\n[File: a.zip]");
  });
});
