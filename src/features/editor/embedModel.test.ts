import { expect, it } from "vitest";
import { embedData, embedSource, embedTarget } from "./embedModel";
const video = "dQw4w9WgXcQ";
it("normalizes YouTube links and copied iframe sources without trusting their HTML", () => {
  for (const url of [`https://youtu.be/${video}`, `https://www.youtube.com/watch?v=${video}`, `https://www.youtube.com/shorts/${video}`]) expect(embedTarget(url).frame).toBe(`https://www.youtube-nocookie.com/embed/${video}`);
  expect(embedTarget(`<iframe src="https://www.youtube.com/embed/${video}?start=30&amp;autoplay=1" onload="alert(1)"></iframe>`).frame).toBe(`https://www.youtube-nocookie.com/embed/${video}?start=30`);
  expect(embedTarget("https://www.youtube.com/playlist?list=PL1234567890").frame).toBe("https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890");
});
it("supports Google Maps embed URLs and gives actionable guidance for ordinary map links", () => {
  const url = "https://www.google.com/maps/embed?pb=test";
  expect(embedTarget(`<iframe src="${url}"></iframe>`)).toEqual({ source: url, frame: url, provider: "Google Maps" });
  expect(() => embedTarget("https://maps.app.goo.gl/example")).toThrow("Share → Embed a map");
});
it("rejects executable schemes and HTML, and leaves other HTTPS sites as inert link cards", () => {
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "http://youtube.com", "https://user:pass@youtube.com", "https://youtube.com:444/", '<iframe src="https://www.google.com/maps/embed"></iframe><script>alert(1)</script>']) expect(() => embedSource(url)).toThrow();
  expect(embedTarget(`https://youtube.com.evil.test/watch?v=${video}`).frame).toBeNull();
  expect(embedTarget("https://example.com").provider).toBe("example.com");
  expect(embedData({ height: Infinity, width: 200, align: "evil", mode: "script" })).toMatchObject({ height: null, width: 100, align: "left", mode: "embed" });
});
