import { Mark } from "@tiptap/core";
import { smartToken } from "../smartPaste";

/** Presentation over ordinary text: stored, searchable, and editable like other marks. */
export const SmartReference = Mark.create({
  name: "smartReference",
  inclusive: false,
  addAttributes() {
    return {
      kind: { default: null, parseHTML: el => el.getAttribute("data-smart-kind") },
      value: { default: null, parseHTML: el => el.getAttribute("data-smart-value") },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-smart-kind][data-smart-value]", getAttrs: el => {
      const token = smartToken(el.getAttribute("data-smart-value") ?? "");
      return token?.kind === el.getAttribute("data-smart-kind") ? { kind: token.kind, value: token.value } : false;
    } }];
  },
  renderHTML({ mark }) {
    const token = smartToken(String(mark.attrs.value ?? ""));
    if (!token || token.kind !== mark.attrs.kind) return ["span", {}, 0];
    return ["span", {
      "data-smart-kind": token.kind, "data-smart-value": token.value,
      class: `smart-reference smart-${token.kind}`,
      title: token.value,
      ...(token.kind === "color" ? { style: `--swatch-color:${token.value}` } : {}),
      ...(token.kind === "file" ? { role: "link", tabindex: "0", "aria-label": `Open file ${token.value}` } : {}),
    }, 0];
  },
});
