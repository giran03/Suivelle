export interface EmbedData {
  url: string;
  title: string;
  caption: string;
  width: number;
  height: number | null;
  align: "left" | "center" | "right";
  mode: "embed" | "link";
}
export const EMBED_DEFAULTS: EmbedData = { url: "", title: "", caption: "", width: 100, height: null, align: "left", mode: "embed" };
export function embedData(value: Record<string, unknown>): EmbedData {
  const text = (key: string, max: number) => typeof value[key] === "string" ? (value[key] as string).slice(0, max) : "";
  return { url: text("url", 4096), title: text("title", 200), caption: text("caption", 2000),
    width: typeof value.width === "number" && Number.isFinite(value.width) ? Math.max(25, Math.min(100, value.width)) : 100,
    height: typeof value.height === "number" && Number.isFinite(value.height) ? Math.max(160, Math.min(1200, value.height)) : null,
    align: value.align === "center" || value.align === "right" ? value.align : "left", mode: value.mode === "link" ? "link" : "embed" };
}
/** Only the iframe's source is extracted. No supplied HTML or attributes are rendered. */
export function embedSource(input: string): string {
  let source = input.trim();
  if (source.startsWith("<")) {
    if (!/^<iframe\b[^<>]*>\s*<\/iframe>\s*$/i.test(source)) throw new Error("Paste a link or a single iframe embed code.");
    const match = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(source);
    if (!match) throw new Error("The embed code needs a source URL.");
    source = match[2].replace(/&amp;/gi, "&");
  }
  if (source.length > 4096) throw new Error("This link is too long.");
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Enter a complete HTTPS link."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Use an HTTPS link without credentials or a custom port.");
  return url.href;
}
export interface EmbedTarget { source: string; frame: string | null; provider: string; }
/** Frame URLs are rebuilt from known providers, never taken from saved iframe markup. */
export function embedTarget(input: string): EmbedTarget {
  const source = embedSource(input), url = new URL(source);
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"].includes(host)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const id = host === "youtu.be" ? segments[0] : url.pathname === "/watch" ? url.searchParams.get("v") : ["embed", "shorts", "live"].includes(segments[0]) ? segments[1] : null;
    const list = url.searchParams.get("list");
    if ((!id || !/^[\w-]{11}$/.test(id)) && !(list && /^[\w-]{10,150}$/.test(list) && (!id || id === "videoseries"))) throw new Error("Use a YouTube video or playlist link.");
    const frame = new URL(`https://www.youtube-nocookie.com/embed/${id && id !== "videoseries" ? id : "videoseries"}`);
    if (list && /^[\w-]{10,150}$/.test(list)) frame.searchParams.set("list", list);
    const time = url.searchParams.get("start") ?? url.searchParams.get("t");
    if (time && /^\d{1,6}s?$/.test(time)) frame.searchParams.set("start", String(Math.min(86400, parseInt(time))));
    return { source, frame: frame.href, provider: "YouTube" };
  }
  if (host === "www.google.com" && (url.pathname === "/maps/embed" || /^\/maps\/embed\/v1\/(place|view|directions|streetview|search)$/.test(url.pathname))) {
    return { source, frame: source, provider: "Google Maps" };
  }
  if (["maps.google.com", "maps.app.goo.gl", "goo.gl", "www.google.com", "google.com"].includes(host) && (url.pathname.includes("maps") || host.startsWith("maps.") || host === "goo.gl")) {
    throw new Error("In Google Maps, choose Share → Embed a map, then paste the copied iframe code.");
  }
  return { source, frame: null, provider: host };
}
