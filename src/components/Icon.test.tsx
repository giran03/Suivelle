import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Icon, iconCharacter, isIconName, type IconName } from "./Icon";
import glyphs from "./iconGlyphs.json";

it("renders every registered glyph decoratively without changing control text", () => {
  for (const name of Object.keys(glyphs) as IconName[]) {
    expect(isIconName(name)).toBe(true);
    expect(glyphs[name].name).toMatch(/^md-/);
    expect([...iconCharacter(name)]).toHaveLength(1);
    const html = renderToStaticMarkup(<button aria-label="Action"><Icon name={name} />Action</button>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`data-icon="${name}"`);
    expect(html.replace(/<[^>]+>/g, "")).toBe("Action");
  }
  expect(isIconName("toString")).toBe(false);
  expect(isIconName("missing-icon")).toBe(false);
});

it("preserves favorite outline/filled distinction and explicit sizes", () => {
  const html = renderToStaticMarkup(<Icon name="star" filled size={24} />);
  expect(html).toContain('data-icon="starFilled"');
  expect(html).toContain("width:24px;height:24px;font-size:24px");
  expect(iconCharacter("star")).not.toBe(iconCharacter("starFilled"));
});
