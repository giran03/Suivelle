import glyphs from "./iconGlyphs.json";

export type IconName = keyof typeof glyphs;
export const isIconName = (name: string): name is IconName => Object.prototype.hasOwnProperty.call(glyphs, name);
export const iconCharacter = (name: IconName) => String.fromCodePoint(glyphs[name].codepoint);
const FALLBACKS: Partial<Record<IconName, string>> = { close: "x", check: "+", plus: "+", minus: "-", minimize: "-", maximize: "[]", restoreWindow: "[]", back: "<", forward: ">", chevron: ">", chevronLeft: "<", chevronDown: "v", more: "...", search: "?", warning: "!", undo: "<", redo: ">" };

/** Local Nerd Fonts symbols; semantic names also preserve saved page/workspace choices. */
export function Icon({ name, filled = false, size = 16 }: { name: IconName; filled?: boolean; size?: number }) {
  const variant = name === "star" && filled ? "starFilled" : name;
  return <i className="app-icon" data-icon={variant} data-glyph={iconCharacter(variant)} data-fallback={FALLBACKS[name] ?? name.slice(0, 2)} aria-hidden="true" style={{ width: size, height: size, fontSize: size }} />;
}
