import { Mark } from "@tiptap/core";

export const TONES = ["gray", "violet", "red", "orange", "green", "blue"] as const;
export type Tone = (typeof TONES)[number];

/** Text and background colour as theme tokens (`data-fg` / `data-bg`), never raw colour values. */
export const ToneMark = Mark.create({
  name: "tone",

  addAttributes() {
    const attr = (name: "fg" | "bg") => ({
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`),
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [`data-${name}`]: attrs[name] as string } : {}),
    });
    return { fg: attr("fg"), bg: attr("bg") };
  },

  parseHTML() {
    return [{ tag: "span[data-fg]" }, { tag: "span[data-bg]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});
