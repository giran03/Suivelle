//! Notion exports, rebuilt from synthetic fixtures that follow Notion's export layout: ids in every
//! name, `_all` CSVs, row pages with property lines, `<aside>` callouts, HTML class names and
//! collection tables, nested "Part" zips, and exports without subpage folders.

use super::super::blocks::*;
use super::super::import::{self, Target};
use crate::database::open_in_memory;
use crate::databases::service as dbs;
use crate::domain::{new_id, Page, WorkspaceCreate};
use crate::repositories as repo;
use crate::services;
use rusqlite::Connection;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

const HOME: &str = "11111111111111111111111111111111";
const PROJECTS: &str = "22222222222222222222222222222222";
const CHILD: &str = "33333333333333333333333333333333";
const TASKS: &str = "44444444444444444444444444444444";
const WRITE: &str = "55555555555555555555555555555555";
const SHIP: &str = "66666666666666666666666666666666";
const ALPHA: &str = "77777777777777777777777777777777";
const GAMMA: &str = "88888888888888888888888888888888";
const ROW: &str = "99999999999999999999999999999999";
const HTASKS: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T1: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn temp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("tako-notion-{}", new_id()));
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

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, content).unwrap();
}

/// A Markdown & CSV export of a page with a subpage, a picture and two related databases.
fn markdown_export(dir: &Path, prefix: &str) {
    let w = |rel: &str, c: &str| write(dir, &format!("{prefix}{rel}"), c);
    w(&format!("Home {HOME}.md"), &format!(
        "# Home\n\n<aside>\n💡 Remember **this**\n\n</aside>\n\n[Projects](Home%20{HOME}/Projects%20{PROJECTS}.csv)\n\n[Child](Home%20{HOME}/Child%20{CHILD}.md)\n\n![shot.png](Home%20{HOME}/shot.png)\n\n- [x] done task\n- [ ] open task\n"
    ));
    w(
        &format!("Home {HOME}/Child {CHILD}.md"),
        &format!("# Child\n\nBack to [Home](../Home%20{HOME}.md) now.\n"),
    );
    w(&format!("Home {HOME}/shot.png"), "\u{89}PNG fake");
    w(
        &format!("Home {HOME}/Projects {PROJECTS}.csv"),
        "Name,Status\nAlpha,Done\n",
    );
    w(&format!("Home {HOME}/Projects {PROJECTS}_all.csv"), &format!(
        "\u{feff}Name,Status,Due,Done,Tags,Tasks\nAlpha,Done,\"October 12, 2026\",Yes,\"a, b\",Write (../Tasks%20{TASKS}/Write%20{WRITE}.md)\nBeta,In progress,\"October 14, 2026 3:00 PM\",No,a,\nGamma,Not started,,No,b,\"Write (../Tasks%20{TASKS}/Write%20{WRITE}.md), Ship (../Tasks%20{TASKS}/Ship%20{SHIP}.md)\"\n"
    ));
    w(
        &format!("Home {HOME}/Projects {PROJECTS}/Alpha {ALPHA}.md"),
        "# Alpha\n\nStatus: Done\nDue: October 12, 2026\n\nAlpha body text\n",
    );
    w(
        &format!("Home {HOME}/Projects {PROJECTS}/Gamma {GAMMA}.md"),
        "# Gamma\n\nStatus: Not started\n",
    );
    w(&format!("Home {HOME}/Tasks {TASKS}.csv"), &format!(
        "Name,Projects\nWrite,\"Alpha (../Projects%20{PROJECTS}/Alpha%20{ALPHA}.md), Gamma (../Projects%20{PROJECTS}/Gamma%20{GAMMA}.md)\"\nShip,Gamma (../Projects%20{PROJECTS}/Gamma%20{GAMMA}.md)\n"
    ));
    w(
        &format!("Home {HOME}/Tasks {TASKS}/Write {WRITE}.md"),
        "# Write\n\nProjects: Alpha, Gamma\n\nDo it\n",
    );
    w(
        &format!("Home {HOME}/Tasks {TASKS}/Ship {SHIP}.md"),
        "# Ship\n\nProjects: Gamma\n",
    );
}

fn pages(conn: &Connection, ws: &str) -> Vec<Page> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM page WHERE workspace_id = ?1 AND deleted_at IS NULL")
        .unwrap()
        .query_map([ws], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    ids.iter()
        .map(|i| repo::page::get(conn, i).unwrap().unwrap())
        .collect()
}

fn find<'a>(all: &'a [Page], title: &str) -> &'a Page {
    all.iter().find(|p| p.title == title).unwrap_or_else(|| {
        panic!(
            "{title} in {:?}",
            all.iter().map(|p| &p.title).collect::<Vec<_>>()
        )
    })
}

fn blocks(conn: &Connection, page: &str) -> Vec<Blk> {
    tree_from_rows(&repo::block::list(conn, page).unwrap())
}

fn all_blocks(b: &[Blk]) -> Vec<Blk> {
    let mut out = Vec::new();
    visit(b, &mut |x| out.push(x.clone()));
    out
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn props(conn: &Connection, db_page: &str) -> Vec<(String, String)> {
    dbs::database_detail_by_page(conn, db_page)
        .unwrap()
        .properties
        .iter()
        .map(|p| (p.name.clone(), p.property_type.clone()))
        .collect()
}

fn check_markdown_import(conn: &Connection, ws: &str, res: &import::ImportResult) {
    let all = pages(conn, ws);
    let home = find(&all, "Home");
    let child = find(&all, "Child");
    let projects = find(&all, "Projects");
    let tasks = find(&all, "Tasks");
    assert_eq!(child.parent_page_id.as_deref(), Some(home.id.as_str()));
    assert_eq!(projects.parent_page_id.as_deref(), Some(home.id.as_str()));
    assert_eq!(tasks.parent_page_id.as_deref(), Some(home.id.as_str()));
    assert_eq!(projects.kind, "database");
    assert_eq!((res.databases, res.records), (2, 5), "{:?}", res.warnings);

    let hb = all_blocks(&blocks(conn, &home.id));
    let callout = hb.iter().find(|b| b.kind == "callout").expect("a callout");
    assert_eq!(callout.tone, "tip");
    assert!(plain_of(&callout.inline).contains("Remember this"));
    assert!(hb.iter().any(|b| b.kind == "todo" && b.checked));
    assert!(hb
        .iter()
        .any(|b| b.kind == "image" && b.media.as_ref().unwrap().attachment.is_some()));
    let mentioned: Vec<String> = hb
        .iter()
        .flat_map(|b| b.inline.iter())
        .filter_map(|i| match i {
            Inline::Mention(id) => Some(id.clone()),
            _ => None,
        })
        .collect();
    assert!(
        mentioned.contains(&child.id),
        "the subpage line is a mention: {mentioned:?}"
    );
    assert!(
        mentioned.contains(&projects.id),
        "the database link is a mention of the database"
    );
    // The child's link back to Home (written with Home's title, as Notion writes a mention) is a
    // mention of the imported page, inside its sentence.
    let cb = blocks(conn, &child.id);
    assert_eq!(
        cb[0].inline,
        vec![
            plain("Back to "),
            Inline::Mention(home.id.clone()),
            plain(" now.")
        ]
    );

    assert_eq!(
        props(conn, &projects.id),
        [
            ("Name", "title"),
            ("Status", "status"),
            ("Due", "date"),
            ("Done", "checkbox"),
            ("Tags", "multi_select"),
            ("Tasks", "relation"),
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    // The mirrored columns became one two-way relation: Tasks has its reverse, named as in Notion.
    assert_eq!(
        props(conn, &tasks.id),
        [("Name", "title"), ("Projects", "relation")].map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(
        count(conn, "SELECT COUNT(*) FROM db_relation"),
        6,
        "3 links, both ways"
    );

    // A row's page is its record's content, without the property lines.
    let alpha = find(&all, "Alpha");
    assert_eq!(alpha.kind, "record");
    let ab = blocks(conn, &alpha.id);
    let text: Vec<String> = ab.iter().map(|b| plain_of(&b.inline)).collect();
    assert_eq!(text, ["Alpha body text"]);
    let detail = dbs::database_detail_by_page(conn, &projects.id).unwrap();
    let due = detail.properties.iter().find(|p| p.name == "Due").unwrap();
    let rows = dbs::load_rows(
        conn,
        &conn
            .prepare("SELECT id FROM db_record WHERE database_id = ?1")
            .unwrap()
            .query_map([&detail.database.id], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
    )
    .unwrap();
    let beta = rows.iter().find(|r| r.title == "Beta").unwrap();
    assert_eq!(beta.values[&due.id]["start"], "2026-10-14T15:00");
    let status = detail
        .properties
        .iter()
        .find(|p| p.name == "Status")
        .unwrap();
    let groups: Vec<(&str, &str)> = status.config["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o["name"].as_str().unwrap(), o["group"].as_str().unwrap()))
        .collect();
    assert!(
        groups.contains(&("Done", "done"))
            && groups.contains(&("In progress", "doing"))
            && groups.contains(&("Not started", "todo"))
    );
}

#[test]
fn a_markdown_and_csv_export_becomes_pages_databases_and_relations() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    markdown_export(&src, "");
    let staged = import::stage_folder(src.clone()).unwrap();
    let pv = import::preview(&staged);
    let origin = pv.origin.as_ref().expect("recognized as Notion");
    assert_eq!(
        (
            origin.kind.as_str(),
            origin.format.as_str(),
            origin.layout.as_str()
        ),
        ("notion", "markdown", "folders")
    );
    assert!(!origin.workspace, "one page and its subpages");
    assert_eq!(origin.name, "Home");
    let projects = pv.entries.iter().find(|e| e.name == "Projects").unwrap();
    let cols = projects.columns.as_ref().unwrap();
    assert_eq!(cols[5].kind, "relation");
    assert_eq!(cols[5].note.as_deref(), Some("Relation to Tasks"));
    assert_eq!(
        cols[5].samples[0], "Write",
        "relation samples are titles, not paths"
    );
    let res = import::apply_checked(
        &mut conn,
        &store,
        &ws,
        &staged,
        &HashMap::new(),
        &Target::Container,
    )
    .unwrap();
    let container = repo::page::get(&conn, &res.page_id).unwrap().unwrap();
    assert!(container.title.starts_with("Imported from Notion"));
    check_markdown_import(&conn, &ws, &res);
}

fn zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in files {
        w.start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn files_of(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    fn walk(root: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in std::fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read(&p).unwrap()));
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn a_split_zip_export_imports_as_a_new_workspace() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    markdown_export(&src, "Private & Shared/");
    write(
        &src,
        "Private & Shared/Notes cccccccccccccccccccccccccccccccc.md",
        "# Notes\n\nloose notes\n",
    );
    let files = files_of(&src);
    let (a, b) = files.split_at(files.len() / 2);
    let outer = zip(&[
        ("Export-1234-Part-1.zip".into(), zip(a)),
        ("Export-1234-Part-2.zip".into(), zip(b)),
    ]);
    let file = temp().join("Export-1234.zip");
    std::fs::write(&file, outer).unwrap();
    let staged = import::stage_files(vec![file]).unwrap();
    let pv = import::preview(&staged);
    let origin = pv.origin.clone().expect("recognized as Notion");
    assert!(origin.workspace, "two top pages: a workspace");
    let temp_dir = staged.temp.as_ref().unwrap().path().to_path_buf();
    assert!(temp_dir.exists());
    let res = import::apply_checked(
        &mut conn,
        &store,
        &ws,
        &staged,
        &HashMap::new(),
        &Target::Workspace {
            name: "From Notion".into(),
        },
    )
    .unwrap();
    let made = res.workspace.clone().expect("a new workspace");
    assert_eq!(made.name, "From Notion");
    let all = pages(&conn, &made.id);
    assert_eq!(
        find(&all, "Home").parent_page_id,
        None,
        "the shared wrapper folder is left out"
    );
    assert_eq!(find(&all, "Notes").parent_page_id, None);
    check_markdown_import(&conn, &made.id, &res);
    assert!(
        pages(&conn, &ws).is_empty(),
        "the current workspace is untouched"
    );
    drop(staged);
    assert!(
        !temp_dir.exists(),
        "the unpacked files are removed with the import"
    );
}

#[test]
fn an_export_without_subpage_folders_is_nested_by_its_links() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    write(
        &src,
        &format!("Home {HOME}.md"),
        &format!("# Home\n\n[Child](Child%20{CHILD}.md)\n"),
    );
    write(
        &src,
        &format!("Child {CHILD}.md"),
        &format!(
            "# Child\n\n[Grandchild](Grandchild%20{ROW}.md)\n\nBack to [Home](Home%20{HOME}.md)\n"
        ),
    );
    write(
        &src,
        &format!("Grandchild {ROW}.md"),
        "# Grandchild\n\ntext\n",
    );
    let staged = import::stage_folder(src).unwrap();
    assert_eq!(staged.origin.as_ref().unwrap().layout, "flat");
    let res = import::apply(&mut conn, &store, &ws, &staged, &HashMap::new()).unwrap();
    let all = pages(&conn, &ws);
    let home = find(&all, "Home");
    let child = find(&all, "Child");
    assert_eq!(home.parent_page_id.as_deref(), Some(res.page_id.as_str()));
    assert_eq!(child.parent_page_id.as_deref(), Some(home.id.as_str()));
    assert_eq!(
        find(&all, "Grandchild").parent_page_id.as_deref(),
        Some(child.id.as_str())
    );
}

fn html_page(icon: &str, title: &str, header_extra: &str, body: &str) -> String {
    format!("<html><head><meta charset=\"utf-8\"/><title>{title}</title><style>body{{}}</style></head><body><article id=\"01234567-89ab-cdef-0123-456789abcdef\" class=\"page sans\"><header>{icon}<h1 class=\"page-title\">{title}</h1>{header_extra}</header><div class=\"page-body\">{body}</div></article></body></html>")
}

#[test]
fn an_html_export_keeps_notion_blocks_and_tables() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    let home_body = format!(
        "<ul class=\"to-do-list\"><li><div class=\"checkbox checkbox-on\"></div> <span class=\"to-do-children-checked\">Done thing</span></li></ul>\
<figure class=\"block-color-gray_background callout\" style=\"white-space:pre-wrap;display:flex\"><div style=\"font-size:1.5em\"><span class=\"icon\">⚠️</span></div><div style=\"width:100%\">Careful <strong>now</strong></div></figure>\
<ul class=\"toggle\"><li><details open=\"\"><summary>More</summary><p>Hidden text</p></details></li></ul>\
<div class=\"column-list\"><div style=\"width:50%\" class=\"column\"><p>Left</p></div><div style=\"width:50%\" class=\"column\"><p>Right</p></div></div>\
<figure class=\"equation\"><style>@import url('katex.css')</style><div class=\"equation-container\"><span class=\"katex-display\"><span class=\"katex\"><span class=\"katex-mathml\"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding=\"application/x-tex\">E=mc^2</annotation></semantics></math></span></span></span></div></figure>\
<figure class=\"link-to-page\"><a href=\"Home%20{HOME}/Child%20{CHILD}.html\"><span class=\"icon\">📄</span>Child</a></figure>\
<pre class=\"code\"><code class=\"language-JavaScript\">let x = 1;</code></pre>\
<figure><a href=\"https://example.com\" class=\"bookmark source\"><div class=\"bookmark-info\"><div class=\"bookmark-text\"><div class=\"bookmark-title\">Example site</div></div></div></a></figure>\
<p>Some <mark class=\"highlight-red\">red</mark> text</p>\
<div id=\"x\" class=\"collection-content\"><h4 class=\"collection-title\">Inline DB</h4><table class=\"collection-content\"><thead><tr><th><span class=\"icon property-icon\"><svg role=\"graphics-symbol\" viewBox=\"0 0 16 16\" class=\"typesSelect\"><path d=\"\"></path></svg></span>Kind</th><th><span class=\"icon property-icon\"><svg class=\"typesTitle\"></svg></span>Name</th><th><svg class=\"typesCheckbox\"></svg>OK</th></tr></thead><tbody><tr id=\"r1\"><td><span class=\"selected-value select-value-color-green\">Green</span></td><td class=\"cell-title\"><a href=\"Home%20{HOME}/Row%20{ROW}.html\">Row one</a></td><td><div class=\"checkbox checkbox-on\"></div></td></tr></tbody></table></div>"
    );
    write(
        &src,
        &format!("Home {HOME}.html"),
        &html_page(
            "<div class=\"page-header-icon undefined\"><span class=\"icon\">🏠</span></div>",
            "Home",
            "",
            &home_body,
        ),
    );
    write(
        &src,
        &format!("Home {HOME}/Child {CHILD}.html"),
        &html_page("", "Child", "", "<p>Child text</p>"),
    );
    write(
        &src,
        &format!("Home {HOME}/Row {ROW}.html"),
        &html_page("", "Row one", "<table class=\"properties\"><tbody><tr class=\"property-row property-row-select\"><th>Kind</th><td><span class=\"selected-value select-value-color-green\">Green</span></td></tr></tbody></table>", "<p>Row body</p>"),
    );
    write(
        &src,
        &format!("Home {HOME}/Tasks {HTASKS}.html"),
        &format!("<html><head><title>Tasks</title></head><body><article id=\"a\" class=\"page sans\"><header><h1 class=\"page-title\">Tasks</h1><p class=\"page-description\"></p></header><table class=\"collection-content\"><thead><tr><th><svg class=\"typesTitle\"></svg>Name</th><th><svg class=\"typesDate\"></svg>Due</th><th><svg class=\"typesRelation\"></svg>Rel</th><th><svg class=\"typesFormula\"></svg>Calc</th></tr></thead><tbody><tr><td class=\"cell-title\"><a href=\"Tasks%20{HTASKS}/T1%20{T1}.html\">T1</a></td><td><time>@October 12, 2026</time></td><td><a href=\"../Home%20{HOME}/Row%20{ROW}.html\">Row one</a></td><td>42</td></tr></tbody></table></article></body></html>"),
    );
    write(
        &src,
        &format!("Home {HOME}/Tasks {HTASKS}/T1 {T1}.html"),
        &html_page("", "T1", "", "<p>T1 body</p>"),
    );
    let staged = import::stage_folder(src).unwrap();
    let pv = import::preview(&staged);
    assert_eq!(pv.origin.as_ref().unwrap().format, "html");
    assert!(
        pv.warnings.iter().any(|w| w.contains("colours")),
        "{:?}",
        pv.warnings
    );
    let tasks_entry = pv.entries.iter().find(|e| e.name == "Tasks").unwrap();
    assert_eq!(
        tasks_entry.columns.as_ref().unwrap()[3].note.as_deref(),
        Some("Formula results, as values")
    );
    let res = import::apply(&mut conn, &store, &ws, &staged, &HashMap::new()).unwrap();
    let all = pages(&conn, &ws);
    let home = find(&all, "Home");
    assert_eq!(home.icon.as_deref(), Some("🏠"));
    let child = find(&all, "Child");
    let inline_db = find(&all, "Inline DB");
    assert_eq!(inline_db.parent_page_id.as_deref(), Some(home.id.as_str()));
    let hb = blocks(&conn, &home.id);
    let flat = all_blocks(&hb);
    let kinds: Vec<&str> = hb.iter().map(|b| b.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "todo",
            "callout",
            "toggle",
            "columns",
            "equation",
            "paragraph",
            "code",
            "paragraph",
            "paragraph",
            "database_view"
        ],
        "{:?}",
        hb.iter()
            .map(|b| (&b.kind, plain_of(&b.inline)))
            .collect::<Vec<_>>()
    );
    assert!(hb[0].checked);
    assert_eq!(plain_of(&hb[0].inline), "Done thing");
    assert_eq!(hb[1].tone, "warning");
    assert_eq!(plain_of(&hb[1].inline), "Careful now");
    assert!(hb[2].open && plain_of(&hb[2].children[0].inline) == "Hidden text");
    assert_eq!(hb[3].children.len(), 2);
    assert_eq!(hb[4].latex, "E=mc^2");
    assert_eq!(hb[5].inline, vec![Inline::Mention(child.id.clone())]);
    assert_eq!(hb[6].language.as_deref(), Some("javascript"));
    assert!(
        matches!(&hb[7].inline[0], Inline::Text { text, marks } if text == "Example site" && marks.contains(&Mark::Link("https://example.com".into())))
    );
    assert_eq!(plain_of(&hb[8].inline), "Some red text");
    assert_eq!(
        hb[9].target.as_deref(),
        Some(inline_db.id.as_str()),
        "the inline table shows the database"
    );
    assert!(flat.iter().all(|b| b.kind != "simple_table"));

    assert_eq!(
        props(&conn, &inline_db.id),
        [("Name", "title"), ("Kind", "select"), ("OK", "checkbox")]
            .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    let detail = dbs::database_detail_by_page(&conn, &inline_db.id).unwrap();
    assert_eq!(detail.properties[1].config["options"][0]["color"], "green");
    let row = find(&all, "Row one");
    assert_eq!(row.kind, "record");
    assert_eq!(
        blocks(&conn, &row.id)
            .iter()
            .map(|b| plain_of(&b.inline))
            .collect::<Vec<_>>(),
        ["Row body"]
    );

    let tasks = find(&all, "Tasks");
    assert_eq!(
        props(&conn, &tasks.id),
        [
            ("Name", "title"),
            ("Due", "date"),
            ("Calc", "text"),
            ("Rel", "relation")
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM db_relation"), 1);
    let t1 = find(&all, "T1");
    assert_eq!(
        blocks(&conn, &t1.id)
            .iter()
            .map(|b| plain_of(&b.inline))
            .collect::<Vec<_>>(),
        ["T1 body"]
    );
    assert_eq!(res.databases, 2);
}

#[test]
fn a_pdf_becomes_a_page_that_shows_it() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    let f = src.join(format!("Quarterly review {HOME}.pdf"));
    std::fs::write(&f, b"%PDF-1.4 fake").unwrap();
    let staged = import::stage_files(vec![f]).unwrap();
    let pv = import::preview(&staged);
    assert_eq!((pv.pages, pv.attachments), (1, 1));
    let res = import::apply(&mut conn, &store, &ws, &staged, &HashMap::new()).unwrap();
    let all = pages(&conn, &ws);
    let page = all
        .iter()
        .find(|p| p.parent_page_id.as_deref() == Some(res.page_id.as_str()))
        .unwrap();
    assert_eq!(page.title, "Quarterly review");
    let b = blocks(&conn, &page.id);
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].kind, "pdf");
    assert!(b[0].media.as_ref().unwrap().attachment.is_some());
}

#[test]
fn importing_under_a_page_and_into_a_record_is_checked() {
    let (mut conn, ws, store) = workspace();
    let src = temp();
    write(&src, &format!("Note {HOME}.md"), "# Note\n\nhello\n");
    let host = services::page::create(
        &mut conn,
        crate::domain::PageCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            title: Some("Host".into()),
            icon: None,
        },
    )
    .unwrap();
    let staged = import::stage_folder(src).unwrap();
    let res = import::apply_checked(
        &mut conn,
        &store,
        &ws,
        &staged,
        &HashMap::new(),
        &Target::Page {
            page_id: host.id.clone(),
        },
    )
    .unwrap();
    assert_eq!(res.page_id, host.id);
    let all = pages(&conn, &ws);
    assert_eq!(
        find(&all, "Note").parent_page_id.as_deref(),
        Some(host.id.as_str())
    );
    let missing = Target::Page { page_id: new_id() };
    assert!(
        import::apply_checked(&mut conn, &store, &ws, &staged, &HashMap::new(), &missing).is_err()
    );
}

#[test]
fn ordinary_files_are_not_mistaken_for_notion() {
    let src = temp();
    write(&src, "Plan.md", "# Plan\n\n[x](Other.md)\n");
    write(&src, "Other.md", "# Other\n");
    let staged = import::stage_folder(src).unwrap();
    assert!(staged.origin.is_none());
}

// ---------------------------------------------------------------------------------------------
// export → import
// ---------------------------------------------------------------------------------------------

use super::super::export::{self, ExportOptions, Sink};
use crate::databases::{DatabaseCreate, PropertyCreate, RecordCreate, SetValue};
use serde_json::json;

/// A page holding two related databases, records with content, and a mention.
fn seeded() -> (Connection, String, PathBuf, String) {
    let (mut conn, ws, store) = workspace();
    let plan = services::page::create(
        &mut conn,
        crate::domain::PageCreate {
            workspace_id: ws.clone(),
            parent_page_id: None,
            title: Some("Plan".into()),
            icon: Some("🗺️".into()),
        },
    )
    .unwrap();
    let projects = dbs::create_database(
        &mut conn,
        DatabaseCreate {
            workspace_id: ws.clone(),
            parent_page_id: Some(plan.id.clone()),
            title: Some("Projects".into()),
        },
    )
    .unwrap();
    let tasks = dbs::create_database(
        &mut conn,
        DatabaseCreate {
            workspace_id: ws.clone(),
            parent_page_id: Some(plan.id.clone()),
            title: Some("Tasks".into()),
        },
    )
    .unwrap();
    // Start from the title alone, like an import does.
    for d in [&projects, &tasks] {
        for p in d.properties.iter().filter(|p| p.property_type != "title") {
            dbs::delete_property(&mut conn, &p.id).unwrap();
        }
    }
    let prop = |conn: &mut Connection,
                db: &str,
                name: &str,
                t: &str,
                config: Option<serde_json::Value>| {
        dbs::add_property(
            conn,
            PropertyCreate {
                database_id: db.into(),
                name: name.into(),
                property_type: t.into(),
                config,
            },
        )
        .unwrap()
    };
    let stage = prop(
        &mut conn,
        &projects.database.id,
        "Stage",
        "select",
        Some(
            json!({"options":[{"id":"o1","name":"Live","color":"green"},{"id":"o2","name":"Draft","color":"violet"}]}),
        ),
    );
    let due = prop(&mut conn, &projects.database.id, "Due", "date", None);
    let done = prop(&mut conn, &projects.database.id, "Done", "checkbox", None);
    let rel = prop(
        &mut conn,
        &tasks.database.id,
        "Project",
        "relation",
        Some(
            json!({"targetDatabaseId": projects.database.id, "twoWay": true, "reverseName": "Tasks"}),
        ),
    );
    let record = |conn: &mut Connection, db: &str, title: &str| {
        dbs::create_record(
            conn,
            RecordCreate {
                database_id: db.into(),
                title: Some(title.into()),
                values: Default::default(),
                template_id: None,
            },
        )
        .unwrap()
    };
    let set = |conn: &mut Connection, r: &str, p: &str, v: serde_json::Value| {
        dbs::set_value(
            conn,
            SetValue {
                record_id: r.into(),
                property_id: p.into(),
                value: v,
            },
        )
        .unwrap();
    };
    let alpha = record(&mut conn, &projects.database.id, "Alpha");
    let beta = record(&mut conn, &projects.database.id, "Beta");
    set(&mut conn, &alpha.id, &stage.id, json!("o1"));
    set(&mut conn, &beta.id, &stage.id, json!("o2"));
    set(
        &mut conn,
        &alpha.id,
        &due.id,
        json!({"start":"2026-10-12T15:00"}),
    );
    set(&mut conn, &alpha.id, &done.id, json!(true));
    let write = record(&mut conn, &tasks.database.id, "Write");
    set(&mut conn, &write.id, &rel.id, json!([alpha.id, beta.id]));
    let body = |conn: &mut Connection, page: &str, blocks: Vec<Blk>| {
        services::block::apply_batch(
            conn,
            crate::domain::BlockBatch {
                page_id: page.into(),
                upserts: flatten(&blocks),
                delete_ids: vec![],
            },
        )
        .unwrap();
    };
    body(
        &mut conn,
        &alpha.page_id,
        vec![Blk::with_inline("paragraph", vec![plain("Alpha notes")])],
    );
    let mut tip = Blk::with_inline("callout", vec![plain("Plan ahead")]);
    tip.tone = "warning".into();
    body(
        &mut conn,
        &plan.id,
        vec![
            tip,
            Blk::with_inline(
                "paragraph",
                vec![plain("See "), Inline::Mention(alpha.page_id.clone())],
            ),
        ],
    );
    (conn, ws, store, plan.id)
}

fn check_round_trip(conn: &Connection, ws: &str, icons: bool) {
    let all = pages(conn, ws);
    let plan = find(&all, "Plan");
    if icons {
        // Notion's Markdown has no page icons; its HTML does.
        assert_eq!(plan.icon.as_deref(), Some("🗺️"));
    }
    let projects = find(&all, "Projects");
    let tasks = find(&all, "Tasks");
    assert_eq!(projects.parent_page_id.as_deref(), Some(plan.id.as_str()));
    assert_eq!(
        props(conn, &projects.id),
        [
            ("Name", "title"),
            ("Stage", "select"),
            ("Due", "date"),
            ("Done", "checkbox"),
            ("Tasks", "relation")
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(
        props(conn, &tasks.id),
        [("Name", "title"), ("Project", "relation")].map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(
        count(conn, "SELECT COUNT(*) FROM db_relation"),
        4,
        "two links, both ways"
    );
    let alpha = find(&all, "Alpha");
    assert_eq!(
        blocks(conn, &alpha.id)
            .iter()
            .map(|b| plain_of(&b.inline))
            .collect::<Vec<_>>(),
        ["Alpha notes"]
    );
    let detail = dbs::database_detail_by_page(conn, &projects.id).unwrap();
    let stage = detail
        .properties
        .iter()
        .find(|p| p.name == "Stage")
        .unwrap();
    let colors: Vec<&str> = stage.config["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["color"].as_str().unwrap())
        .collect();
    if icons {
        // Option colours, like icons, are only in Notion's HTML.
        assert!(
            colors.contains(&"green") && colors.contains(&"violet"),
            "{colors:?}"
        );
    }
    let due = detail.properties.iter().find(|p| p.name == "Due").unwrap();
    let row: RecordRowLite = conn
        .query_row(
            "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE p.id = ?1",
            [&alpha.id],
            |r| Ok(RecordRowLite(r.get(0)?)),
        )
        .unwrap();
    let rows = dbs::load_rows(conn, &[row.0]).unwrap();
    assert_eq!(rows[0].values[&due.id]["start"], "2026-10-12T15:00");
    let pb = blocks(conn, &plan.id);
    assert_eq!(pb[0].kind, "callout");
    assert_eq!(pb[0].tone, "warning");
    assert!(
        pb[1].inline.contains(&Inline::Mention(alpha.id.clone())),
        "the mention leads to the imported record: {:?}",
        pb[1].inline
    );
}

struct RecordRowLite(String);

fn export_zip(conn: &Connection, store: &Path, page: &str, format: &str) -> PathBuf {
    let file = temp().join("export.zip");
    let mut sink = Sink::zip(&file).unwrap();
    export::export(
        conn,
        store,
        page,
        &ExportOptions::of(format),
        &mut sink,
        None,
    )
    .unwrap();
    sink.finish().unwrap();
    file
}

#[test]
fn a_markdown_export_imports_back_with_its_databases_and_relations() {
    let (conn, _ws, store, plan) = seeded();
    let file = export_zip(&conn, &store, &plan, "markdown");
    let (mut conn2, ws2, store2) = workspace();
    let staged = import::stage_files(vec![file]).unwrap();
    assert_eq!(
        staged.origin.as_ref().unwrap().kind,
        "notion",
        "our export reads as a Notion export"
    );
    import::apply(&mut conn2, &store2, &ws2, &staged, &HashMap::new()).unwrap();
    check_round_trip(&conn2, &ws2, false);
}

#[test]
fn an_html_export_imports_back_with_its_databases_and_relations() {
    let (conn, _ws, store, plan) = seeded();
    let file = export_zip(&conn, &store, &plan, "html");
    let (mut conn2, ws2, store2) = workspace();
    let staged = import::stage_files(vec![file]).unwrap();
    assert_eq!(staged.origin.as_ref().unwrap().format, "html");
    import::apply(&mut conn2, &store2, &ws2, &staged, &HashMap::new()).unwrap();
    check_round_trip(&conn2, &ws2, true);
}

#[test]
fn export_options_shape_the_files() {
    let (conn, _ws, store, plan) = seeded();
    let names = |opts: ExportOptions| -> Vec<String> {
        let dir = temp();
        let mut sink = Sink::Dir(dir.clone());
        export::export(&conn, &store, &plan, &opts, &mut sink, None).unwrap();
        let mut out: Vec<String> = Vec::new();
        fn walk(root: &Path, d: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    out.push(
                        p.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        walk(&dir, &dir, &mut out);
        out.sort();
        out
    };
    let all = names(ExportOptions::of("markdown"));
    assert_eq!(all.len(), 6, "{all:?}");
    assert!(all
        .iter()
        .any(|n| n.starts_with("Plan ") && n.contains("/Projects ") && n.ends_with(".csv")));
    assert!(all
        .iter()
        .any(|n| n.contains("/Projects ") && n.contains("/Alpha ") && n.ends_with(".md")));
    let flat = names(ExportOptions {
        folders: false,
        ..ExportOptions::of("markdown")
    });
    assert_eq!(flat.len(), 6);
    assert!(flat.iter().all(|n| !n.contains('/')), "{flat:?}");
    let alone = names(ExportOptions {
        include_subpages: false,
        ..ExportOptions::of("markdown")
    });
    assert_eq!(alone.len(), 1, "{alone:?}");
    // The CSV is what Notion writes.
    let dir = temp();
    let mut sink = Sink::Dir(dir.clone());
    export::export(
        &conn,
        &store,
        &plan,
        &ExportOptions::of("markdown"),
        &mut sink,
        None,
    )
    .unwrap();
    let csv_path = all
        .iter()
        .find(|n| n.contains("Projects") && n.ends_with(".csv"))
        .unwrap();
    let csv = std::fs::read_to_string(dir.join(csv_path)).unwrap();
    assert!(csv.contains("\"October 12, 2026 3:00 PM\""), "{csv}");
    assert!(csv.contains(",Yes,") && csv.contains(",No,"), "{csv}");
    let tasks_csv = all
        .iter()
        .find(|n| n.contains("Tasks") && n.ends_with(".csv"))
        .unwrap();
    let t = std::fs::read_to_string(dir.join(tasks_csv)).unwrap();
    assert!(
        t.contains("Alpha (Projects%20") && t.contains(".md)"),
        "relations name the related row's file: {t}"
    );
    // A record's page lists its properties first.
    let alpha = all.iter().find(|n| n.contains("/Alpha ")).unwrap();
    let md = std::fs::read_to_string(dir.join(alpha)).unwrap();
    assert!(
        md.starts_with("# Alpha\n\nStage: Live\nDue: October 12, 2026 3:00 PM\nDone: Yes\n"),
        "{md}"
    );
}
