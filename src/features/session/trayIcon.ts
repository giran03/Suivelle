import glyphs from "../../components/iconGlyphs.json";
import { thumbUrl } from "../../lib/attachments";
import type { Page } from "../../types";
import { parseIcon } from "../pages/pageAppearance";

/** A page icon rasterised for the native tray menu: straight-alpha RGBA, `size` pixels square. */
export interface TrayIcon { size: number; rgba: number[]; tint: boolean }

const SIZE = 48;

function canvas() {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  return { c, ctx: c.getContext("2d", { willReadFrequently: true })! };
}

const pixels = (ctx: CanvasRenderingContext2D, tint: boolean): TrayIcon => ({
  size: SIZE,
  rgba: Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data),
  tint,
});

/**
 * Draws a page's emoji, built-in icon or uploaded image the way the sidebar shows it, so the tray
 * menu can match. Returns null for pages with no icon of their own (the tray keeps its default).
 * Built-in icons are drawn as a mask (`tint`) and take the tray's own colours.
 */
export async function renderTrayIcon(page: Pick<Page, "icon">): Promise<TrayIcon | null> {
  const glyph = parseIcon(page.icon);
  if (!glyph) return null;
  try {
    const { c, ctx } = canvas();
    if (glyph.kind === "emoji") {
      ctx.font = `${Math.round(SIZE * 0.82)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph.value, SIZE / 2, SIZE / 2 + SIZE * 0.05);
      return pixels(ctx, false);
    }
    if (glyph.kind === "icon") {
      const entry = (glyphs as Record<string, { codepoint: number }>)[glyph.name];
      if (!entry) return null;
      const family = getComputedStyle(document.documentElement).getPropertyValue("--font-icons").trim() || '"Material Symbols Rounded"';
      const font = `400 ${Math.round(SIZE * 0.9)}px ${family}`;
      await document.fonts.load(font);
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.fillText(String.fromCodePoint(entry.codepoint), SIZE / 2, SIZE / 2);
      return pixels(ctx, true);
    }
    const response = await fetch(thumbUrl(glyph.hash, 320));
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.beginPath();
    ctx.roundRect(0, 0, SIZE, SIZE, SIZE * 0.18);
    ctx.clip();
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
    void c;
    return pixels(ctx, false);
  } catch {
    return null;
  }
}
