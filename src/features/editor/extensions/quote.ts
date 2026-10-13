import { mergeAttributes, Node, textblockTypeInputRule } from "@tiptap/core";

/** A quote is a single text block (one row), not a container of paragraphs. */
export const Quote = Node.create({
  name: "quote",
  group: "block",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: "blockquote" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(HTMLAttributes), 0];
  },

  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*>\s$/, type: this.type })];
  },
});
