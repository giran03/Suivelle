import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { findMatches } from "./find";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*" },
    media: { group: "block", atom: true },
    text: { group: "inline" },
    mention: { group: "inline", inline: true, atom: true },
  },
});

const para = (...kids: ReturnType<typeof schema.text>[]) => schema.node("paragraph", null, kids);
const doc = (...blocks: ReturnType<typeof para>[]) => schema.node("doc", null, blocks);

describe("findMatches", () => {
  it("returns exact document positions", () => {
    const d = doc(para(schema.text("one two one")), para(schema.text("one")));
    const matches = findMatches(d, "one", false);
    expect(matches).toHaveLength(3);
    for (const m of matches) expect(d.textBetween(m.from, m.to)).toBe("one");
  });

  it("is case-insensitive unless asked", () => {
    const d = doc(para(schema.text("Apple apple APPLE")));
    expect(findMatches(d, "apple", false)).toHaveLength(3);
    expect(findMatches(d, "apple", true)).toHaveLength(1);
  });

  it("finds text split across styled runs of one block", () => {
    const bold = schema.text("lo wor");
    const d = doc(para(schema.text("hel"), bold, schema.text("ld")));
    const [m] = findMatches(d, "lo wor", false);
    expect(d.textBetween(m.from, m.to)).toBe("lo wor");
  });

  it("does not match across blocks, and finds nothing for an empty query", () => {
    const d = doc(para(schema.text("end")), para(schema.text("start")));
    expect(findMatches(d, "endstart", false)).toHaveLength(0);
    expect(findMatches(d, "", false)).toHaveLength(0);
  });

  it("keeps positions right after an inline atom", () => {
    const d = doc(para(schema.text("a "), schema.node("mention"), schema.text(" target")));
    const [m] = findMatches(d, "target", false);
    expect(d.textBetween(m.from, m.to)).toBe("target");
  });

  it("skips atom blocks and does not overlap matches with itself", () => {
    const d = doc(para(schema.text("aaaa")), schema.node("media"));
    expect(findMatches(d, "aa", false)).toHaveLength(2);
  });

  it("can be limited to whole words", () => {
    const d = doc(para(schema.text("the them other the_x then The")));
    expect(findMatches(d, "the", false, false)).toHaveLength(6);
    const whole = findMatches(d, "the", false, true);
    expect(whole).toHaveLength(2);
    for (const m of whole) expect(d.textBetween(m.from, m.to).toLowerCase()).toBe("the");
  });

  it("treats punctuation as a word edge but not letters from other scripts", () => {
    const d = doc(para(schema.text("(cat) cat, catéa écat")));
    expect(findMatches(d, "cat", false, true)).toHaveLength(2);
  });
});
