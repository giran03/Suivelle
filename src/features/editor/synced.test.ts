import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToBlocks } from "./convert";
import { withoutIds } from "./synced";

const tree: JSONContent = {
  type: "bulletList",
  content: [
    {
      type: "listItem",
      attrs: { blockId: "item-1" },
      content: [{ type: "paragraph", attrs: { blockId: "p-1", align: "left" }, content: [{ type: "text", text: "hello" }] }],
    },
  ],
};

describe("withoutIds", () => {
  it("removes block ids everywhere and keeps every other attribute and the text", () => {
    const clean = withoutIds(tree);
    expect(JSON.stringify(clean)).not.toContain("blockId");
    expect(clean.content![0].content![0].attrs).toEqual({ align: "left" });
    expect(clean.content![0].content![0].content![0].text).toBe("hello");
  });

  it("leaves the original untouched", () => {
    withoutIds(tree);
    expect(tree.content![0].attrs).toEqual({ blockId: "item-1" });
  });

  it("lets the copy be saved as brand new rows that share no id with the original", () => {
    const original = docToBlocks({ type: "doc", content: [tree] });
    const copy = docToBlocks({ type: "doc", content: [withoutIds(tree)] });
    expect(copy).toHaveLength(original.length);
    const ids = new Set(original.map((r) => r.id));
    expect(copy.every((r) => !ids.has(r.id))).toBe(true);
  });
});
