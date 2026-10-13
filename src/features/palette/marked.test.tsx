// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Marked, MARK_END, MARK_START, stripMarks } from "./marked";

describe("Marked", () => {
  it("wraps matches in <mark> and never parses markup from the text", () => {
    const html = renderToStaticMarkup(<Marked text={`a ${MARK_START}par${MARK_END}ry <b>x</b> ${MARK_START}win${MARK_END}dow`} />);
    expect(html).toBe("a <mark>par</mark>ry &lt;b&gt;x&lt;/b&gt; <mark>win</mark>dow");
  });
  it("renders plain text and strips markers", () => {
    expect(renderToStaticMarkup(<Marked text="plain" />)).toBe("plain");
    expect(stripMarks(`${MARK_START}a${MARK_END}b`)).toBe("ab");
  });
});
