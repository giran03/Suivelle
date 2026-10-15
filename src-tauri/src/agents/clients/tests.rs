use super::*;
use crate::agents::TOOL_GROUPS;
use crate::database::open_in_memory;
use crate::domain::WorkspaceCreate;
use crate::services;

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("suivelle-clients-{label}-{}", crate::domain::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A fake computer: a home folder, an app-data folder, a connector to install, and an empty PATH.
fn fake_env(label: &str) -> Env {
    let root = scratch(label);
    let home = root.join("home");
    let config = root.join("appdata");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let bundled = root.join("dist").join(bridge::NAME);
    std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
    std::fs::write(&bundled, b"connector v1").unwrap();
    Env {
        home,
        config,
        path: vec![root.join("path")],
        os: std::env::consts::OS,
        cli: false,
        credentials: false,
        bin_dir: root.join("bin"),
        bundled: Some(bundled),
        app: Some(root.join("Suivelle.exe")),
    }
}

fn db() -> (Connection, String) {
    let mut conn = open_in_memory().unwrap();
    let ws = services::workspace::create(&mut conn, WorkspaceCreate { name: "Lab".into(), ..Default::default() }).unwrap().id;
    (conn, ws)
}

fn input(ws: &str) -> ConnectInput {
    ConnectInput {
        agent: Some(AgentInput {
            workspace_ids: vec![ws.into()],
            tools: TOOL_GROUPS.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn entry() -> Entry {
    Entry {
        command: r"C:\Users\me\AppData\Local\Suivelle\bin\suivelle-mcp.exe".into(),
        args: vec![],
        env: BTreeMap::from([("SUIVELLE_AGENT_TOKEN".into(), "sva_x".into())]),
    }
}

fn standard_shape() -> Shape {
    serde_json::from_value(serde_json::json!({ "command": "command", "args": "args", "env": "env" })).unwrap()
}

// ---------------------------------------------------------------------------------------------
// JSON / JSONC
// ---------------------------------------------------------------------------------------------

#[test]
fn catalogue_is_valid_and_complete() {
    let c = catalogue();
    assert!(c.version >= 1);
    for id in ["claude-code", "claude-desktop", "codex", "antigravity", "gemini-cli", "cursor", "vscode", "windsurf", "opencode", "zed"] {
        let client = client(id).unwrap();
        assert!(matches!(client.config.format.as_str(), "json" | "toml"), "{id}");
        assert!(!client.config.container.is_empty(), "{id}");
        for os in ["windows", "macos", "linux"] {
            let env = Env { os, ..fake_env("cat") };
            assert!(!env.paths(&client.config.paths).is_empty(), "{id} has a config path on {os}");
        }
    }
}

#[test]
fn json_edits_touch_only_the_suivelle_entry() {
    let container = strs(&["mcpServers"]);
    let fields = standard_shape().fields(&entry());
    let cases = [
        // Other servers, two-space indent.
        "{\n  \"mcpServers\": {\n    \"rea\": {\n      \"command\": \"rea\",\n      \"args\": []\n    }\n  },\n  \"theme\": \"dark\"\n}\n",
        // CRLF, tabs, comments, a trailing comma and a URL containing //.
        "{\r\n\t// my servers\r\n\t\"mcpServers\": {\r\n\t\t\"docs\": { \"url\": \"https://example.com/mcp\" }, // remote\r\n\t},\r\n\t/* end */\r\n}\r\n",
        // No servers section yet.
        "{\n    \"preferences\": { \"x\": 1 }\n}\n",
        // Empty servers object.
        "{ \"mcpServers\": {} }",
    ];
    for original in cases {
        let (added, created) = jsonc::set(original, &container, SERVER, &fields).unwrap();
        let got = jsonc::get(&added, &container, SERVER).unwrap().expect("entry present");
        assert_eq!(standard_shape().read(&got), entry(), "{original}");
        // Everything that was there is still there.
        let before = jsonc::to_value(&jsonc::parse(original).unwrap().unwrap());
        let mut after = jsonc::to_value(&jsonc::parse(&added).unwrap().unwrap());
        after["mcpServers"].as_object_mut().unwrap().remove(SERVER);
        if created {
            after.as_object_mut().unwrap().remove("mcpServers");
        }
        assert_eq!(before, after, "{original}");
        // Comments survive.
        for c in ["// my servers", "// remote", "/* end */"] {
            assert_eq!(original.contains(c), added.contains(c));
        }
        // Updating in place keeps a single entry.
        let mut e2 = entry();
        e2.command = "D:/other/suivelle-mcp.exe".into();
        let (updated, _) = jsonc::set(&added, &container, SERVER, &standard_shape().fields(&e2)).unwrap();
        assert_eq!(updated.matches("\"suivelle\"").count(), 1);
        // Removing restores the original byte for byte (apart from `{}` spacing).
        let removed = jsonc::unset(&added, &container, SERVER, created).unwrap();
        if original.contains("{}") {
            assert_eq!(jsonc::to_value(&jsonc::parse(&removed).unwrap().unwrap()), before);
        } else {
            assert_eq!(removed, original);
        }
    }
    // Line endings follow the file.
    let (crlf, _) = jsonc::set(cases[1], &container, SERVER, &fields).unwrap();
    assert!(!crlf.replace("\r\n", "").contains('\n'));
}

#[test]
fn json_edge_cases() {
    let container = strs(&["mcpServers"]);
    let fields = standard_shape().fields(&entry());
    // An empty file becomes a fresh document.
    let (fresh, created) = jsonc::set("", &container, SERVER, &fields).unwrap();
    assert!(created && fresh.starts_with("{\n  \"mcpServers\": {\n    \"suivelle\": {"));
    // Nested containers (none here, but the walk creates every level).
    let (deep, _) = jsonc::set("{}", &strs(&["a", "b"]), SERVER, &fields).unwrap();
    assert!(jsonc::get(&deep, &strs(&["a", "b"]), SERVER).unwrap().is_some());
    // Broken files and non-objects are refused, not rewritten.
    assert!(jsonc::set("{ \"a\": ", &container, SERVER, &fields).is_err());
    assert!(jsonc::set("[1, 2]", &container, SERVER, &fields).is_err());
    assert!(jsonc::set("{ \"mcpServers\": [] }", &container, SERVER, &fields).is_err());
    // Escapes and unicode keys parse.
    let v = jsonc::get("{\"mcpServers\":{\"suivelle\":{\"command\":\"C:\\\\x\\u00e9\"}}}", &container, SERVER).unwrap().unwrap();
    assert_eq!(v["command"], "C:\\xé");
    // Single-line objects.
    let (one, _) = jsonc::set("{\"mcpServers\":{\"a\":1}}", &container, SERVER, &fields).unwrap();
    assert_eq!(jsonc::unset(&one, &container, SERVER, false).unwrap(), "{\"mcpServers\":{\"a\":1}}");
}

#[test]
fn entry_shapes_follow_each_app() {
    let e = Entry { command: "/bin/suivelle-mcp".into(), args: strs(&["--credential", "abc"]), env: BTreeMap::new() };
    let vscode = &client("vscode").unwrap().config.entry;
    let v: Map<String, Value> = vscode.fields(&e).into_iter().collect();
    assert_eq!(Value::Object(v.clone()), serde_json::json!({ "type": "stdio", "command": "/bin/suivelle-mcp", "args": ["--credential", "abc"] }));
    assert_eq!(vscode.read(&Value::Object(v)), e);
    let open = &client("opencode").unwrap().config.entry;
    let fields = open.fields(&entry());
    assert_eq!(fields[0].0, "type");
    let v: Map<String, Value> = fields.into_iter().collect();
    assert_eq!(v["command"], serde_json::json!([entry().command]));
    assert_eq!(v["environment"]["SUIVELLE_AGENT_TOKEN"], "sva_x");
    assert_eq!(v["enabled"], true);
    assert_eq!(open.read(&Value::Object(v)), entry());
}

// ---------------------------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------------------------

#[test]
fn toml_edits_touch_only_the_suivelle_tables() {
    let container = strs(&["mcp_servers"]);
    let original = "model = \"gpt-5\" # default\n\n[mcp_servers.rea]\ncommand = \"rea\"\nargs = [\"--x\"]\n\n[mcp_servers.rea.env]\nKEY = \"v\"\n\n[profiles.fast]\nprompt = \"\"\"\n[not.a.table]\n\"\"\"\n";
    assert_eq!(toml::get(original, &container).unwrap(), None);
    let added = toml::set(original, &container, &entry()).unwrap();
    assert!(added.starts_with(original));
    assert_eq!(toml::get(&added, &container).unwrap(), Some(entry()));
    assert!(added.contains("command = 'C:\\Users\\me\\AppData\\Local\\Suivelle\\bin\\suivelle-mcp.exe'"));
    // Writing again replaces rather than duplicates.
    let again = toml::set(&added, &container, &entry()).unwrap();
    assert_eq!(again, added);
    assert_eq!(toml::unset(&added, &container).unwrap(), original);
    // What the Codex CLI writes (inline env, double quotes) reads the same.
    let cli = format!("{original}\n[mcp_servers.suivelle]\ncommand = \"C:\\\\x\\\\suivelle-mcp.exe\"\nargs = [\n  \"--credential\",\n  \"id\",\n]\nenv = {{ A = \"1\" }}\nstartup_timeout_sec = 20\n");
    let got = toml::get(&cli, &container).unwrap().unwrap();
    assert_eq!(got.command, "C:\\x\\suivelle-mcp.exe");
    assert_eq!(got.args, strs(&["--credential", "id"]));
    assert_eq!(got.env.get("A").map(String::as_str), Some("1"));
    // CRLF files stay CRLF.
    let crlf = original.replace('\n', "\r\n");
    let added = toml::set(&crlf, &container, &entry()).unwrap();
    assert!(!added.replace("\r\n", "").contains('\n'));
    assert_eq!(toml::unset(&added, &container).unwrap(), crlf);
    // Layouts Suivelle does not edit are refused.
    assert!(toml::set("mcp_servers.suivelle.command = \"x\"\n", &container, &entry()).is_err());
    assert!(toml::set("[mcp_servers]\nsuivelle = { command = \"x\" }\n", &container, &entry()).is_err());
}

// ---------------------------------------------------------------------------------------------
// detection, connect, status, disconnect
// ---------------------------------------------------------------------------------------------

#[test]
fn finds_installed_apps_by_their_folders_and_path() {
    let (conn, _) = db();
    let env = fake_env("scan");
    std::fs::create_dir_all(env.home.join(".cursor")).unwrap();
    std::fs::create_dir_all(env.home.join(".codex")).unwrap();
    std::fs::create_dir_all(&env.path[0]).unwrap();
    std::fs::write(env.path[0].join(if cfg!(windows) { "claude.exe" } else { "claude" }), b"").unwrap();
    let scan = scan(&conn, &env).unwrap();
    let ids: Vec<&str> = scan.clients.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["claude-code", "codex", "cursor"]);
    assert!(scan.clients.iter().all(|c| c.status == "not_connected"));
    assert_eq!(scan.clients[0].found, ["claude on PATH"]);
    assert!(scan.clients[2].config_paths[0].ends_with("mcp.json"));
}

#[test]
fn connect_status_and_disconnect_round_trip() {
    let (mut conn, ws) = db();
    let env = fake_env("connect");
    let cursor = env.home.join(".cursor").join("mcp.json");
    std::fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    let original = "{\n  // keep me\n  \"mcpServers\": {\n    \"rea\": { \"command\": \"rea\" }\n  }\n}\n";
    std::fs::write(&cursor, original).unwrap();

    let r = connect(&mut conn, &env, "cursor", input(&ws)).unwrap();
    assert_eq!(r.method, "file");
    assert_eq!(r.client.status, "waiting");
    assert_eq!(r.client.agent_name.as_deref(), Some("Cursor"));
    assert_eq!(r.backups.len(), 1);
    assert_eq!(std::fs::read_to_string(&r.backups[0]).unwrap(), original);
    let written = std::fs::read_to_string(&cursor).unwrap();
    assert!(written.contains("// keep me") && written.contains("\"rea\""));
    // The connector was installed in the stable folder, with the app beside it.
    let installed = env.bin_dir.join(bridge::NAME);
    assert!(written.contains(&serde_json::to_string(&installed.display().to_string()).unwrap()));
    assert!(env.bin_dir.join("app-path").is_file());
    // The token works.
    let token = jsonc::get(&written, &strs(&["mcpServers"]), SERVER).unwrap().unwrap()["env"]["SUIVELLE_AGENT_TOKEN"].as_str().unwrap().to_string();
    let agent = crate::agents::authenticate(&conn, &token).unwrap().expect("token signs in");
    assert_eq!(agent.workspace_ids, vec![ws.clone()]);
    // Once the agent has connected, the app reads as connected.
    let status = scan(&conn, &env).unwrap().clients.into_iter().find(|c| c.id == "cursor").unwrap();
    assert_eq!(status.status, "connected");

    // A new token from the agent card leaves the config behind.
    crate::agents::rotate_token(&conn, &agent.id).unwrap();
    assert_eq!(status_of(&conn, &env, client("cursor").unwrap()).unwrap().status, "out_of_date");
    // Repair rewrites it with a working token and keeps the same agent.
    let repaired = repair(&mut conn, &env, "cursor").unwrap();
    assert_eq!(repaired.client.agent_id.as_deref(), Some(agent.id.as_str()));
    assert_eq!(repaired.client.status, "waiting");

    // Hand edits are noticed.
    let edited = std::fs::read_to_string(&cursor).unwrap().replace("\"args\": []", "\"args\": [\"--verbose\"]");
    std::fs::write(&cursor, &edited).unwrap();
    assert_eq!(status_of(&conn, &env, client("cursor").unwrap()).unwrap().status, "edited");

    // Disconnect removes only the entry and revokes the token; the agent stays.
    let d = disconnect(&mut conn, &env, "cursor").unwrap();
    assert!(d.notes.is_empty());
    assert_eq!(d.client.status, "not_connected");
    assert_eq!(std::fs::read_to_string(&cursor).unwrap(), original);
    assert!(crate::agents::get(&conn, &agent.id).unwrap().token_hint.is_none());
}

#[test]
fn connect_creates_missing_files_and_respects_foreign_entries() {
    let (mut conn, ws) = db();
    let env = fake_env("create");
    // Windsurf installed, but no config yet.
    std::fs::create_dir_all(env.home.join(".codeium").join("windsurf")).unwrap();
    let r = connect(&mut conn, &env, "windsurf", input(&ws)).unwrap();
    let path = env.home.join(".codeium").join("windsurf").join("mcp_config.json");
    assert!(r.backups.is_empty());
    assert!(jsonc::get(&std::fs::read_to_string(&path).unwrap(), &strs(&["mcpServers"]), SERVER).unwrap().is_some());
    disconnect(&mut conn, &env, "windsurf").unwrap();
    // The section Suivelle created goes again.
    assert_eq!(jsonc::to_value(&jsonc::parse(&std::fs::read_to_string(&path).unwrap()).unwrap().unwrap()), serde_json::json!({}));

    // A suivelle server someone else set up is not replaced without asking.
    let gemini = env.home.join(".gemini").join("settings.json");
    std::fs::create_dir_all(gemini.parent().unwrap()).unwrap();
    std::fs::write(&gemini, "{ \"mcpServers\": { \"suivelle\": { \"command\": \"old\" } } }").unwrap();
    assert_eq!(status_of(&conn, &env, client("gemini-cli").unwrap()).unwrap().status, "foreign");
    let refused = connect(&mut conn, &env, "gemini-cli", input(&ws)).unwrap_err().to_string();
    assert!(refused.contains("already has a server"), "{refused}");
    // Refusing created no agent.
    assert!(crate::agents::list(&conn).unwrap().iter().all(|a| a.name != "Gemini CLI"));
    let replaced = connect(&mut conn, &env, "gemini-cli", ConnectInput { replace: true, ..input(&ws) }).unwrap();
    assert_eq!(replaced.client.status, "waiting");
    // Names stay unique: a second agent for the same name gets a number.
    assert_eq!(unique_name(&conn, "Gemini CLI").unwrap(), "Gemini CLI 2");
}

#[test]
fn antigravity_writes_every_config_it_reads() {
    let (mut conn, ws) = db();
    let env = fake_env("agy");
    let a = env.home.join(".gemini").join("antigravity").join("mcp_config.json");
    let b = env.home.join(".gemini").join("config").join("mcp_config.json");
    for p in [&a, &b] {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "{\r\n  \"mcpServers\": {}\r\n}").unwrap();
    }
    let r = connect(&mut conn, &env, "antigravity", input(&ws)).unwrap();
    assert_eq!(r.changed.len(), 2);
    for p in [&a, &b] {
        assert!(jsonc::get(&std::fs::read_to_string(p).unwrap(), &strs(&["mcpServers"]), SERVER).unwrap().is_some());
    }
}

#[test]
fn codex_toml_and_manual_connections() {
    let (mut conn, ws) = db();
    let env = fake_env("codex");
    let path = env.home.join(".codex").join("config.toml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = "model = \"gpt-5\"\n\n[mcp_servers.rea]\ncommand = \"rea\"\n";
    std::fs::write(&path, original).unwrap();
    let r = connect(&mut conn, &env, "codex", input(&ws)).unwrap();
    assert_eq!(r.method, "file");
    assert!(toml::get(&std::fs::read_to_string(&path).unwrap(), &strs(&["mcp_servers"])).unwrap().is_some());
    disconnect(&mut conn, &env, "codex").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

    // Manual: nothing is written; the snippet is returned once.
    let m = connect(&mut conn, &env, "codex", ConnectInput { manual: true, ..input(&ws) }).unwrap();
    assert_eq!(m.method, "manual");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    let snippet = m.snippet.unwrap();
    assert!(snippet.starts_with("[mcp_servers.suivelle]"));
    assert_eq!(m.client.status, "removed");
    // Once pasted, it reads as connected-and-waiting.
    std::fs::write(&path, format!("{original}\n{snippet}")).unwrap();
    assert_eq!(status_of(&conn, &env, client("codex").unwrap()).unwrap().status, "waiting");
}

#[test]
fn a_missing_connector_creates_nothing() {
    let (mut conn, ws) = db();
    let env = Env { bundled: None, ..fake_env("nobridge") };
    std::fs::create_dir_all(env.home.join(".cursor")).unwrap();
    let err = connect(&mut conn, &env, "cursor", input(&ws)).unwrap_err().to_string();
    assert!(err.contains("connector is missing"), "{err}");
    assert!(crate::agents::list(&conn).unwrap().is_empty());
}

#[test]
fn bridge_install_replaces_only_when_changed() {
    let dir = scratch("bridge");
    let src = dir.join("src.exe");
    std::fs::write(&src, b"v1").unwrap();
    let dest = bridge::install(&src, &dir.join("bin"), Some(Path::new("C:/Suivelle.exe"))).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"v1");
    assert_eq!(std::fs::read_to_string(dir.join("bin").join("app-path")).unwrap(), "C:/Suivelle.exe");
    std::fs::write(&src, b"v2").unwrap();
    assert!(!bridge::current(&src, &dest));
    bridge::install(&src, &dir.join("bin"), None).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"v2");
}

/// The app's own command line is used when it exists; when it does not do its job, the file is
/// edited instead.
#[cfg(windows)]
#[test]
fn uses_the_apps_command_line_and_falls_back_to_the_file() {
    let (mut conn, ws) = db();
    let mut env = fake_env("cli");
    env.cli = true;
    std::fs::create_dir_all(&env.path[0]).unwrap();
    let log = env.path[0].join("calls.txt");
    // A stand-in `codex` that records its arguments and changes nothing.
    std::fs::write(env.path[0].join("codex.cmd"), format!("@echo %*>>\"{}\"\r\n@exit /b 0\r\n", log.display())).unwrap();
    std::fs::create_dir_all(env.home.join(".codex")).unwrap();
    let r = connect(&mut conn, &env, "codex", input(&ws)).unwrap();
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("mcp remove suivelle"), "{calls}");
    assert!(calls.contains("mcp add suivelle --env ") && calls.contains("SUIVELLE_AGENT_TOKEN=sva_"), "{calls}");
    assert_eq!(r.method, "file");
    assert_eq!(r.notes.len(), 1);
    assert!(toml::get(&std::fs::read_to_string(env.home.join(".codex").join("config.toml")).unwrap(), &strs(&["mcp_servers"])).unwrap().is_some());
}

#[cfg(windows)]
#[test]
fn credential_store_round_trip() {
    let id = format!("test-{}", crate::domain::new_id());
    secret::store(&id, "sva_secret").unwrap();
    assert_eq!(secret::read(&id).as_deref(), Some("sva_secret"));
    secret::delete(&id);
    assert_eq!(secret::read(&id), None);
}

// ---------------------------------------------------------------------------------------------
// subagents
// ---------------------------------------------------------------------------------------------

#[test]
fn imports_claude_code_subagents() {
    let (mut conn, ws) = db();
    let project = scratch("subagents");
    let dir = project.join(".claude").join("agents");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("reviewer.md"),
        "---\r\nname: code-reviewer\r\ndescription: \"Reviews diffs.\\nBe strict.\"\r\nmodel: sonnet\r\ntools: Read, Grep\r\n---\r\n\r\n# Role\r\n\r\nReview every change.\r\n",
    )
    .unwrap();
    std::fs::write(dir.join("folded.md"), "---\nname: writer\ndescription: >\n  Writes docs\n  for people.\n---\nBody\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
    let found = subagents::scan(&conn, &project).unwrap();
    assert_eq!(found.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["code-reviewer", "writer"]);
    assert_eq!(found[0].description, "Reviews diffs.\nBe strict.");
    assert_eq!(found[1].description, "Writes docs for people.");

    let paths: Vec<String> = found.iter().map(|s| s.path.clone()).collect();
    let out = subagents::import(&mut conn, &paths, std::slice::from_ref(&ws), Some("propose".into())).unwrap();
    assert!(out.iter().all(|i| i.error.is_none()), "{out:?}");
    let agent = crate::agents::get(&conn, out[0].agent_id.as_deref().unwrap()).unwrap();
    assert_eq!((agent.name.as_str(), agent.model.as_str(), agent.role.as_str()), ("code-reviewer", "sonnet", "Reviews diffs. Be strict."));
    let body = crate::agents::content::body_markdown(&conn, agent.instructions_page_id.as_deref().unwrap()).unwrap();
    assert!(body.contains("Review every change."), "{body}");
    // Importing again reports the clash instead of duplicating.
    let again = subagents::import(&mut conn, &paths[..1], &[ws], None).unwrap();
    assert!(again[0].error.as_deref().unwrap().contains("already exists"));
    // Files outside a .claude/agents folder are refused.
    assert!(subagents::import(&mut conn, &[project.join("x.md").display().to_string()], &[crate::domain::new_id()], None).unwrap()[0].error.is_some());
}

// ---------------------------------------------------------------------------------------------
// session-start lines and command files
// ---------------------------------------------------------------------------------------------

#[test]
fn start_block_is_added_once_and_removed_cleanly() {
    let cases = ["", "# Rules\n- Be kind.\n", "# Rules\r\n- Be kind.\r\n"];
    for original in cases {
        let added = extras::add_block(original);
        assert_eq!(extras::block_state(&added), extras::BlockState::Current, "{original:?}");
        assert_eq!(extras::add_block(&added), added, "adding again changes nothing");
        assert_eq!(added.contains("\r\n"), original.contains("\r\n"));
        assert_eq!(extras::remove_block(&added), original, "{original:?}");
    }
    // Lines added by hand are wrapped, not doubled.
    let by_hand = format!("# graphify\nUse it.\n\n{}\n\n# Other\nx\n", crate::agents::commands::START_LINES);
    assert_eq!(extras::block_state(&by_hand), extras::BlockState::Unmarked);
    let wrapped = extras::add_block(&by_hand);
    assert_eq!(wrapped.matches("call suivelle whoami").count(), 1);
    assert_eq!(wrapped.matches("# Suivelle context management").count(), 1);
    assert!(wrapped.starts_with("# graphify\nUse it.\n\n<!-- suivelle:start -->") && wrapped.ends_with("<!-- suivelle:end -->\n\n# Other\nx\n"), "{wrapped}");
    // A block edited by hand is reported and rewritten.
    let edited = wrapped.replace("say so once", "shout");
    assert_eq!(extras::block_state(&edited), extras::BlockState::Edited);
    assert_eq!(extras::add_block(&edited), wrapped);
}

#[test]
fn command_files_follow_each_app() {
    let spec = |id: &str| client(id).unwrap().commands.clone().unwrap();
    let wrap = crate::agents::commands::find("wrap-up").unwrap();
    assert_eq!(extras::typed(&spec("claude-code"), "init"), "/suivelle_init");
    assert_eq!(extras::typed(&spec("codex"), "init"), "/prompts:suivelle_init");
    assert_eq!(extras::file_name(&spec("gemini-cli"), "sync"), "suivelle_sync.toml");
    assert_eq!(extras::file_name(&spec("vscode"), "sync"), "suivelle_sync.prompt.md");
    let md = extras::stub(&spec("claude-code"), wrap);
    assert!(md.starts_with("---\ndescription: \"Suivelle: ") && md.contains("name \"wrap-up\" and arguments \"$ARGUMENTS\""), "{md}");
    assert!(extras::stub(&spec("gemini-cli"), wrap).contains("\"{{args}}\""));
    assert!(!extras::stub(&spec("cursor"), wrap).starts_with("---"));
    assert!(extras::stub(&spec("vscode"), wrap).contains("mode: agent"));
    for id in ["claude-code", "codex", "gemini-cli", "cursor", "vscode", "opencode"] {
        assert!(extras::is_ours(&extras::stub(&spec(id), wrap)), "{id}");
    }
    // Apps without command files still say where the session-start lines go.
    for id in ["claude-desktop", "antigravity", "windsurf", "zed"] {
        assert!(client(id).unwrap().commands.is_none() && client(id).unwrap().instructions.is_some(), "{id}");
    }
}

#[test]
fn connect_adds_start_lines_and_commands_and_disconnect_takes_them_out() {
    let env = fake_env("extras");
    let (mut conn, ws) = db();
    let claude_md = env.home.join(".claude").join("CLAUDE.md");
    std::fs::create_dir_all(claude_md.parent().unwrap()).unwrap();
    let original = "# Mine\nKeep this.\n";
    std::fs::write(&claude_md, original).unwrap();
    // Someone's own command with the same name is left alone.
    let commands = env.home.join(".claude").join("commands");
    std::fs::create_dir_all(&commands).unwrap();
    std::fs::write(commands.join("suivelle_sync.md"), "my own sync").unwrap();

    let out = connect(&mut conn, &env, "claude-code", ConnectInput { instructions: true, commands: true, ..input(&ws) }).unwrap();
    let text = std::fs::read_to_string(&claude_md).unwrap();
    assert!(text.starts_with(original) && text.contains("<!-- suivelle:start -->"), "{text}");
    assert!(out.backups.iter().any(|b| b.ends_with("CLAUDE.md.suivelle-backup")));
    for name in ["init", "setup", "wrap-up"] {
        assert!(extras::is_ours(&std::fs::read_to_string(commands.join(format!("suivelle_{name}.md"))).unwrap()), "{name}");
    }
    assert_eq!(std::fs::read_to_string(commands.join("suivelle_sync.md")).unwrap(), "my own sync");
    assert!(out.notes.iter().any(|n| n.contains("Left") && n.contains("suivelle_sync.md")), "{:?}", out.notes);
    let s = &out.client;
    assert!(s.instructions_added && s.commands_added && !s.extras_pending, "{s:?}");
    assert_eq!(s.commands[0], "/suivelle_init");
    assert_eq!(s.status, "waiting");

    // Apps connected before these existed offer them, and Repair adds both.
    conn.execute("UPDATE agent_client SET want_instructions = NULL, want_commands = NULL, instructions_path = NULL, commands_json = '[]'", []).unwrap();
    let old = scan(&conn, &env).unwrap().clients.into_iter().find(|c| c.id == "claude-code").unwrap();
    assert!(old.extras_pending && old.status == "waiting", "{old:?}");
    assert!(!repair(&mut conn, &env, "claude-code").unwrap().client.extras_pending);

    // A removed command file shows up, and Repair writes it again.
    std::fs::remove_file(commands.join("suivelle_init.md")).unwrap();
    let status = scan(&conn, &env).unwrap().clients.into_iter().find(|c| c.id == "claude-code").unwrap();
    assert_eq!(status.status, "edited", "{:?}", status.detail);
    repair(&mut conn, &env, "claude-code").unwrap();
    assert!(commands.join("suivelle_init.md").is_file());

    disconnect(&mut conn, &env, "claude-code").unwrap();
    assert_eq!(std::fs::read_to_string(&claude_md).unwrap(), original);
    assert!(!commands.join("suivelle_init.md").exists());
    assert_eq!(std::fs::read_to_string(commands.join("suivelle_sync.md")).unwrap(), "my own sync");
}

#[test]
fn shared_instructions_and_opting_out() {
    let env = fake_env("shared");
    let (mut conn, ws) = db();
    let gemini_md = env.home.join(".gemini").join("GEMINI.md");
    connect(&mut conn, &env, "gemini-cli", ConnectInput { instructions: true, commands: true, ..input(&ws) }).unwrap();
    connect(&mut conn, &env, "antigravity", ConnectInput { instructions: true, commands: true, ..input(&ws) }).unwrap();
    let text = std::fs::read_to_string(&gemini_md).unwrap();
    assert_eq!(text.matches("<!-- suivelle:start -->").count(), 1);
    assert!(env.home.join(".gemini/commands/suivelle_wrap-up.toml").is_file());
    // Antigravity still reads the lines after Gemini CLI disconnects.
    disconnect(&mut conn, &env, "gemini-cli").unwrap();
    assert_eq!(std::fs::read_to_string(&gemini_md).unwrap(), text);
    assert!(!env.home.join(".gemini/commands/suivelle_wrap-up.toml").exists());
    disconnect(&mut conn, &env, "antigravity").unwrap();
    assert!(!std::fs::read_to_string(&gemini_md).unwrap().contains("suivelle"));

    // Unticked: only the MCP entry.
    let out = connect(&mut conn, &env, "codex", ConnectInput { instructions: false, commands: false, ..input(&ws) }).unwrap();
    assert!(!env.home.join(".codex/AGENTS.md").exists() && !env.home.join(".codex/prompts").exists());
    assert!(!out.client.instructions_added && !out.client.commands_added);
    assert_eq!(out.client.commands[0], "/prompts:suivelle_init", "still says what it would add");
    // Apps without a file say where to paste the lines.
    let cursor = connect(&mut conn, &env, "cursor", ConnectInput { instructions: true, commands: true, ..input(&ws) }).unwrap();
    assert!(cursor.client.instructions_place.as_deref().unwrap().contains("User Rules"));
    assert!(cursor.notes.iter().any(|n| n.contains("paste the session-start lines")));
}

/// Reads (never writes) this computer's real agent app configs:
/// `cargo test --lib scans_this_computer -- --ignored --nocapture`.
#[test]
#[ignore]
fn scans_this_computer() {
    let (conn, _) = db();
    let env = Env::system().unwrap();
    for c in scan(&conn, &env).unwrap().clients {
        println!("{:<15} {:<14} {:<5} {:?} {}", c.name, c.status, c.method, c.config_paths, c.detail.as_deref().unwrap_or(""));
        // Dry run in memory: add the entry, read it back, take it out again.
        let spec = client(&c.id).unwrap();
        for path in targets(&env, spec).into_iter().filter(|p| p.is_file()) {
            let text = read_file(&path).unwrap().text;
            if read_entry(spec, &text).ok().flatten().is_some() {
                println!("    already has a suivelle entry: {}", path.display());
                continue;
            }
            let (added, created) = write_entry(spec, &text, &entry()).unwrap();
            assert_eq!(read_entry(spec, &added).unwrap(), Some(entry()), "{}", path.display());
            assert_eq!(remove_entry(spec, &added, created).unwrap(), text, "{}", path.display());
            println!("    dry run ok: {}", path.display());
        }
        if let Some(Instructions::File(path)) = extras::instructions_of(&env, spec).filter(|i| matches!(i, Instructions::File(p) if p.is_file())) {
            let text = read_file(&path).unwrap().text;
            let added = extras::add_block(&text);
            println!("    instructions {:?}: {}", extras::block_state(&text), path.display());
            match extras::block_state(&text) {
                extras::BlockState::Missing => assert_eq!(extras::remove_block(&added), text, "{}", path.display()),
                _ => assert_eq!(added.matches("call suivelle whoami").count(), 1, "{}", path.display()),
            }
        }
    }
}
