import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangelogMarkdown, inlineMarkdown } from "./changelogMarkdown";

describe("changelogMarkdown", () => {
  it("renders inline bold, italic, strikethrough, code, and safe links", () => {
    const html = renderToStaticMarkup(
      <p>
        {inlineMarkdown(
          "Use **bold**, *italic*, _also italic_, ~~old~~, `snake_case`, and [docs](https://example.com/docs)."
        )}
      </p>
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<em>also italic</em>");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("<code>snake_case</code>");
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
  });

  it("does not turn snake_case identifiers into emphasis or render unsafe HTML/links/images", () => {
    const html = renderToStaticMarkup(
      <ChangelogMarkdown
        text={[
          "Keep my_snake_case_name intact.",
          "",
          "<script>alert(1)</script> [bad](javascript:alert(1)) ![pic](https://evil.test/a.png)",
        ].join("\n")}
      />
    );
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
    expect(html).not.toContain("<img");
    expect(html).toContain("pic");
  });

  it("renders headings, nested lists, ordered lists, tasks, blockquotes, rules, and fenced code", () => {
    const html = renderToStaticMarkup(
      <ChangelogMarkdown
        text={[
          "## Improvements",
          "",
          "### Details",
          "",
          "- First **item**",
          "  continued here",
          "  - Nested *subitem*",
          "- [x] Done task",
          "- [ ] Open task",
          "",
          "1. Step one",
          "2. Step two",
          "",
          "> Helpful note",
          "",
          "---",
          "",
          "```ts",
          "const x = '**raw**';",
          "```",
        ].join("\n")}
      />
    );
    expect(html).toContain("<h3>Improvements</h3>");
    expect(html).toContain("<h4>Details</h4>");
    expect(html).toContain("<li>First <strong>item</strong> continued here<ul><li>Nested <em>subitem</em></li></ul></li>");
    expect(html).toContain('<li class="cl-task"><span class="cl-check on" role="img" aria-label="Completed"></span>Done task</li>');
    expect(html).toContain('<li class="cl-task"><span class="cl-check" role="img" aria-label="Incomplete"></span>Open task</li>');
    expect(html).toContain("<ol><li>Step one</li><li>Step two</li></ol>");
    expect(html).toContain("<blockquote><p>Helpful note</p></blockquote>");
    expect(html).toContain("<hr/>");
    expect(html).toContain("<pre><code>const x = &#x27;**raw**&#x27;;</code></pre>");
  });
});
