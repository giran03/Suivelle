//! Property tests for everything that reads untrusted input: imported Markdown, HTML, CSV and
//! archives, formulas typed by the user, and embed settings. Each must reject bad input with an
//! error, never panic.

use proptest::prelude::*;

/// Strings built from the characters a parser treats specially, so cases reach deep paths.
fn shaped(alphabet: &'static [&'static str]) -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(alphabet), 0..160).prop_map(|parts| parts.concat())
}

const MARKDOWN: &[&str] = &[
    "#", " ", "\n", "-", "*", "_", "`", "```", ">", "[", "]", "(", ")", "!", "|", "1.", "- [ ]",
    "- [x]", "\\", "$$", "~~", "==", "<", ">", "a", "é", "\t", "---", "    ", ":::", "^",
];
const HTML: &[&str] = &[
    "<",
    ">",
    "</",
    "/>",
    "p",
    "div",
    "a",
    "img",
    "table",
    "tr",
    "td",
    "th",
    "ul",
    "ol",
    "li",
    "h1",
    "pre",
    "code",
    "details",
    "summary",
    "figure",
    " href=\"",
    " src=\"",
    "\"",
    "=",
    " ",
    "&amp;",
    "&#",
    ";",
    "x",
    "<!--",
    "-->",
    "<script>",
    "</script>",
    "data-suivelle-embed='{",
    "}'",
    "\n",
];
const FORMULA: &[&str] = &[
    "prop(\"", "\")", "(", ")", "+", "-", "*", "/", "%", "==", "!=", "<", ">", "&&", "||", "!",
    "if", "concat", "round", "now()", "dateAdd", "length", ",", "\"", "1", "0.5", "1e309", "true",
    "x", " ", "Title", "?", ":", "[", "]",
];
const CSV: &[&str] = &[
    "a",
    ",",
    "\"",
    "\n",
    "\r\n",
    ";",
    "\t",
    "1",
    "2026-10-13",
    " ",
    "é",
];

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn markdown_import_never_panics(src in prop_oneof![any::<String>(), shaped(MARKDOWN)]) {
        let parsed = crate::transfer::markdown::parse(&src);
        let ctx = crate::transfer::markdown::Ctx { asset: &|_| None, title: &|_| None, link: &|_| None };
        let _ = crate::transfer::markdown::render(&parsed.blocks, &ctx);
    }

    #[test]
    fn html_import_never_panics(src in prop_oneof![any::<String>(), shaped(HTML)]) {
        let _ = crate::transfer::html::parse(&src);
    }

    #[test]
    fn formulas_never_panic(src in prop_oneof![any::<String>(), shaped(FORMULA)]) {
        let _ = crate::databases::formula::parse(&src);
        let _ = crate::databases::formula::check(&src, &Default::default(), true);
        let _ = crate::databases::formula::parse_when(&src);
    }

    #[test]
    fn csv_import_never_panics(src in prop_oneof![any::<String>(), shaped(CSV)]) {
        let dir = std::env::temp_dir().join(format!("tako-fuzz-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("table.csv");
        std::fs::write(&path, &src).unwrap();
        let _ = crate::transfer::import::stage_files(vec![path]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn embed_settings_never_panic(src in any::<String>(), width in any::<f64>(), url in shaped(&["https://", "http://", "a", ".", "/", ":", "@", "%", "javascript:", "\u{0}", "443"])) {
        let _ = crate::domain::embed::validate_block("embed", &src);
        let value = serde_json::json!({ "url": url, "width": width, "height": width, "align": src, "mode": "embed" });
        let _ = crate::domain::embed::validate(&value);
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, failure_persistence: None, ..ProptestConfig::default() })]

    /// Archives come from other computers: truncated, corrupted or hostile zips must be refused.
    #[test]
    fn archive_import_refuses_damaged_zips(bytes in prop::collection::vec(any::<u8>(), 0..4096), cut in any::<prop::sample::Index>(), flip in any::<prop::sample::Index>()) {
        let dir = std::env::temp_dir().join(format!("tako-fuzz-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        // A real zip with damage, so the reader gets past the signature checks.
        let mut zip = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zip));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("manifest.json", opts).unwrap();
            std::io::Write::write_all(&mut w, br#"{"format":"suivelle-archive","version":2}"#).unwrap();
            w.start_file("pages/a.md", opts).unwrap();
            std::io::Write::write_all(&mut w, &bytes).unwrap();
            w.finish().unwrap();
        }
        let len = zip.len();
        zip.truncate(len - cut.index(len / 2));
        if !zip.is_empty() {
            let at = flip.index(zip.len());
            zip[at] ^= 0x5a;
        }
        for (name, data) in [("damaged.zip", &zip), ("random.zip", &bytes)] {
            let path = dir.join(name);
            std::fs::write(&path, data).unwrap();
            let _ = crate::transfer::import::stage_archive(&path);
            let _ = crate::transfer::import::stage_workspace_archive(&path);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
