use super::blocks::*;
use super::markdown::{self, Ctx};

#[test]
fn image_html_and_markdown_preserve_layout_but_omit_private_notes() {
    let wrapped = super::html::parse(
        "<div align=\"right\"><img src=\"assets/photo.png\" width=\"75%\" alt=\"A view\"></div>",
    );
    let settings = &wrapped.blocks[0].media.as_ref().unwrap().presentation;
    assert_eq!(settings["align"], "right");
    assert_eq!(settings["width"], 75.0);
    let media = Media {
        src: None,
        name: "original.png".into(),
        attachment: Some(serde_json::json!({"name":"original.png"})),
        presentation: serde_json::json!({"align":"center","widthMode":"percent","width":50,"caption":"Public caption","alt":"A scene","note":"PRIVATE SECRET","link":"https://example.com"}),
    };
    let html = super::html::image_html(&media, "assets/photo.png", true);
    assert!(html.contains("width=\"50%\""));
    assert!(!html.contains("PRIVATE SECRET"));
    let parsed = super::html::parse(&html);
    let p = &parsed.blocks[0].media.as_ref().unwrap().presentation;
    assert_eq!(p["caption"], "Public caption");
    assert_eq!(p["align"], "center");
    assert_eq!(p["width"], 50.0);
    assert_eq!(p["link"], "https://example.com");
    let markup = super::html::image_html(&media, "assets/photo.png", false);
    let markdown = markdown::parse(&markup);
    let p = &markdown.blocks[0].media.as_ref().unwrap().presentation;
    assert_eq!(p["align"], "center");
    assert_eq!(p["alt"], "A scene");
    assert!(!markup.contains("PRIVATE SECRET"));
}

fn kinds(blocks: &[Blk]) -> Vec<String> {
    blocks.iter().map(|b| b.kind.clone()).collect()
}

fn text_of(b: &Blk) -> String {
    plain_of(&b.inline)
}

fn render(blocks: &[Blk]) -> String {
    markdown::render(
        blocks,
        &Ctx {
            asset: &|m| {
                m.attachment
                    .as_ref()
                    .map(|a| format!("assets/{}", a["name"].as_str().unwrap_or("f")))
            },
            title: &|id| Some(format!("Page {id}")),
        },
    )
}

fn has_mark(items: &[Inline], word: &str, mark: &Mark) -> bool {
    items.iter().any(|i| matches!(i, Inline::Text { text, marks } if text.contains(word) && marks.contains(mark)))
}

// ---------------------------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------------------------

const SAMPLE: &str = "---\ntitle: \"My note\"\ntags: [a]\n---\n\n# Ignored heading\n\n## Section\n\nA paragraph with **bold**, *italic*, ~~gone~~, `code` and a [link](https://example.com).\nIt continues here.  \nAfter a hard break.\n\n- one\n- two\n    - nested\n    - more\n- [ ] todo\n- [x] done\n\n1. first\n2. second\n\n> quoted words\n\n> [!TIP]\n> remember this\n\n```rust\nfn main() {}\n```\n\n$$\nx^2\n$$\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";

#[test]
fn markdown_becomes_native_blocks() {
    let p = markdown::parse(SAMPLE);
    assert_eq!(p.title.as_deref(), Some("My note"), "front matter wins");
    assert_eq!(
        kinds(&p.blocks),
        [
            "heading_1",
            "heading_2",
            "paragraph",
            "bullet_list",
            "bullet_list",
            "todo",
            "todo",
            "numbered_list",
            "numbered_list",
            "quote",
            "callout",
            "code",
            "equation",
            "divider",
            "simple_table"
        ]
    );
    let para = &p.blocks[2];
    assert!(has_mark(&para.inline, "bold", &Mark::Bold));
    assert!(has_mark(&para.inline, "italic", &Mark::Italic));
    assert!(has_mark(&para.inline, "gone", &Mark::Strike));
    assert!(has_mark(&para.inline, "code", &Mark::Code));
    assert!(has_mark(
        &para.inline,
        "link",
        &Mark::Link("https://example.com".into())
    ));
    assert!(
        para.inline.contains(&Inline::Break),
        "two trailing spaces are a hard break"
    );
    assert!(text_of(para).contains("It continues here."));
    let two = &p.blocks[4];
    assert_eq!(text_of(two), "two");
    assert_eq!(two.children.len(), 2);
    assert_eq!(text_of(&two.children[0]), "nested");
    assert!(!p.blocks[5].checked && p.blocks[6].checked);
    assert_eq!(p.blocks[10].tone, "tip");
    assert_eq!(p.blocks[11].language.as_deref(), Some("rust"));
    assert_eq!(p.blocks[11].text, "fn main() {}");
    assert_eq!(p.blocks[12].latex, "x^2");
    let table = p.blocks[14].table.as_ref().unwrap();
    assert_eq!(table.len(), 2);
    assert_eq!(plain_of(&table[1][1]), "2");
}

#[test]
fn a_leading_heading_becomes_the_title() {
    let p = markdown::parse("# Hello *there*\n\nBody\n");
    assert_eq!(p.title.as_deref(), Some("Hello there"));
    assert_eq!(kinds(&p.blocks), ["paragraph"]);
    let none = markdown::parse("Just text");
    assert_eq!(none.title, None);
    assert_eq!(markdown::parse("").blocks.len(), 0);
    assert_eq!(
        markdown::parse("\u{feff}# T\r\n\r\ntext\r\n")
            .title
            .as_deref(),
        Some("T")
    );
}

#[test]
fn inline_edge_cases_stay_text() {
    let p = markdown::parse(
        "snake_case_name and 2 * 3 * 4, a\\*b, [not a link] and `unclosed, <b>x</b>",
    );
    let t = text_of(&p.blocks[0]);
    assert!(t.contains("snake_case_name"));
    assert!(t.contains("2 * 3 * 4"));
    assert!(t.contains("a*b"));
    assert!(t.contains("[not a link]"));
    assert!(t.contains("`unclosed"));
    let nested = markdown::parse("***both*** and **bold with `code`**");
    assert!(has_mark(&nested.blocks[0].inline, "both", &Mark::Bold));
    assert!(has_mark(&nested.blocks[0].inline, "both", &Mark::Italic));
    let auto =
        markdown::parse("see https://example.com/a?b=1. Next <https://x.org> and <mailto:a@b.co>");
    assert!(has_mark(
        &auto.blocks[0].inline,
        "https://example.com/a?b=1",
        &Mark::Link("https://example.com/a?b=1".into())
    ));
    assert!(auto.blocks[0].inline.iter().any(|i| matches!(i, Inline::Text { text, marks } if text == "https://x.org" && marks.contains(&Mark::Link("https://x.org".into())))));
}

#[test]
fn images_are_inline_until_a_file_is_found() {
    let p = markdown::parse("![a cat](pics/cat.png)\n\ntext ![inline](x.png) more");
    assert!(
        matches!(&p.blocks[0].inline[0], Inline::Image { src, alt } if src == "pics/cat.png" && alt == "a cat")
    );
    let json = inlines_to_json(&p.blocks[1].inline);
    assert!(
        json.to_string().contains("x.png"),
        "kept as a link when it cannot be an image block"
    );
}

#[test]
fn nested_lists_toggles_and_quotes() {
    let md = "1. step\n    - sub a\n    - sub b\n        - deep\n2. step two\n\n<details open>\n<summary>More</summary>\n\nhidden **text**\n\n- item\n\n</details>\n\n> line one\n> line two\n";
    let p = markdown::parse(md);
    assert_eq!(
        kinds(&p.blocks),
        ["numbered_list", "numbered_list", "toggle", "quote"]
    );
    assert_eq!(p.blocks[0].children.len(), 2);
    assert_eq!(p.blocks[0].children[1].children.len(), 1);
    let toggle = &p.blocks[2];
    assert!(toggle.open);
    assert_eq!(text_of(toggle), "More");
    assert_eq!(kinds(&toggle.children), ["paragraph", "bullet_list"]);
    assert!(text_of(&p.blocks[3]).contains("line one"));
}

#[test]
fn hostile_markdown_does_not_hang_or_explode() {
    let deep = format!("{}x", "> ".repeat(500));
    assert!(!markdown::parse(&deep).blocks.is_empty());
    let nested_list: String = (0..300)
        .map(|i| format!("{}- item\n", "  ".repeat(i)))
        .collect();
    let _ = markdown::parse(&nested_list);
    let brackets = "[".repeat(5000) + &"]".repeat(5000) + "(x)";
    let _ = markdown::parse(&brackets);
    let stars = "*a ".repeat(3000);
    let _ = markdown::parse(&stars);
    let ticks = "`".repeat(4000);
    let _ = markdown::parse(&ticks);
    let table = "|".repeat(20000);
    let _ = markdown::parse(&format!("{table}\n|-|\n"));
}

fn sample_blocks() -> Vec<Blk> {
    let b = |k: &str, t: &str| Blk::with_inline(k, vec![plain(t)]);
    let mut list = b("bullet_list", "outer");
    list.children.push(b("bullet_list", "inner"));
    let mut todo = b("todo", "task");
    todo.checked = true;
    let mut code = Blk::new("code");
    code.language = Some("py".into());
    code.text = "print('```')".into();
    let mut eq = Blk::new("equation");
    eq.latex = "a+b".into();
    let mut callout = b("callout", "heads up");
    callout.tone = "warning".into();
    let mut toggle = b("toggle", "Summary");
    toggle.open = true;
    toggle.children.push(b("paragraph", "inside"));
    let mut table = Blk::new("simple_table");
    table.table = Some(vec![
        vec![vec![plain("h1")], vec![plain("h|2")]],
        vec![vec![plain("c1")], vec![plain("c2")]],
    ]);
    let rich = Blk::with_inline(
        "paragraph",
        vec![
            Inline::Text {
                text: "bold".into(),
                marks: vec![Mark::Bold],
            },
            plain(" and "),
            Inline::Text {
                text: "linked".into(),
                marks: vec![Mark::Link("https://a.example/x".into())],
            },
            Inline::Break,
            plain("a*b_c"),
        ],
    );
    vec![
        b("heading_2", "Title"),
        rich,
        list,
        b("numbered_list", "one"),
        b("numbered_list", "two"),
        todo,
        b("quote", "wise"),
        callout,
        Blk::new("divider"),
        code,
        eq,
        toggle,
        table,
    ]
}

#[test]
fn exported_markdown_imports_back_to_the_same_blocks() {
    let original = sample_blocks();
    let md = render(&original);
    let back = markdown::parse(&md).blocks;
    assert_eq!(kinds(&back), kinds(&original), "{md}");
    assert!(has_mark(&back[1].inline, "bold", &Mark::Bold));
    assert!(has_mark(
        &back[1].inline,
        "linked",
        &Mark::Link("https://a.example/x".into())
    ));
    assert!(
        text_of(&back[1]).contains("a*b_c"),
        "special characters survive: {md}"
    );
    assert_eq!(back[2].children.len(), 1);
    assert!(back[5].checked);
    assert_eq!(back[7].tone, "warning");
    assert_eq!(
        back[9].text, "print('```')",
        "a longer fence protects the code"
    );
    assert_eq!(back[9].language.as_deref(), Some("py"));
    assert_eq!(back[10].latex, "a+b");
    assert!(back[11].open);
    assert_eq!(text_of(&back[11].children[0]), "inside");
    let t = back[12].table.as_ref().unwrap();
    assert_eq!(plain_of(&t[0][1]), "h|2");
    // Numbering restarts after other blocks and counts consecutive items.
    assert!(md.contains("1. one\n2. two"));
}

#[test]
fn blocks_survive_the_trip_through_stored_rows() {
    let original = sample_blocks();
    let rows: Vec<crate::domain::Block> = flatten(&original)
        .into_iter()
        .map(|u| crate::domain::Block {
            id: u.id,
            page_id: "p".into(),
            parent_block_id: u.parent_block_id,
            block_type: u.block_type,
            position: u.position,
            data_json: u.data_json,
            schema_version: u.schema_version,
            revision: 1,
            created_at: String::new(),
            updated_at: String::new(),
        })
        .collect();
    let back = tree_from_rows(&rows);
    assert_eq!(render(&back), render(&original));
    assert_eq!(rows.len(), 15, "children are rows of their own");
}

// ---------------------------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------------------------

use super::html;

#[test]
fn html_becomes_native_blocks_and_drops_anything_active() {
    let src = r#"<!doctype html><html><head><title>Doc title</title><style>p{color:red}</style><script>alert(1)</script></head>
<body><h1>Doc title</h1><h2>Section &amp; more</h2>
<p>Hello <strong>bold</strong> <em>it</em> <a href="https://a.example/x?y=1&amp;z=2">link</a> <a href="javascript:alert(1)">bad</a><br>next line</p>
<script>document.write('x')</script><iframe src="https://evil.example"></iframe>
<ul><li>one<ul><li>nested</li></ul></li><li><input type="checkbox" checked> done</li></ul>
<ol><li>first</li><li>second</li></ol>
<blockquote><p>wise</p><p>words</p></blockquote>
<pre><code class="language-rust">fn main() {
    println!("hi");
}</code></pre>
<hr><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<details open><summary>More</summary><p>inside</p></details>
<p onclick="x()">plain <img src="pic.png" alt="a pic"> end</p></body></html>"#;
    let p = html::parse(src);
    assert_eq!(p.title.as_deref(), Some("Doc title"));
    let k = kinds(&p.blocks);
    assert_eq!(
        k,
        [
            "heading_1",
            "paragraph",
            "bullet_list",
            "todo",
            "numbered_list",
            "numbered_list",
            "quote",
            "code",
            "divider",
            "simple_table",
            "toggle",
            "paragraph"
        ],
        "the only <h1> is the title, so <h2> is the top heading"
    );
    assert_eq!(text_of(&p.blocks[0]), "Section & more");
    let all = format!("{:?}", p.blocks);
    assert!(
        !all.contains("alert")
            && !all.contains("document.write")
            && !all.contains("evil.example")
            && !all.contains("color:red"),
        "nothing active survives"
    );
    assert!(has_mark(
        &p.blocks[1].inline,
        "link",
        &Mark::Link("https://a.example/x?y=1&z=2".into())
    ));
    // The link's href is kept raw by the parser; the importer's sanitizer removes unsafe ones.
    assert!(p.blocks[1].inline.contains(&Inline::Break));
    assert_eq!(p.blocks[2].children.len(), 1);
    assert!(p.blocks[3].checked);
    assert_eq!(p.blocks[7].language.as_deref(), Some("rust"));
    assert!(
        p.blocks[7].text.contains("    println!"),
        "code keeps its whitespace"
    );
    assert_eq!(text_of(&p.blocks[6]), "wise words");
    assert!(p.blocks[10].open);
    assert!(
        matches!(p.blocks[11].inline.iter().find(|i| matches!(i, Inline::Image { .. })), Some(Inline::Image { src, .. }) if src == "pic.png")
    );
}

#[test]
fn html_export_is_escaped_and_reimports() {
    let mut para = Blk::with_inline(
        "paragraph",
        vec![
            plain("<script>alert(1)</script> & \"quotes\""),
            Inline::Text {
                text: "link".into(),
                marks: vec![Mark::Link("javascript:alert(1)".into())],
            },
        ],
    );
    para.inline.push(Inline::Text {
        text: "ok".into(),
        marks: vec![Mark::Link("https://x.example/?a=1&b=2".into()), Mark::Bold],
    });
    let mut blocks = sample_blocks();
    blocks.insert(1, para);
    let doc = html::render_document(
        "A <title>",
        &blocks,
        &Ctx {
            asset: &|_| None,
            title: &|_| None,
        },
    );
    assert!(!doc.contains("<script>"));
    assert!(!doc.contains("javascript:"));
    assert!(doc.contains("&lt;script&gt;"));
    assert!(doc.contains("<title>A &lt;title&gt;</title>"));
    let back = html::parse(&doc);
    assert_eq!(back.title.as_deref(), Some("A <title>"));
    assert_eq!(kinds(&back.blocks), kinds(&blocks), "{doc}");
    assert!(text_of(&back.blocks[1]).contains("<script>alert(1)</script>"));
}

#[test]
fn hostile_html_does_not_hang_or_explode() {
    let deep = "<div>".repeat(5000) + "x";
    let _ = html::parse(&deep);
    let lists = "<ul><li>".repeat(2000);
    let _ = html::parse(&lists);
    let _ = html::parse(&"<a ".repeat(10000));
    let _ = html::parse(&"&".repeat(50000));
    let _ = html::parse("<table>".repeat(500).as_str());
    let _ = html::parse("<script>never closed");
    let _ = html::parse("<!-- never closed");
    let _ = html::parse("<<<<>>>><//><p/>");
}

// ---------------------------------------------------------------------------------------------
// csv, import, export and the archive
// ---------------------------------------------------------------------------------------------

use super::archive::{self, Archive};
use super::csvio;
use super::{export, import};
use crate::database::open_in_memory;
use crate::databases::service as dbs;
use crate::domain::{new_id, PageCreate, WorkspaceCreate};
use crate::repositories as repo;
use crate::services;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

fn temp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("tako-transfer-{}", new_id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn workspace() -> (Connection, String, PathBuf) {
    let mut conn = open_in_memory().unwrap();
    let ws = services::workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "W".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    (conn, ws.id, temp())
}

fn write(dir: &Path, rel: &str, content: &[u8]) -> PathBuf {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, content).unwrap();
    p
}

fn pages_under(conn: &Connection, root: &str) -> Vec<crate::domain::Page> {
    let ids = repo::page::subtree_ids(conn, root).unwrap();
    ids.iter()
        .filter(|i| *i != root)
        .map(|i| repo::page::get(conn, i).unwrap().unwrap())
        .collect()
}

fn page_text(conn: &Connection, page_id: &str) -> String {
    tree_from_rows(&repo::block::list(conn, page_id).unwrap())
        .iter()
        .map(|b| plain_of(&b.inline))
        .collect::<Vec<_>>()
        .join("|")
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn csv_files_are_read_and_typed() {
    let text = "Name;Qty;Done;Due;Team;Site;Note\r\nAlpha;1,234.5;yes;2026-10-07;A;https://a.example;\"multi\nline\"\nBeta;7;no;2026/10/08 09:30;B;https://b.example;x\nGamma;8;yes;2026-10-09;A;https://c.example;y\nDelta;9;no;2026-10-10;B;https://d.example;z\nEps;10;yes;2026-10-11;A;https://e.example;w\nZeta;11;no;;B;https://f.example;v\n";
    let csv = csvio::read(text.as_bytes()).unwrap();
    assert_eq!(
        csv.headers,
        ["Name", "Qty", "Done", "Due", "Team", "Site", "Note"]
    );
    assert_eq!(csv.rows.len(), 6);
    assert_eq!(csv.rows[0][6], "multi\nline");
    let plan = csvio::plan(&csv);
    let kinds: Vec<&str> = plan.iter().map(|p| p.kind.as_str()).collect();
    assert_eq!(
        kinds,
        ["title", "number", "checkbox", "date", "select", "url", "text"]
    );
    assert_eq!(csvio::cell_value("number", "1,234.5"), Some(json!(1234.5)));
    assert_eq!(
        csvio::cell_value("date", "2026/10/08 09:30"),
        Some(json!({ "start": "2026-10-08T09:30" }))
    );
    assert_eq!(csvio::cell_value("checkbox", "No"), None);
    assert_eq!(csvio::cell_value("number", "abc"), None);
    assert_eq!(csvio::cell_value("email", "nope"), None);
    // Byte order marks, tabs and old encodings.
    let bom = csvio::read(b"\xEF\xBB\xBFa\tb\n1\t2\n").unwrap();
    assert_eq!(bom.headers, ["a", "b"]);
    let latin = csvio::read(b"name\ncaf\xe9\n").unwrap();
    assert_eq!(latin.rows[0][0], "café");
    let dup = csvio::read(b"x,x,\n1,2,3\n").unwrap();
    assert_eq!(dup.headers, ["x", "x 2", "Column 3"]);
    assert!(csvio::read(b"   \n").is_err());
    let big: String = std::iter::once("a\n".to_string())
        .chain((0..csvio::MAX_ROWS + 5).map(|i| format!("{i}\n")))
        .collect();
    let capped = csvio::read(big.as_bytes()).unwrap();
    assert!(capped.truncated);
    assert_eq!(capped.rows.len(), csvio::MAX_ROWS);
    // Spreadsheet formulas are defused on the way out.
    assert_eq!(csvio::neutralize("=1+1".into()), "'=1+1");
    assert_eq!(csvio::neutralize("-cmd".into()), "'-cmd");
    assert_eq!(csvio::neutralize("-5".into()), "-5");
    assert_eq!(csvio::neutralize("fine".into()), "fine");
}

#[test]
fn a_folder_of_notes_becomes_nested_pages_with_files_and_links() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    write(&src, "Home.md", b"# Home\n\nSee [the plan](plan/Plan.md#top) and [missing](nope.md) and [bad](javascript:alert(1)).\n\n![pic](img/cat.png)\n\n[Spec](docs/spec.pdf)\n");
    write(
        &src,
        "plan/Plan.md",
        b"---\ntitle: The Plan\n---\n\n- step one\n- step two\n\nBack to [home](../Home.md)\n",
    );
    write(
        &src,
        "plan/notes.txt",
        b"first line\nsecond line\n\nnew paragraph",
    );
    write(&src, "page.html", b"<html><head><title>From the web</title></head><body><p>hello <b>world</b></p></body></html>");
    write(
        &src,
        "people.csv",
        b"Name,Age,Team\nAnn,31,A\nBob,42,B\nCy,29,A\nDee,50,B\nEd,33,A\nFay,41,B\n",
    );
    write(&src, "img/cat.png", b"\x89PNG not really a png");
    write(&src, "docs/spec.pdf", b"%PDF-1.4 fake");
    write(&src, ".hidden/secret.md", b"hidden");
    let staged = import::stage_folder(src.clone()).unwrap();
    let pv = import::preview(&staged);
    assert_eq!(
        (pv.databases, pv.records),
        (1, 6),
        "{:?}",
        pv.entries
            .iter()
            .map(|e| (&e.name, &e.kind))
            .collect::<Vec<_>>()
    );
    assert_eq!(pv.attachments, 2);
    assert!(pv
        .entries
        .iter()
        .any(|e| e.kind == "database" && e.columns.as_ref().is_some_and(|c| c.len() == 3)));
    let before = count(&conn, "SELECT COUNT(*) FROM page");
    let res = import::apply(&mut conn, &store, &ws, &staged, &HashMap::new()).unwrap();
    assert_eq!(
        (res.databases, res.records, res.attachments),
        (1, 6, 2),
        "{:?}",
        res.warnings
    );
    let kids = pages_under(&conn, &res.page_id);
    let titles: Vec<&str> = kids.iter().map(|p| p.title.as_str()).collect();
    for t in [
        "Home",
        "The Plan",
        "notes",
        "From the web",
        "people",
        "plan",
    ] {
        assert!(titles.contains(&t), "{t} in {titles:?}");
    }
    assert!(
        !titles.contains(&"secret") && !titles.contains(&"hidden"),
        "hidden folders are skipped"
    );
    let home = kids.iter().find(|p| p.title == "Home").unwrap();
    let plan = kids.iter().find(|p| p.title == "The Plan").unwrap();
    let folder = kids.iter().find(|p| p.title == "plan").unwrap();
    assert_eq!(plan.parent_page_id.as_deref(), Some(folder.id.as_str()));
    let home_blocks = tree_from_rows(&repo::block::list(&conn, &home.id).unwrap());
    let links: Vec<String> = home_blocks
        .iter()
        .flat_map(|b| b.inline.iter())
        .filter_map(|i| match i {
            Inline::Text { marks, .. } => marks.iter().find_map(|m| {
                if let Mark::Link(h) = m {
                    Some(h.clone())
                } else {
                    None
                }
            }),
            _ => None,
        })
        .collect();
    assert_eq!(
        links,
        vec![format!("suivelle://page/{}", plan.id)],
        "links between imported files become page links; broken and unsafe ones are dropped"
    );
    assert!(home_blocks
        .iter()
        .any(|b| b.kind == "image" && b.media.as_ref().unwrap().attachment.is_some()));
    assert!(
        home_blocks
            .iter()
            .any(|b| b.kind == "file" || b.kind == "pdf"),
        "a link to a PDF becomes a file block"
    );
    let notes = kids.iter().find(|p| p.title == "notes").unwrap();
    assert_eq!(
        page_text(&conn, &notes.id),
        "first line second line|new paragraph"
    );
    assert!(count(&conn, "SELECT COUNT(*) FROM page") > before);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachment"), 2);
    // The database got typed properties and its rows.
    let people = kids.iter().find(|p| p.title == "people").unwrap();
    let detail = dbs::database_detail_by_page(&conn, &people.id).unwrap();
    let types: Vec<(&str, &str)> = detail
        .properties
        .iter()
        .map(|p| (p.name.as_str(), p.property_type.as_str()))
        .collect();
    assert_eq!(
        types,
        [("Name", "title"), ("Age", "number"), ("Team", "select")]
    );
    assert_eq!(
        detail.properties[2].config["options"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn csv_columns_can_be_retyped_and_skipped() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    let f = write(&src, "t.csv", b"Name,Code,Junk\nA,1,x\nB,2,y\nC,3,z\n");
    let staged = import::stage_files(vec![f]).unwrap();
    let pv = import::preview(&staged);
    let index = pv
        .entries
        .iter()
        .find(|e| e.kind == "database")
        .unwrap()
        .index;
    assert_eq!(pv.entries[0].columns.as_ref().unwrap()[1].kind, "number");
    let mut over = HashMap::new();
    over.insert(
        index,
        vec!["title".to_string(), "text".to_string(), "skip".to_string()],
    );
    let res = import::apply(&mut conn, &store, &ws, &staged, &over).unwrap();
    let db = pages_under(&conn, &res.page_id)
        .into_iter()
        .find(|p| p.kind == "database")
        .unwrap();
    let detail = dbs::database_detail_by_page(&conn, &db.id).unwrap();
    assert_eq!(
        detail
            .properties
            .iter()
            .map(|p| (p.name.as_str(), p.property_type.as_str()))
            .collect::<Vec<_>>(),
        [("Name", "title"), ("Code", "text")]
    );
}

#[test]
fn a_failed_import_changes_nothing() {
    let (mut conn, _ws, store) = workspace();
    let src = temp();
    let f = write(&src, "a.md", b"# A\n\ntext");
    let staged = import::stage_files(vec![f]).unwrap();
    let before = count(&conn, "SELECT COUNT(*) FROM page");
    let missing = new_id();
    assert!(import::apply(&mut conn, &store, &missing, &staged, &HashMap::new()).is_err());
    assert_eq!(before, count(&conn, "SELECT COUNT(*) FROM page"));
    // And unsupported input is refused up front.
    let junk = write(&src, "x.bin", b"1");
    assert!(import::stage_files(vec![junk]).is_err());
    assert!(import::stage_files(vec![]).is_err());
    assert!(import::stage_folder(src.join("nope")).is_err());
}

#[test]
fn files_outside_the_chosen_folder_are_never_read() {
    let (mut conn, ws, store) = workspace();
    let outer = temp();
    write(&outer, "secret.png", b"\x89PNG secret");
    let src = outer.join("inside");
    write(&src, "a.md", b"![x](../secret.png)\n\n[y](../secret.png)\n");
    let staged = import::stage_folder(src).unwrap();
    assert_eq!(import::preview(&staged).attachments, 0);
    let res = import::apply(&mut conn, &store, &ws, &staged, &HashMap::new()).unwrap();
    assert_eq!(res.attachments, 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachment"), 0);
}

fn store_png(
    conn: &mut Connection,
    ws: &str,
    store: &Path,
    name: &str,
    bytes: &[u8],
) -> (String, u64, crate::domain::Attachment) {
    let (hash, size) = crate::files::store_reader(store, &mut &bytes[..], 1 << 20).unwrap();
    let tx = conn.transaction().unwrap();
    let a = crate::files::insert_attachment_in(&tx, ws, &hash, name, "image/png", size).unwrap();
    tx.commit().unwrap();
    (hash, size, a)
}

#[test]
fn cropped_image_exports_match_preview_and_import_with_layout() {
    let (mut conn, ws, store) = workspace();
    let page = services::page::create(
        &mut conn,
        crate::domain::PageCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            title: Some("Crop test".into()),
            icon: None,
        },
    )
    .unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        100,
        80,
        image::Rgba([20, 40, 60, 255]),
    ))
    .write_to(&mut bytes, image::ImageFormat::Png)
    .unwrap();
    let (hash, size, att) = store_png(&mut conn, &ws, &store, "scene.png", &bytes.into_inner());
    let block = Blk {
        media: Some(Media {
            src: None,
            name: "scene.png".into(),
            attachment: Some(
                json!({"id":att.id,"hash":hash,"name":"scene.png","mime":"image/png","size":size}),
            ),
            presentation: json!({"align":"right","width":480,"widthMode":"px","caption":"A crop","alt":"A scene","note":"PRIVATE SECRET","crop":{"x":0.2,"y":0.25,"width":0.5,"height":0.5}}),
        }),
        ..Blk::new("image")
    };
    services::block::apply_batch(
        &mut conn,
        crate::domain::BlockBatch {
            page_id: page.id.clone(),
            upserts: flatten(&[block]),
            delete_ids: vec![],
        },
    )
    .unwrap();
    for format in ["markdown", "html"] {
        let preview = export::preview(&conn, &page.id, format).unwrap();
        assert!(!preview.source.contains("PRIVATE SECRET"));
        assert!(preview
            .notices
            .iter()
            .any(|n| n.contains("Private image notes")));
        let folder = temp();
        export::export_page_folder(&conn, &store, &page.id, format, &folder).unwrap();
        let file = folder.join(if format == "html" {
            "Crop test.html"
        } else {
            "Crop test.md"
        });
        assert_eq!(std::fs::read_to_string(file).unwrap(), preview.source);
        let asset = std::fs::read_dir(folder.join("assets"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(image::image_dimensions(asset).unwrap(), (50, 40));
        assert_eq!(
            image::ImageReader::open(crate::files::blob_path(&store, &hash))
                .unwrap()
                .with_guessed_format()
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (100, 80)
        );
        let (mut other, other_ws, other_store) = workspace();
        let staged = import::stage_folder(folder).unwrap();
        let imported = import::apply(
            &mut other,
            &other_store,
            &other_ws,
            &staged,
            &HashMap::new(),
        )
        .unwrap();
        let exported_page = pages_under(&other, &imported.page_id)
            .into_iter()
            .find(|p| p.title == "Crop test")
            .unwrap();
        let rows = crate::repositories::block::list(&other, &exported_page.id).unwrap();
        let row = rows.iter().find(|b| b.block_type == "image").unwrap();
        let data: serde_json::Value = serde_json::from_str(&row.data_json).unwrap();
        assert_eq!(data["presentation"]["align"], "right");
        assert_eq!(data["presentation"]["width"], 480.0);
        assert!(data["presentation"].get("note").is_none());
    }
}

#[test]
fn exporting_pages_and_databases_round_trips_through_import() {
    let (mut conn, ws, store) = workspace();
    let parent = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            title: Some("Trip: plan/2026?".into()),
            icon: None,
        },
    )
    .unwrap();
    let child = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.clone(),
            parent_page_id: Some(parent.id.clone()),
            title: Some("Day one".into()),
            icon: None,
        },
    )
    .unwrap();
    let (hash, size, att) = store_png(&mut conn, &ws, &store, "map.png", b"\x89PNG data");
    let body = vec![
        Blk::with_inline("heading_2", vec![plain("Packing")]),
        Blk::with_inline("todo", vec![plain("passport")]),
        Blk {
            media: Some(Media {
                src: None,
                name: "map.png".into(),
                presentation: serde_json::Value::Null,
                attachment: Some(
                    json!({ "id": att.id, "hash": hash, "name": "map.png", "mime": "image/png", "size": size }),
                ),
            }),
            ..Blk::new("image")
        },
    ];
    services::block::apply_batch(
        &mut conn,
        crate::domain::BlockBatch {
            page_id: parent.id.clone(),
            upserts: flatten(&body),
            delete_ids: vec![],
        },
    )
    .unwrap();
    services::block::apply_batch(
        &mut conn,
        crate::domain::BlockBatch {
            page_id: child.id.clone(),
            upserts: flatten(&[Blk::with_inline("paragraph", vec![plain("Land at noon")])]),
            delete_ids: vec![],
        },
    )
    .unwrap();
    assert!(export::shape(&conn, &parent.id).unwrap().needs_folder);
    assert!(!export::shape(&conn, &child.id).unwrap().needs_folder);
    let out = temp();
    let w = export::export_page_folder(&conn, &store, &parent.id, "markdown", &out).unwrap();
    assert_eq!((w.files, w.attachments), (2, 1));
    let main = out.join("Trip- plan-2026-.md");
    let text = std::fs::read_to_string(&main).unwrap();
    assert!(text.starts_with("# Trip: plan/2026?\n"));
    assert!(text.contains("- [ ] passport") && text.contains("![map.png](assets/"));
    assert!(out.join("Trip- plan-2026-").join("Day one.md").exists());
    assert_eq!(std::fs::read_dir(out.join("assets")).unwrap().count(), 1);
    // HTML works the same way and is self-contained.
    let out_html = temp();
    export::export_page_folder(&conn, &store, &parent.id, "html", &out_html).unwrap();
    let h = std::fs::read_to_string(out_html.join("Trip- plan-2026-.html")).unwrap();
    assert!(h.contains("<input type=\"checkbox\" disabled>") && h.contains("<img src=\"assets/"));
    // Importing the exported folder gives the same pages back.
    let (mut conn2, ws2, store2) = workspace();
    let staged = import::stage_folder(out.clone()).unwrap();
    let res = import::apply(&mut conn2, &store2, &ws2, &staged, &HashMap::new()).unwrap();
    assert_eq!(res.attachments, 1, "{:?}", res.warnings);
    let kids = pages_under(&conn2, &res.page_id);
    let trip = kids
        .iter()
        .find(|p| p.title == "Trip: plan/2026?")
        .expect("the title comes back from the heading");
    let day = kids.iter().find(|p| p.title == "Day one").unwrap();
    assert_eq!(page_text(&conn2, &day.id), "Land at noon");
    let blocks = tree_from_rows(&repo::block::list(&conn2, &trip.id).unwrap());
    assert_eq!(kinds(&blocks), ["heading_2", "todo", "image"]);
    // A single page needs no folder.
    let single = temp().join("Day one.md");
    export::export_page_file(&conn, &store, &child.id, "markdown", &single).unwrap();
    assert!(std::fs::read_to_string(&single)
        .unwrap()
        .contains("Land at noon"));
}

#[test]
fn database_csv_is_complete_readable_and_safe() {
    let (mut conn, ws, _store) = workspace();
    let made = crate::databases::templates::create_from_template(
        &mut conn,
        crate::databases::templates::TemplateCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            template: "task_tracker".into(),
            sample_data: true,
        },
    )
    .unwrap();
    let page = made.database_page_ids[0].clone();
    let (title, bytes) = export::database_csv(&conn, &page).unwrap();
    assert!(!title.is_empty());
    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    let back = csvio::read(&bytes).unwrap();
    let detail = dbs::database_detail_by_page(&conn, &page).unwrap();
    assert_eq!(
        back.headers.len(),
        detail
            .properties
            .iter()
            .filter(|p| p.property_type != "button")
            .count()
    );
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL", [&detail.database.id], |r| r.get(0)).unwrap();
    assert_eq!(back.rows.len() as i64, n);
    assert!(n > 0);
    // Readable values: option names, not ids.
    let status = detail
        .properties
        .iter()
        .position(|p| p.property_type == "status")
        .unwrap();
    let names: Vec<String> = detail.properties[status].config["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["name"].as_str().unwrap().to_string())
        .collect();
    assert!(back
        .rows
        .iter()
        .all(|r| r[status].is_empty() || names.contains(&r[status])));
    // A title that looks like a formula is defused.
    dbs::create_record(
        &mut conn,
        crate::databases::RecordCreate {
            database_id: detail.database.id.clone(),
            title: Some("=HYPERLINK(\"http://x\")".into()),
            values: Default::default(),
            template_id: None,
        },
    )
    .unwrap();
    let (_, bytes) = export::database_csv(&conn, &page).unwrap();
    let again = csvio::read(&bytes).unwrap();
    assert!(again
        .rows
        .iter()
        .any(|r| r[0] == "'=HYPERLINK(\"http://x\")"));
}

// ---- the archive ----

fn snapshot(conn: &Connection, ws: &str, only_under: Option<&str>) -> BTreeMap<String, String> {
    let allowed: Option<Vec<String>> =
        only_under.map(|r| repo::page::subtree_ids(conn, r).unwrap());
    let mut out = BTreeMap::new();
    let mut stmt = conn.prepare("SELECT d.id, d.page_id, p.title FROM db_database d JOIN page p ON p.id = d.page_id WHERE d.workspace_id = ?1 AND p.deleted_at IS NULL").unwrap();
    let list: Vec<(String, String, String)> = stmt
        .query_map([ws], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for (db, page, title) in list {
        if allowed.as_ref().is_some_and(|a| !a.contains(&page)) {
            continue;
        }
        let props = dbs::load_properties(conn, &db).unwrap();
        let views = dbs::load_views(conn, &db).unwrap();
        let ids: Vec<String> = conn
            .prepare("SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id")
            .unwrap()
            .query_map([&db], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let rows = dbs::load_rows(conn, &ids).unwrap();
        let name_of = |id: &str| {
            props
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.name.clone())
                .unwrap_or_default()
        };
        let mut cells: Vec<String> = Vec::new();
        for r in &rows {
            let mut vals: Vec<String> = r
                .values
                .iter()
                .filter(|(k, _)| {
                    props.iter().any(|p| {
                        &p.id == *k && !matches!(p.property_type.as_str(), "relation" | "rollup")
                    })
                })
                .map(|(k, v)| format!("{}={}", name_of(k), v))
                .collect();
            vals.sort();
            cells.push(format!("{}[{}]", r.title, vals.join(",")));
        }
        cells.sort();
        let links: i64 = conn.query_row("SELECT COUNT(*) FROM db_relation x JOIN db_property p ON p.id = x.property_id WHERE p.database_id = ?1", [&db], |r| r.get(0)).unwrap();
        out.insert(
            title,
            format!(
                "props={:?};views={:?};links={links};records={cells:?}",
                props
                    .iter()
                    .map(|p| format!("{}:{}", p.name, p.property_type))
                    .collect::<Vec<_>>(),
                views
                    .iter()
                    .map(|v| format!("{}:{}", v.name, v.view_type))
                    .collect::<Vec<_>>()
            ),
        );
    }
    out
}

fn rich_workspace() -> (Connection, String, PathBuf) {
    let (mut conn, ws, store) = workspace();
    let made = crate::databases::templates::create_from_template(
        &mut conn,
        crate::databases::templates::TemplateCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            template: "project_manager".into(),
            sample_data: true,
        },
    )
    .unwrap();
    let notes = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            title: Some("Notes".into()),
            icon: Some("📝".into()),
        },
    )
    .unwrap();
    let (hash, size, att) = store_png(&mut conn, &ws, &store, "pic.png", b"\x89PNG archive data");
    let target_page = made.database_page_ids[0].clone();
    let mut body = vec![
        Blk::with_inline(
            "paragraph",
            vec![plain("See "), Inline::Mention(target_page.clone())],
        ),
        Blk {
            media: Some(Media {
                src: None,
                name: "pic.png".into(),
                presentation: serde_json::Value::Null,
                attachment: Some(
                    json!({ "id": att.id, "hash": hash, "name": "pic.png", "mime": "image/png", "size": size }),
                ),
            }),
            ..Blk::new("image")
        },
    ];
    let mut toggle = Blk::with_inline("toggle", vec![plain("T")]);
    toggle
        .children
        .push(Blk::with_inline("paragraph", vec![plain("nested")]));
    body.push(toggle);
    services::block::apply_batch(
        &mut conn,
        crate::domain::BlockBatch {
            page_id: notes.id.clone(),
            upserts: flatten(&body),
            delete_ids: vec![],
        },
    )
    .unwrap();
    // A record body, a record template and a dashboard.
    let detail = dbs::database_detail_by_page(&conn, &target_page).unwrap();
    let rec_page: String = conn
        .query_row(
            "SELECT page_id FROM db_record WHERE database_id = ?1 ORDER BY unique_id LIMIT 1",
            [&detail.database.id],
            |r| r.get(0),
        )
        .unwrap();
    services::block::apply_batch(
        &mut conn,
        crate::domain::BlockBatch {
            page_id: rec_page,
            upserts: flatten(&[Blk::with_inline("quote", vec![plain("record body")])]),
            delete_ids: vec![],
        },
    )
    .unwrap();
    let first_record: String = conn
        .query_row(
            "SELECT id FROM db_record WHERE database_id = ?1 ORDER BY unique_id LIMIT 1",
            [&detail.database.id],
            |r| r.get(0),
        )
        .unwrap();
    crate::databases::record_templates::create(
        &mut conn,
        crate::databases::record_templates::RecordTemplateCreate {
            database_id: detail.database.id.clone(),
            name: "Starter".into(),
            from_record_id: Some(first_record),
        },
    )
    .unwrap();
    let dash = crate::dashboards::create(
        &mut conn,
        crate::dashboards::DashboardCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            title: Some("Overview".into()),
        },
    )
    .unwrap();
    let view_id = detail.views[0].id.clone();
    crate::dashboards::save(
        &mut conn,
        crate::dashboards::DashboardSave {
            page_id: dash.page.id.clone(),
            layout: crate::dashboards::Layout {
                widgets: vec![serde_json::from_value(json!({ "id": "w1", "type": "linked_view", "x": 0, "y": 0, "w": 6, "h": 4, "databaseId": detail.database.id, "viewId": view_id })).unwrap()],
                filters: vec![],
            },
        },
    )
    .unwrap();
    (conn, ws, store)
}

#[test]
fn a_workspace_archive_round_trips_into_another_workspace() {
    let (conn, ws, store) = rich_workspace();
    let dest = temp().join("workspace.zip");
    let counts = archive::export_workspace(&conn, &store, &ws, &dest).unwrap();
    assert!(
        counts.databases >= 3
            && counts.records > 5
            && counts.attachments == 1
            && counts.dashboards == 1,
        "{counts:?}"
    );
    assert!(!dest.with_extension("part").exists());

    // The archive is plain files: manifest, JSON pages and attachments by hash.
    let mut a = Archive::open(&dest).unwrap();
    assert_eq!(a.info().unwrap().counts.databases, counts.databases);
    let z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
    let names: Vec<String> = z.file_names().map(String::from).collect();
    for needed in ["manifest.json", "workspace.json", "attachments.json"] {
        assert!(names.contains(&needed.to_string()), "{needed}");
    }
    assert!(
        names.iter().any(|n| n.starts_with("pages/"))
            && names.iter().any(|n| n.starts_with("databases/"))
            && names.iter().any(|n| n.starts_with("attachments/"))
    );

    let (mut conn2, ws2, store2) = workspace();
    let staged = import::stage_archive(&dest).unwrap();
    let pv = import::preview(&staged);
    assert_eq!(pv.archive.as_ref().unwrap().workspace_name, "W");
    assert_eq!(pv.databases, counts.databases);
    let res = import::apply(&mut conn2, &store2, &ws2, &staged, &HashMap::new()).unwrap();
    assert_eq!(
        (res.databases, res.records, res.attachments),
        (counts.databases, counts.records, 1),
        "{:?}",
        res.warnings
    );
    assert!(res.warnings.is_empty(), "{:?}", res.warnings);

    // Same databases, properties, views, values and links; new ids everywhere.
    assert_eq!(
        snapshot(&conn, &ws, None),
        snapshot(&conn2, &ws2, Some(&res.page_id))
    );
    let old_ids: Vec<String> = conn
        .prepare("SELECT id FROM page")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let new_ids: Vec<String> = conn2
        .prepare("SELECT id FROM page")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(new_ids.iter().all(|n| !old_ids.contains(n)));

    // Pages: icon and blocks; the mention follows the page it pointed at; the file is stored.
    let kids = pages_under(&conn2, &res.page_id);
    let notes2 = kids.iter().find(|p| p.title == "Notes").unwrap();
    assert_eq!(notes2.icon.as_deref(), Some("📝"));
    let blocks = tree_from_rows(&repo::block::list(&conn2, &notes2.id).unwrap());
    assert_eq!(kinds(&blocks), ["paragraph", "image", "toggle"]);
    assert_eq!(blocks[2].children.len(), 1);
    let mention = blocks[0]
        .inline
        .iter()
        .find_map(|i| {
            if let Inline::Mention(id) = i {
                Some(id.clone())
            } else {
                None
            }
        })
        .unwrap();
    let target = repo::page::get(&conn2, &mention)
        .unwrap()
        .expect("the mention points at an imported page");
    assert_eq!(target.kind, "database");
    let att = blocks[1]
        .media
        .as_ref()
        .unwrap()
        .attachment
        .as_ref()
        .unwrap();
    assert!(crate::files::blob_path(&store2, att["hash"].as_str().unwrap()).exists());
    let row = crate::files::get(&conn2, att["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(row.workspace_id, ws2);

    // Record bodies, record templates and the dashboard (rewired to the new database and view).
    assert_eq!(
        count(
            &conn2,
            "SELECT COUNT(*) FROM block WHERE data_json LIKE '%record body%'"
        ),
        1
    );
    assert_eq!(
        count(
            &conn2,
            "SELECT COUNT(*) FROM db_record_template WHERE name = 'Starter'"
        ),
        1
    );
    let dash = kids.iter().find(|p| p.kind == "dashboard").unwrap();
    let layout = crate::dashboards::get(&conn2, &dash.id).unwrap().layout;
    let w = &layout.widgets[0];
    let dbid = w.database_id.clone().unwrap();
    assert!(dbs::load_database(&conn2, &dbid).is_ok());
    assert!(dbs::load_views(&conn2, &dbid)
        .unwrap()
        .iter()
        .any(|v| Some(&v.id) == w.view_id.as_ref()));
    // Importing twice just adds a second copy.
    let again = import::apply(
        &mut conn2,
        &store2,
        &ws2,
        &import::stage_archive(&dest).unwrap(),
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(again.databases, counts.databases);
    assert_eq!(
        snapshot(&conn2, &ws2, Some(&again.page_id)),
        snapshot(&conn, &ws, None)
    );
}

#[test]
fn a_separate_workspace_transfer_preserves_identity_links_views_and_paused_automations() {
    let (mut source, ws, store) = rich_workspace();
    let notes: String = source
        .query_row("SELECT id FROM page WHERE title = 'Notes'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let hash: String = source
        .query_row("SELECT hash FROM attachment LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let block = repo::block::list(&source, &notes).unwrap()[0].id.clone();
    source.execute("UPDATE workspace SET settings_json = ?2, icon = ?3 WHERE id = ?1", rusqlite::params![ws, json!({"description":"Studio notes", "theme":"dark", "accent":"#23ABEF", "sidebarDensity":"compact", "syncedPageId":notes, "windowWidth":1000, "autoBackup":false}).to_string(), format!("image:{hash}")]).unwrap();
    source
        .execute(
            "UPDATE page SET cover = ?2, icon = ?2, archived = 1, favorite = 1, position = 42 WHERE id = ?1",
            rusqlite::params![notes, format!("image:{hash}")],
        )
        .unwrap();
    let db: String = source
        .query_row(
            "SELECT database_id FROM db_record_template WHERE name = 'Starter'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let template: String = source
        .query_row(
            "SELECT id FROM db_record_template WHERE name = 'Starter'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let title = dbs::load_properties(&source, &db)
        .unwrap()
        .into_iter()
        .find(|p| p.property_type == "title")
        .unwrap();
    dbs::create_view(&mut source, crate::databases::ViewCreate { database_id:db.clone(), name:Some("Intake".into()), view_type:"form".into(), config:Some(serde_json::from_value(json!({"form":{"fields":[{"propertyId":title.id,"required":true}], "successMessage":"Received"}})).unwrap()) }).unwrap();
    dbs::create_view(
        &mut source,
        crate::databases::ViewCreate {
            database_id: db.clone(),
            name: Some("Totals".into()),
            view_type: "chart".into(),
            config: Some(
                serde_json::from_value(json!({"chart":{"chartType":"kpi", "aggregation":"count"}}))
                    .unwrap(),
            ),
        },
    )
    .unwrap();
    let mut body: Value = serde_json::from_str(
        &source
            .query_row::<String, _, _>(
                "SELECT body_json FROM db_record_template WHERE id = ?1",
                [&template],
                |r| r.get(0),
            )
            .unwrap(),
    )
    .unwrap();
    body[0]["dataJson"] = json!(json!({"content":[{"type":"text", "text":"Notes", "marks":[{"type":"link", "attrs":{"href":format!("suivelle://page/{notes}#{block}")}}]}]}).to_string());
    source
        .execute(
            "UPDATE db_record_template SET body_json = ?2 WHERE id = ?1",
            rusqlite::params![template, body.to_string()],
        )
        .unwrap();
    crate::automation::save(&mut source, serde_json::from_value(json!({"databaseId":db,"name":"Use starter", "enabled":true,"trigger":{"type":"record_created"},"actions":[{"type":"create_record","title":"Copy", "templateId":template}]})).unwrap()).unwrap();
    let dest = temp().join("workspace.zip");
    let counts = archive::export_workspace(&source, &store, &ws, &dest).unwrap();
    assert_eq!(counts.automations, 1);
    let (mut target, original, target_store) = workspace();
    let imported = archive::import_workspace(&mut target, &target_store, &dest, "W", true).unwrap();
    assert_eq!(imported.workspace.name, "W (imported)");
    assert_eq!(imported.workspace.icon, Some(format!("image:{hash}")));
    assert!(
        crate::files::manage::list_usage(&target, &imported.workspace.id)
            .unwrap()
            .iter()
            .any(|a| a.uses.iter().any(|u| u.workspace))
    );
    assert!(repo::workspace::get(&target, &original).unwrap().is_some());
    assert_eq!(imported.counts.pages, counts.pages);
    assert_eq!(imported.counts.automations, 1);
    assert!(imported.counts.warnings.is_empty());
    assert_eq!(
        snapshot(&source, &ws, None),
        snapshot(&target, &imported.workspace.id, None)
    );
    let settings: Value = serde_json::from_str(&imported.workspace.settings_json).unwrap();
    assert_eq!(settings["description"], "Studio notes");
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["accent"], "#23ABEF");
    assert_eq!(settings["sidebarDensity"], "compact");
    assert!(settings.get("windowWidth").is_none());
    let new_notes: String = target
        .query_row(
            "SELECT id FROM page WHERE workspace_id = ?1 AND title = 'Notes'",
            [&imported.workspace.id],
            |r| r.get(0),
        )
        .unwrap();
    let note = repo::page::get(&target, &new_notes).unwrap().unwrap();
    assert!(
        note.parent_page_id.is_none(),
        "No imported container at the root"
    );
    assert!(note.archived && note.favorite);
    assert_eq!(note.cover, Some(format!("image:{hash}")));
    assert_eq!(note.icon, Some(format!("image:{hash}")));
    assert_eq!(note.position, 42.0);
    assert_eq!(settings["syncedPageId"], new_notes);
    let new_block = repo::block::list(&target, &new_notes).unwrap()[0]
        .id
        .clone();
    let new_template: String = target
        .query_row(
            "SELECT id FROM db_record_template WHERE name = 'Starter'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let template_body: String = target
        .query_row(
            "SELECT body_json FROM db_record_template WHERE id = ?1",
            [&new_template],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        template_body.contains(&format!("suivelle://page/{new_notes}#{new_block}")),
        "{template_body}"
    );
    let (enabled, actions): (i64, String) = target
        .query_row("SELECT enabled, actions_json FROM automation", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(enabled, 0);
    assert!(actions.contains(&new_template) && !actions.contains(&template));
    assert_eq!(count(&target, "SELECT COUNT(*) FROM automation_run"), 0);
    let again = archive::import_workspace(&mut target, &target_store, &dest, "W", false).unwrap();
    assert_eq!(again.workspace.name, "W (imported 2)");
    let settings: Value = serde_json::from_str(&again.workspace.settings_json).unwrap();
    assert!(settings.get("theme").is_none());
}

fn rewrite_archive(path: &std::path::Path, change: impl Fn(&str, &mut Vec<u8>)) -> PathBuf {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut entries = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        let name = entry.name().to_string();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
        change(&name, &mut data);
        entries.push((name, data));
    }
    zip_of(
        &entries
            .iter()
            .map(|(n, b)| (n.as_str(), b.clone()))
            .collect::<Vec<_>>(),
    )
}

#[test]
fn failed_complete_import_rolls_back_and_export_preserves_the_previous_file() {
    let (source, ws, store) = rich_workspace();
    let dest = temp().join("workspace.zip");
    archive::export_workspace(&source, &store, &ws, &dest).unwrap();
    let previous = std::fs::read(&dest).unwrap();
    let (mut target, _, target_store) = workspace();
    let broken = rewrite_archive(&dest, |name, bytes| {
        if name.starts_with("databases/") {
            let mut data: Value = serde_json::from_slice(bytes).unwrap();
            if let Some(property) = data["properties"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|p| p["type"] != "title")
            {
                property["type"] = json!("unsupported_property");
            }
            *bytes = data.to_string().into_bytes();
        }
    });
    let before = count(&target, "SELECT COUNT(*) FROM workspace");
    assert!(
        archive::import_workspace(&mut target, &target_store, &broken, "Broken", true).is_err()
    );
    assert_eq!(count(&target, "SELECT COUNT(*) FROM workspace"), before);
    assert_eq!(count(&target, "SELECT COUNT(*) FROM page"), 0);
    let corrupt_file = rewrite_archive(&dest, |name, bytes| {
        if name.starts_with("attachments/") {
            bytes.push(0);
        }
    });
    assert!(import::stage_workspace_archive(&corrupt_file).is_err());
    let unsupported_block = rewrite_archive(&dest, |name, bytes| {
        if name.starts_with("pages/") {
            let mut data: Value = serde_json::from_slice(bytes).unwrap();
            if let Some(block) = data["blocks"].as_array_mut().unwrap().first_mut() {
                block["type"] = json!("hologram");
            }
            *bytes = data.to_string().into_bytes();
        }
    });
    assert!(import::stage_workspace_archive(&unsupported_block).is_err());
    let missing_icon = rewrite_archive(&dest, |name, bytes| {
        if name.starts_with("pages/") {
            let mut data: Value = serde_json::from_slice(bytes).unwrap();
            data["icon"] = json!(format!("image:{}", "f".repeat(64)));
            *bytes = data.to_string().into_bytes();
        }
    });
    assert!(import::stage_workspace_archive(&missing_icon).is_err());
    let missing_workspace_icon = rewrite_archive(&dest, |name, bytes| {
        if name == "workspace.json" {
            let mut data: Value = serde_json::from_slice(bytes).unwrap();
            data["icon"] = json!(format!("image:{}", "f".repeat(64)));
            *bytes = data.to_string().into_bytes();
        }
    });
    assert!(import::stage_workspace_archive(&missing_workspace_icon).is_err());
    let hash: String = source
        .query_row("SELECT hash FROM attachment LIMIT 1", [], |r| r.get(0))
        .unwrap();
    std::fs::remove_file(crate::files::blob_path(&store, &hash)).unwrap();
    assert!(archive::export_workspace(&source, &store, &ws, &dest).is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), previous);
    assert!(
        !std::fs::read_dir(dest.parent().unwrap()).unwrap().any(|e| e
            .unwrap()
            .path()
            .extension()
            .is_some_and(|e| e == "part"))
    );
}

#[test]
fn empty_files_only_and_legacy_workspaces_import_as_separate_copies() {
    let (mut source, ws, store) = workspace();
    let path = temp().join("empty.zip");
    archive::export_workspace(&source, &store, &ws, &path).unwrap();
    let (mut target, _, target_store) = workspace();
    let empty =
        archive::import_workspace(&mut target, &target_store, &path, "Empty", true).unwrap();
    assert_eq!(empty.counts.pages, 0);
    store_png(
        &mut source,
        &ws,
        &store,
        "orphan.png",
        b"file without a page",
    );
    archive::export_workspace(&source, &store, &ws, &path).unwrap();
    let files =
        archive::import_workspace(&mut target, &target_store, &path, "Files", true).unwrap();
    assert_eq!(files.counts.attachments, 1);
    assert_eq!(files.counts.pages, 0);
    let legacy = rewrite_archive(&path, |name, bytes| {
        if name == "manifest.json" {
            let mut data: Value = serde_json::from_slice(bytes).unwrap();
            data["version"] = json!(1);
            *bytes = data.to_string().into_bytes();
        }
        if name == "workspace.json" {
            *bytes = json!({"name":"Legacy", "icon":null})
                .to_string()
                .into_bytes();
        }
    });
    assert_eq!(
        archive::import_workspace(&mut target, &target_store, &legacy, "Legacy", true)
            .unwrap()
            .counts
            .attachments,
        1
    );
}

#[test]
fn large_workspace_transfers_keep_all_pages_records_and_files() {
    let (mut source, ws, store) = rich_workspace();
    let db: String = source
        .query_row("SELECT id FROM db_database LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let tx = source.transaction().unwrap();
    for i in 0..1000 {
        let page = super::insert_page(
            &tx,
            None,
            &ws,
            None,
            &format!("Note {i}"),
            None,
            "page",
            false,
        )
        .unwrap();
        services::block::apply_batch_in(
            &tx,
            &crate::domain::BlockBatch {
                page_id: page.id,
                upserts: flatten(&[Blk::with_inline(
                    "paragraph",
                    vec![plain(format!("Page {i} content"))],
                )]),
                delete_ids: vec![],
            },
        )
        .unwrap();
    }
    for i in 0..300 {
        dbs::create_record_in(
            &tx,
            crate::databases::RecordCreate {
                database_id: db.clone(),
                title: Some(format!("Record {i}")),
                values: serde_json::Map::new(),
                template_id: None,
            },
        )
        .unwrap();
    }
    tx.commit().unwrap();
    for i in 0..10 {
        store_png(
            &mut source,
            &ws,
            &store,
            &format!("file-{i}.png"),
            &vec![i; 256 * 1024],
        );
    }
    let path = temp().join("large.zip");
    let start = std::time::Instant::now();
    let counts = archive::export_workspace(&source, &store, &ws, &path).unwrap();
    let export_time = start.elapsed();
    let (mut target, _, target_store) = workspace();
    let start = std::time::Instant::now();
    let imported =
        archive::import_workspace(&mut target, &target_store, &path, "Large", true).unwrap();
    eprintln!(
        "Large fixture: {} pages, {} records, {} attachments; export {:?}, import {:?}",
        counts.pages,
        counts.records,
        counts.attachments,
        export_time,
        start.elapsed()
    );
    assert_eq!(imported.counts.pages, counts.pages);
    assert_eq!(imported.counts.records, counts.records);
    assert_eq!(imported.counts.attachments, counts.attachments);
    assert!(imported.counts.warnings.is_empty());
    assert_eq!(
        snapshot(&source, &ws, None),
        snapshot(&target, &imported.workspace.id, None)
    );
}

fn zip_of(entries: &[(&str, Vec<u8>)]) -> PathBuf {
    use std::io::Write;
    let path = temp().join("a.zip");
    let mut z = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for (name, bytes) in entries {
        z.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        z.write_all(bytes).unwrap();
    }
    z.finish().unwrap();
    path
}

fn manifest(version: u64, format: &str) -> Vec<u8> {
    json!({ "format": format, "version": version, "appVersion": "x", "createdAt": "now", "workspaceName": "Evil", "counts": {} }).to_string().into_bytes()
}

fn page_json(id: &str, kind: &str, blocks: Value) -> Vec<u8> {
    json!({ "id": id, "parentId": null, "title": format!("Page {id}"), "kind": kind, "blocks": blocks }).to_string().into_bytes()
}

#[test]
fn older_archive_brand_remains_readable() {
    let path = zip_of(&[("manifest.json", manifest(1, crate::legacy::ARCHIVE_FORMAT))]);
    assert!(import::stage_archive(&path).is_ok());
}

#[test]
fn hostile_or_foreign_archives_are_refused_or_tamed() {
    // Not an archive at all, not ours, or from the future.
    let junk = temp().join("x.zip");
    std::fs::write(&junk, b"definitely not a zip").unwrap();
    assert!(import::stage_archive(&junk).is_err());
    assert!(
        import::stage_archive(&zip_of(&[("readme.txt", b"hi".to_vec())])).is_err(),
        "no manifest"
    );
    assert!(
        import::stage_archive(&zip_of(&[("manifest.json", manifest(1, "something-else"))]))
            .is_err()
    );
    let newer = import::stage_archive(&zip_of(&[("manifest.json", manifest(99, archive::FORMAT))]))
        .err()
        .unwrap();
    assert!(newer.to_string().contains("newer version"));

    let good_hash = "a".repeat(64);
    let blocks = json!([
        { "id": "b1", "parentId": null, "type": "paragraph", "position": 0, "schemaVersion": 2, "data": { "content": [{ "type": "text", "text": "kept" }] } },
        { "id": "b2", "parentId": null, "type": "hologram", "position": 1, "schemaVersion": 2, "data": {} },
        { "id": "b4", "parentId": null, "type": "image", "position": 3, "schemaVersion": 2, "data": { "attachment": { "id": "x", "hash": good_hash, "name": "n", "mime": "image/png", "size": 1 } } }
    ]);
    let attachments = json!([{ "hash": good_hash, "name": "n.png", "mime": "image/png", "size": 3 }, { "hash": "../../etc/passwd", "name": "x", "mime": "x", "size": 1 }]);
    let (mut conn, ws, store) = workspace();

    // A page that is not valid JSON makes the whole archive unreadable rather than half-imported.
    let broken = zip_of(&[
        ("manifest.json", manifest(1, archive::FORMAT)),
        ("pages/p1.json", page_json("p1", "page", blocks.clone())),
        ("pages/broken.json", b"{ not json".to_vec()),
    ]);
    let before = count(&conn, "SELECT COUNT(*) FROM page");
    let staged = import::stage_archive(&broken).unwrap();
    assert!(import::apply(&mut conn, &store, &ws, &staged, &HashMap::new()).is_err());
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM page"),
        before,
        "nothing was created"
    );

    // Odd entry names are never used; bad pieces are skipped and the rest is kept.
    let path = zip_of(&[
        ("manifest.json", manifest(1, archive::FORMAT)),
        ("../evil.json", b"{}".to_vec()),
        ("/abs/evil.json", b"{}".to_vec()),
        ("pages/..\\evil.json", b"{}".to_vec()),
        ("pages/p1.json", page_json("p1", "page", blocks)),
        ("attachments.json", attachments.to_string().into_bytes()),
        (
            &format!("attachments/{good_hash}"),
            b"contents that do not hash to that".to_vec(),
        ),
    ]);
    let res = import::apply(
        &mut conn,
        &store,
        &ws,
        &import::stage_archive(&path).unwrap(),
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(res.pages, 1);
    assert_eq!(
        res.attachments, 0,
        "a file that does not match its checksum is not stored"
    );
    assert!(
        res.warnings.iter().any(|w| w.contains("checksum")),
        "{:?}",
        res.warnings
    );
    let imported = pages_under(&conn, &res.page_id);
    let blocks = tree_from_rows(&repo::block::list(&conn, &imported[0].id).unwrap());
    assert_eq!(
        kinds(&blocks),
        ["paragraph", "image"],
        "the unknown block type is dropped"
    );
    assert!(blocks[1].media.as_ref().unwrap().attachment.is_none());
}

fn column_blocks() -> Vec<Blk> {
    let para = |t: &str| Blk::with_inline("paragraph", vec![plain(t)]);
    let mut left = Blk::new("column");
    left.children.push(para("left side"));
    let mut right = Blk::new("column");
    right.children.push(para("right side"));
    let mut columns = Blk::new("columns");
    columns.children.push(left);
    columns.children.push(right);
    vec![columns]
}

#[test]
fn markdown_export_keeps_what_is_inside_columns() {
    let md = render(&column_blocks());
    assert!(md.contains("left side"), "{md}");
    assert!(md.contains("right side"), "{md}");
    assert!(
        md.find("left side") < md.find("right side"),
        "columns read left to right"
    );
}

#[test]
fn html_export_keeps_what_is_inside_columns() {
    let doc = html::render_document(
        "Cols",
        &column_blocks(),
        &Ctx {
            asset: &|_| None,
            title: &|_| None,
        },
    );
    assert!(doc.contains("<div class=\"columns\">"), "{doc}");
    assert!(
        doc.contains("left side") && doc.contains("right side"),
        "{doc}"
    );
}

#[test]
fn export_writes_the_content_of_synced_blocks_and_names_embedded_databases() {
    let (mut conn, ws, store) = workspace();
    let page = |conn: &mut Connection, title: &str| {
        services::page::create(
            conn,
            PageCreate {
                workspace_id: ws.clone(),
                parent_page_id: None,
                title: Some(title.into()),
                icon: None,
            },
        )
        .unwrap()
    };
    let fill = |conn: &mut Connection, id: &str, blocks: Vec<Blk>| {
        services::block::apply_batch(
            conn,
            crate::domain::BlockBatch {
                page_id: id.into(),
                upserts: flatten(&blocks),
                delete_ids: vec![],
            },
        )
        .unwrap();
    };
    let shared = page(&mut conn, "Footer");
    fill(
        &mut conn,
        &shared.id,
        vec![
            Blk::with_inline("heading_2", vec![plain("Contact us")]),
            Blk::with_inline("paragraph", vec![plain("hello@example.test")]),
        ],
    );
    let tracker = page(&mut conn, "Bug tracker");
    let host = page(&mut conn, "Launch plan");
    let embed = |kind: &str, target: &str| Blk {
        target: Some(target.into()),
        ..Blk::new(kind)
    };
    fill(
        &mut conn,
        &host.id,
        vec![
            Blk::with_inline("paragraph", vec![plain("before")]),
            embed("synced_block", &shared.id),
            embed("database_view", &tracker.id),
            Blk::with_inline("paragraph", vec![plain("after")]),
        ],
    );

    let out = temp().join("Launch plan.md");
    export::export_page_file(&conn, &store, &host.id, "markdown", &out).unwrap();
    let md = std::fs::read_to_string(&out).unwrap();
    for needle in [
        "before",
        "## Contact us",
        "hello@example.test",
        "Database: Bug tracker",
        "after",
    ] {
        assert!(md.contains(needle), "missing {needle:?} in:\n{md}");
    }
    assert!(
        md.find("before") < md.find("Contact us")
            && md.find("Contact us") < md.find("Database: Bug tracker"),
        "kept in reading order:\n{md}"
    );

    let html_out = temp().join("Launch plan.html");
    export::export_page_file(&conn, &store, &host.id, "html", &html_out).unwrap();
    let html = std::fs::read_to_string(&html_out).unwrap();
    assert!(
        html.contains("Contact us")
            && html.contains("hello@example.test")
            && html.contains("Database: Bug tracker")
    );

    // Content that is gone is left out rather than failing the export.
    services::page::delete(&mut conn, &shared.id).unwrap();
    let again = temp().join("again.md");
    export::export_page_file(&conn, &store, &host.id, "markdown", &again).unwrap();
    let md2 = std::fs::read_to_string(&again).unwrap();
    assert!(md2.contains("before") && md2.contains("after") && !md2.contains("hello@example.test"));
}

#[test]
fn tab_panels_export_all_content_and_preserve_labels_in_rows() {
    let mut tabs = Blk::new("tabs");
    for (label, text) in [
        ("Overview", "First panel"),
        ("Notes <private>", "Second panel"),
    ] {
        let mut panel = Blk::new("tab_panel");
        panel.label = label.into();
        panel
            .children
            .push(Blk::with_inline("paragraph", vec![plain(text)]));
        assert_eq!(
            Blk::from_row("tab_panel", &panel.data().to_string(), 2).label,
            label
        );
        tabs.children.push(panel);
    }
    let blocks = vec![tabs];
    let md = render(&blocks);
    let html = html::render_document(
        "Tabs",
        &blocks,
        &Ctx {
            asset: &|_| None,
            title: &|_| None,
        },
    );
    for text in ["First panel", "Second panel", "Overview"] {
        assert!(md.contains(text));
        assert!(html.contains(text));
    }
    assert!(html.contains("Notes &lt;private&gt;"));
    let mut toggle = Blk::with_inline("toggle", vec![plain("Heading")]);
    toggle.level = 4;
    assert_eq!(
        Blk::from_row("toggle", &toggle.data().to_string(), 2).level,
        4
    );
}
