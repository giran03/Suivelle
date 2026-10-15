use super::content::{self, WriteMode};
use super::ops::{self, Op};
use super::*;
use crate::database::open_in_memory;
use crate::domain::{BlockBatch, BlockUpsert, PageCreate, WorkspaceCreate, BLOCK_SCHEMA_VERSION};
use crate::services;
use serde_json::{json, Map, Value};
use std::time::Duration;

fn workspace(conn: &mut Connection, name: &str) -> String {
    services::workspace::create(
        conn,
        WorkspaceCreate {
            name: name.into(),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn page(conn: &mut Connection, ws: &str, title: &str, md: &str) -> Page {
    let p = services::page::create(
        conn,
        PageCreate {
            workspace_id: ws.into(),
            parent_page_id: None,
            title: Some(title.into()),
            icon: None,
        },
    )
    .unwrap();
    if !md.is_empty() {
        let tx = conn.transaction().unwrap();
        content::write_markdown(&tx, &p, md, WriteMode::Replace).unwrap();
        tx.commit().unwrap();
    }
    repo::page::get(conn, &p.id).unwrap().unwrap()
}

fn agent(conn: &mut Connection, name: &str, ws: &str, mode: &str) -> Agent {
    create(
        conn,
        AgentInput {
            name: name.into(),
            role: "Keeps notes tidy".into(),
            mode: Some(mode.into()),
            workspace_ids: vec![ws.into()],
            tools: TOOL_GROUPS.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        },
    )
    .unwrap()
}

fn call(conn: &mut Connection, a: &Agent, tool: &str, args: Value) -> AppResult<tools::Output> {
    let a = get(conn, &a.id).unwrap();
    tools::call(conn, &a, tool, &args, false)
}

fn body(conn: &Connection, id: &str) -> String {
    content::body_markdown(conn, id).unwrap()
}

#[test]
fn markdown_round_trip_keeps_unsupported_blocks_and_identities() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Notes");
    let p = page(
        &mut conn,
        &ws,
        "Plan",
        "# Goals\n\nShip the mirror.\n\n- [ ] write tests",
    );
    // An image block Markdown cannot carry.
    let image_id = crate::domain::new_id();
    let tx = conn.transaction().unwrap();
    services::block::apply_batch_in(
        &tx,
        &BlockBatch {
            page_id: p.id.clone(),
            upserts: vec![BlockUpsert {
                id: image_id.clone(),
                parent_block_id: None,
                block_type: "image".into(),
                position: 10.0,
                data_json: json!({"attachment": {"id": "a", "hash": "h", "name": "diagram.png", "mime": "image/png", "size": 1}}).to_string(),
                schema_version: BLOCK_SCHEMA_VERSION,
            }],
            delete_ids: vec![],
        },
    )
    .unwrap();
    tx.commit().unwrap();
    let md = body(&conn, &p.id);
    assert!(md.contains("# Goals"), "{md}");
    assert!(md.contains("- [ ] write tests"), "{md}");
    let marker = md
        .lines()
        .find(|l| l.starts_with("<!-- suivelle:keep "))
        .expect("marker");
    assert!(
        marker.contains(&image_id) && marker.contains("diagram.png"),
        "{marker}"
    );

    let heading_id = repo::block::list(&conn, &p.id)
        .unwrap()
        .into_iter()
        .find(|b| b.block_type == "heading_1")
        .unwrap()
        .id;
    // Rewrite the paragraph, keep the marker and heading as they were.
    let edited = md.replace("Ship the mirror.", "Ship the mirror and the bridge.");
    let tx = conn.transaction().unwrap();
    let page = repo::page::get(&tx, &p.id).unwrap().unwrap();
    content::write_markdown(&tx, &page, &edited, WriteMode::Replace).unwrap();
    tx.commit().unwrap();
    let rows = repo::block::list(&conn, &p.id).unwrap();
    assert!(
        rows.iter().any(|b| b.id == image_id),
        "image kept by its marker"
    );
    assert!(
        rows.iter().any(|b| b.id == heading_id),
        "unchanged block keeps its id"
    );
    assert!(body(&conn, &p.id).contains("and the bridge"));

    // Leaving the marker out removes the block.
    let without: String = edited
        .lines()
        .filter(|l| !l.starts_with("<!-- suivelle:keep"))
        .collect::<Vec<_>>()
        .join("\n");
    let tx = conn.transaction().unwrap();
    content::write_markdown(&tx, &page, &without, WriteMode::Replace).unwrap();
    tx.commit().unwrap();
    assert!(!repo::block::list(&conn, &p.id)
        .unwrap()
        .iter()
        .any(|b| b.id == image_id));
}

#[test]
fn mentions_round_trip_and_wikilinks_resolve_when_the_page_appears() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Notes");
    let target = page(&mut conn, &ws, "Release checklist", "");
    let src = page(
        &mut conn,
        &ws,
        "Plan",
        "See [[Release checklist]] and [[Roadmap]].",
    );
    let md = body(&conn, &src.id);
    assert!(
        md.contains(&format!(
            "[Release checklist](suivelle://page/{})",
            target.id
        )),
        "{md}"
    );
    assert!(md.contains("[[Roadmap]]"), "unresolved stays text: {md}");
    let refs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page_reference WHERE source_page_id = ?1",
            [&src.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(refs, 1);
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page_link_unresolved WHERE source_page_id = ?1",
            [&src.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 1);

    // Creating the page links the waiting wikilink.
    let roadmap = page(&mut conn, &ws, "roadmap", "");
    let refs: Vec<String> = conn
        .prepare("SELECT target_page_id FROM page_reference WHERE source_page_id = ?1")
        .unwrap()
        .query_map([&src.id], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(refs.contains(&roadmap.id), "{refs:?}");
    let pending: i64 = conn
        .query_row("SELECT COUNT(*) FROM page_link_unresolved", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(pending, 0);

    // Writing the rendered Markdown back keeps mentions as mentions.
    let md = body(&conn, &src.id);
    let tx = conn.transaction().unwrap();
    let p = repo::page::get(&tx, &src.id).unwrap().unwrap();
    assert_eq!(
        content::write_markdown(&tx, &p, &md, WriteMode::Replace).unwrap(),
        0,
        "a no-op rewrite changes nothing"
    );
    tx.commit().unwrap();

    // Aliases resolve too, and a labelled wikilink becomes a link.
    let tx = conn.transaction().unwrap();
    content::set_aliases(&tx, &target, &["ship list".into()]).unwrap();
    tx.commit().unwrap();
    let other = page(&mut conn, &ws, "Other", "Use the [[Ship List|checklist]].");
    let refs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page_reference WHERE source_page_id = ?1 AND target_page_id = ?2",
            params![other.id, target.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(refs, 1);
}

#[test]
fn wikilinks_in_code_are_examples_not_links() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Notes");
    let src = page(
        &mut conn,
        &ws,
        "Guide",
        "Write `[[Title]]` to link, as in [[Glossary]].\n\n```\n[[Snippet]]\n```",
    );
    let pending: Vec<String> = conn
        .prepare("SELECT target_text FROM page_link_unresolved WHERE source_page_id = ?1")
        .unwrap()
        .query_map([&src.id], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        pending,
        vec!["Glossary".to_string()],
        "only the link outside code waits"
    );

    // Pages with those titles appearing later leave the code alone.
    page(&mut conn, &ws, "Title", "");
    page(&mut conn, &ws, "Snippet", "");
    let refs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page_reference WHERE source_page_id = ?1",
            [&src.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(refs, 0);
    let md = body(&conn, &src.id);
    assert!(
        md.contains("`[[Title]]`") && md.contains("[[Snippet]]"),
        "{md}"
    );
}

#[test]
fn tokens_authenticate_and_scope_hides_other_workspaces() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let private = workspace(&mut conn, "Private");
    let secret = page(&mut conn, &private, "Diary", "private");
    let a = agent(&mut conn, "Scout", &ws, "propose");
    assert!(
        a.instructions_page_id.is_some(),
        "instructions page in the hub"
    );
    let token = rotate_token(&conn, &a.id).unwrap();
    assert_eq!(authenticate(&conn, &token).unwrap().unwrap().id, a.id);
    assert!(authenticate(&conn, "sva_nope").unwrap().is_none());
    let err = call(&mut conn, &a, "page_read", json!({"page_id": secret.id})).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)));
    let found = call(&mut conn, &a, "search", json!({"query": "private"})).unwrap();
    assert_eq!(found.text, "No matches.");
    revoke_token(&conn, &a.id).unwrap();
    assert!(authenticate(&conn, &token).unwrap().is_none());
    // Paused agents cannot connect.
    let token = rotate_token(&conn, &a.id).unwrap();
    update(
        &mut conn,
        &a.id,
        AgentInput {
            name: a.name.clone(),
            status: Some("paused".into()),
            workspace_ids: a.workspace_ids.clone(),
            tools: a.tools.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(authenticate(&conn, &token).unwrap().is_none());
}

#[test]
fn tool_groups_and_read_only_are_enforced() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let a = create(
        &mut conn,
        AgentInput {
            name: "Reader".into(),
            workspace_ids: vec![ws.clone()],
            tools: vec!["pages".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert!(tools::definitions(&a)
        .iter()
        .all(|t| !t["name"].as_str().unwrap().starts_with("memory")));
    let err = tools::call(&mut conn, &a, "memory_recall", &json!({}), false).unwrap_err();
    assert!(err.to_string().contains("not allowed"));
    let err = tools::call(&mut conn, &a, "page_create", &json!({"title": "X"}), true).unwrap_err();
    assert!(err.to_string().contains("read-only"));
}

#[test]
fn propose_mode_waits_for_review_and_changesets_revert() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let p = page(&mut conn, &ws, "Spec", "Old text.");
    let a = agent(&mut conn, "Editor", &ws, "propose");
    let read = call(&mut conn, &a, "page_read", json!({"page_id": p.id}))
        .unwrap()
        .text;
    let hash = read
        .lines()
        .find_map(|l| l.strip_prefix("hash: "))
        .unwrap()
        .to_string();
    let out = call(
        &mut conn,
        &a,
        "page_update",
        json!({"page_id": p.id, "markdown": "New text.", "base_hash": hash}),
    )
    .unwrap();
    let (pid, status) = out.proposal.unwrap();
    assert_eq!(status, "pending");
    assert_eq!(body(&conn, &p.id), "Old text.");
    let info = ops::detail(&conn, &pid).unwrap();
    assert_eq!(info.ops[0].before.as_deref(), Some("Old text."));
    assert_eq!(info.ops[0].after.as_deref(), Some("New text."));

    let applied = ops::approve(&mut conn, &pid, None, None).unwrap();
    assert_eq!(body(&conn, &p.id), "New text.");
    let cs = changeset::list(&conn, Some(&a.id), None, 10).unwrap();
    assert_eq!(cs[0].pages[0].op, "updated");
    changeset::revert(&mut conn, &applied.changeset_id.unwrap()).unwrap();
    assert_eq!(body(&conn, &p.id), "Old text.");

    // A stale base hash is refused up front.
    let err = call(
        &mut conn,
        &a,
        "page_update",
        json!({"page_id": p.id, "markdown": "x", "base_hash": "0000000000000000"}),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("changed since it was read"),
        "{err}"
    );

    // A proposal whose page changed before approval fails with the reason.
    let read = call(&mut conn, &a, "page_read", json!({"page_id": p.id}))
        .unwrap()
        .text;
    let hash = read
        .lines()
        .find_map(|l| l.strip_prefix("hash: "))
        .unwrap()
        .to_string();
    let pid = call(
        &mut conn,
        &a,
        "page_update",
        json!({"page_id": p.id, "markdown": "Agent text.", "base_hash": hash}),
    )
    .unwrap()
    .proposal
    .unwrap()
    .0;
    let tx = conn.transaction().unwrap();
    let fresh = repo::page::get(&tx, &p.id).unwrap().unwrap();
    content::write_markdown(&tx, &fresh, "User text.", WriteMode::Replace).unwrap();
    tx.commit().unwrap();
    assert!(ops::approve(&mut conn, &pid, None, None).is_err());
    assert_eq!(ops::detail(&conn, &pid).unwrap().status, "failed");
    assert_eq!(body(&conn, &p.id), "User text.");

    // Rejections carry the note back to the agent.
    let pid = call(&mut conn, &a, "page_create", json!({"title": "Draft"}))
        .unwrap()
        .proposal
        .unwrap()
        .0;
    ops::reject(&conn, &pid, Some("Not needed".into())).unwrap();
    let status = call(&mut conn, &a, "proposal_status", json!({}))
        .unwrap()
        .text;
    assert!(status.contains("Not needed"), "{status}");
}

#[test]
fn write_and_auto_modes() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let mine = page(&mut conn, &ws, "Mine", "User page.");
    let w = agent(&mut conn, "Writer", &ws, "write");
    let out = call(
        &mut conn,
        &w,
        "page_update",
        json!({"page_id": mine.id, "markdown": "Changed."}),
    )
    .unwrap();
    assert_eq!(out.proposal.unwrap().1, "applied");
    assert_eq!(body(&conn, &mine.id), "Changed.");

    let auto = agent(&mut conn, "Auto", &ws, "auto");
    let created = call(
        &mut conn,
        &auto,
        "page_create",
        json!({"title": "Report", "markdown": "Findings."}),
    )
    .unwrap();
    assert_eq!(created.proposal.as_ref().unwrap().1, "applied");
    let report: (String, Option<String>, String) = conn
        .query_row("SELECT p.id, p.created_by, parent.title FROM page p JOIN page parent ON parent.id = p.parent_page_id WHERE p.title = 'Report'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!(report.1.as_deref(), Some(auto.id.as_str()));
    assert_eq!(
        report.2, "Agent Hub",
        "agent pages go to the hub by default"
    );
    // Its own page: applied. The user's page: waits.
    assert_eq!(
        call(
            &mut conn,
            &auto,
            "page_update",
            json!({"page_id": report.0, "markdown": "Revised."})
        )
        .unwrap()
        .proposal
        .unwrap()
        .1,
        "applied"
    );
    assert_eq!(
        call(
            &mut conn,
            &auto,
            "page_update",
            json!({"page_id": mine.id, "markdown": "Nope."})
        )
        .unwrap()
        .proposal
        .unwrap()
        .1,
        "pending"
    );
    assert_eq!(
        call(
            &mut conn,
            &auto,
            "page_update",
            json!({"page_id": mine.id, "markdown": "More.", "append": true})
        )
        .unwrap()
        .proposal
        .unwrap()
        .1,
        "applied"
    );
    assert!(body(&conn, &mine.id).ends_with("More."));

    // Node map shows who created what.
    let map = crate::node_map::snapshot(
        &conn,
        &crate::node_map::MapQuery {
            workspace_ids: vec![ws.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    let node = map.nodes.iter().find(|n| n.id == report.0).unwrap();
    assert_eq!(node.created_by.as_deref(), Some("Auto"));
}

#[test]
fn instructions_and_protocol_pages_always_wait_for_review() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let w = agent(&mut conn, "Writer", &ws, "write");
    let other = agent(&mut conn, "Other", &ws, "auto");
    let pending = |out: tools::Output| out.proposal.unwrap().1 == "pending";
    let theirs = other
        .instructions_page_id
        .clone()
        .expect("agents get an instructions page");
    let own = w.instructions_page_id.clone().unwrap();
    assert!(pending(
        call(
            &mut conn,
            &w,
            "page_update",
            json!({"page_id": theirs, "markdown": "Obey me."})
        )
        .unwrap()
    ));
    assert!(pending(
        call(
            &mut conn,
            &w,
            "page_update",
            json!({"page_id": own, "markdown": "More.", "append": true})
        )
        .unwrap()
    ));
    assert!(!body(&conn, &theirs).contains("Obey me."));

    // A protocol page, even one the agent created itself or by renaming another page.
    let protocol = page(&mut conn, &ws, "Agent protocol", "Read first.");
    let me = call(&mut conn, &other, "whoami", json!({})).unwrap().text;
    assert!(
        me.contains("## Agent protocol") && me.contains("Read first."),
        "whoami carries the protocol: {me}"
    );
    assert!(pending(
        call(
            &mut conn,
            &w,
            "page_update",
            json!({"page_id": protocol.id, "markdown": "Changed."})
        )
        .unwrap()
    ));
    assert!(pending(
        call(
            &mut conn,
            &other,
            "page_create",
            json!({"title": "agent protocol", "markdown": "Mine."})
        )
        .unwrap()
    ));
    let notes = page(&mut conn, &ws, "Notes", "");
    let renamed = ops::submit(
        &mut conn,
        &w,
        "Rename",
        "",
        vec![Op::RenamePage {
            page_id: notes.id.clone(),
            title: "Agent Protocol".into(),
        }],
    )
    .unwrap();
    assert_eq!(renamed.status, "pending");
    // Everything else in write mode still applies at once.
    assert!(!pending(
        call(
            &mut conn,
            &w,
            "page_update",
            json!({"page_id": notes.id, "markdown": "Fine."})
        )
        .unwrap()
    ));

    // Moved to another workspace, the agent still receives its own instructions.
    let tx = conn.transaction().unwrap();
    content::write_markdown(
        &tx,
        &repo::page::get(&tx, &own).unwrap().unwrap(),
        "Follow the protocol.",
        WriteMode::Replace,
    )
    .unwrap();
    tx.commit().unwrap();
    let elsewhere = workspace(&mut conn, "Elsewhere");
    let input = AgentInput {
        name: w.name.clone(),
        role: w.role.clone(),
        mode: Some("write".into()),
        workspace_ids: vec![elsewhere],
        tools: w.tools.clone(),
        ..Default::default()
    };
    let moved = update(&mut conn, &w.id, input).unwrap();
    let page = repo::page::get(&conn, moved.instructions_page_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        page.workspace_id, moved.workspace_ids[0],
        "the instructions follow the agent"
    );
    assert_ne!(page.id, own);
    assert!(call(&mut conn, &w, "whoami", json!({}))
        .unwrap()
        .text
        .contains("Follow the protocol."));

    // A trashed instructions page is restored, keeping its text.
    conn.execute(
        "UPDATE page SET deleted_at = '2026-10-14T00:00:00Z' WHERE id = ?1",
        [&page.id],
    )
    .unwrap();
    assert_eq!(repair_instructions(&mut conn).unwrap(), 1);
    assert_eq!(repair_instructions(&mut conn).unwrap(), 0);
    let restored = get(&conn, &w.id).unwrap().instructions_page_id.unwrap();
    assert_ne!(restored, page.id);
    assert!(body(&conn, &restored).contains("Follow the protocol."));
}

#[test]
fn commands_come_from_suivelle_and_pages_can_override_them() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let a = agent(&mut conn, "Claude", &ws, "write");
    // Every agent has the tool, whatever its tool groups.
    let bare = create(
        &mut conn,
        AgentInput {
            name: "Bare".into(),
            workspace_ids: vec![ws.clone()],
            tools: vec!["memory".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let init = call(&mut conn, &bare, "command", json!({"name": "init"}))
        .unwrap()
        .text;
    assert!(
        init.contains("<!-- suivelle:start -->") && init.contains("call suivelle whoami"),
        "{init}"
    );
    assert!(!init.contains("{instructions}") && !init.contains("{start_lines}"));
    assert!(call(&mut conn, &a, "command", json!({"name": "protocol"}))
        .unwrap()
        .text
        .starts_with("# Suivelle MCP Protocol"));
    assert!(call(&mut conn, &a, "command", json!({"name": "deploy"})).is_err());
    // Unfilled placeholders from apps that pass arguments literally are ignored.
    let sync = call(
        &mut conn,
        &a,
        "command",
        json!({"name": "sync", "arguments": "$ARGUMENTS"}),
    )
    .unwrap()
    .text;
    assert!(!sync.contains("The user added"));

    // A page replaces the built-in steps; agents can only change it through review.
    page(
        &mut conn,
        &ws,
        "Agent command: sync",
        "Only update the Overview page.",
    );
    let sync = call(
        &mut conn,
        &a,
        "command",
        json!({"name": "sync", "arguments": "docs"}),
    )
    .unwrap()
    .text;
    assert_eq!(
        sync,
        "Only update the Overview page.\n\nThe user added: docs"
    );
    let made = call(
        &mut conn,
        &a,
        "page_create",
        json!({"title": "agent command: wrap-up", "markdown": "Do nothing."}),
    )
    .unwrap();
    assert_eq!(made.proposal.unwrap().1, "pending");
}

#[test]
fn decisions_reach_agents_that_asked_through_a_follow_up_task() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let mine = page(&mut conn, &ws, "Plan", "Draft.");
    let a = agent(&mut conn, "Claude", &ws, "propose");
    let propose = |conn: &mut Connection, md: &str| {
        call(
            conn,
            &a,
            "page_update",
            json!({"page_id": mine.id, "markdown": md}),
        )
        .unwrap()
        .proposal
        .unwrap()
        .0
    };

    // The pending message points at proposal_wait.
    let pid = propose(&mut conn, "First.");
    assert!(ops::detail(&conn, &pid).map(|p| !p.resume).unwrap());
    let waited = call(
        &mut conn,
        &a,
        "proposal_wait",
        json!({"proposal_id": pid, "timeout_seconds": 0}),
    )
    .unwrap()
    .text;
    assert!(
        waited.contains("still waiting") && waited.contains("Continue"),
        "{waited}"
    );
    assert!(ops::detail(&conn, &pid).unwrap().resume);
    ops::approve(&mut conn, &pid, None, Some("Looks good".into())).unwrap();
    let task_id = resume::follow_up(&mut conn, &pid)
        .unwrap()
        .expect("a follow-up task");
    assert_eq!(
        resume::follow_up(&mut conn, &pid).unwrap(),
        None,
        "only once"
    );
    let task = tasks::all(&conn, &ws, true)
        .unwrap()
        .into_iter()
        .find(|t| t.page_id == task_id)
        .unwrap();
    assert_eq!(task.title, "Continue: Rewrite “Plan”");
    assert_eq!(task.values["Agent"], "Claude");
    assert_eq!(task.values["Source"], "Review inbox");
    assert!(
        task.body.contains("approved and applied") && task.body.contains("Looks good"),
        "{}",
        task.body
    );
    // The agent picks it up with task_next.
    assert!(call(&mut conn, &a, "task_next", json!({}))
        .unwrap()
        .text
        .contains("Continue: Rewrite"));
    // Asking after the decision answers at once.
    assert!(
        call(&mut conn, &a, "proposal_wait", json!({"proposal_id": pid}))
            .unwrap()
            .text
            .contains("approved")
    );

    // A rejection carries the note; proposals nobody waits for queue nothing.
    let rejected = propose(&mut conn, "Second.");
    call(
        &mut conn,
        &a,
        "proposal_wait",
        json!({"proposal_id": rejected, "timeout_seconds": 0}),
    )
    .unwrap();
    ops::reject(&conn, &rejected, Some("Keep the draft".into())).unwrap();
    let t = resume::follow_up(&mut conn, &rejected).unwrap().unwrap();
    assert!(body(&conn, &t).contains("rejected. Reviewer's note: Keep the draft"));
    let quiet = propose(&mut conn, "Third.");
    ops::reject(&conn, &quiet, None).unwrap();
    assert_eq!(resume::follow_up(&mut conn, &quiet).unwrap(), None);
    // A session waiting right now hears it directly, so no task.
    let live = propose(&mut conn, "Fourth.");
    resume::begin(&conn, &get(&conn, &a.id).unwrap(), &live, true).unwrap();
    assert!(ops::detail(&conn, &live).unwrap().agent_waiting);
    ops::reject(&conn, &live, None).unwrap();
    assert_eq!(resume::follow_up(&mut conn, &live).unwrap(), None);
    // Other agents' proposals are not theirs to wait on.
    let other = agent(&mut conn, "Other", &ws, "propose");
    assert!(call(
        &mut conn,
        &other,
        "proposal_wait",
        json!({"proposal_id": live})
    )
    .is_err());
}

#[test]
fn batched_proposals_reference_new_pages_and_apply_atomically() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let a = agent(&mut conn, "Planner", &ws, "write");
    let out = call(
        &mut conn,
        &a,
        "changes_propose",
        json!({"title": "Set up", "changes": [
            {"op": "create_page", "key": "root", "title": "Project", "workspace_id": ws},
            {"op": "create_page", "title": "Notes", "parent": "key:root", "markdown": "Back to [[Project]]."}
        ]}),
    )
    .unwrap();
    assert_eq!(out.proposal.unwrap().1, "applied");
    let notes: String = conn
        .query_row("SELECT id FROM page WHERE title = 'Notes'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(body(&conn, &notes).contains("suivelle://page/"));
    // One bad change refuses the whole proposal, and nothing is left behind.
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM page", [], |r| r.get(0))
        .unwrap();
    let err = call(
        &mut conn,
        &a,
        "changes_propose",
        json!({"title": "Bad", "changes": [
            {"op": "create_page", "title": "Kept?"},
            {"op": "trash_page", "page_id": crate::domain::new_id()}
        ]}),
    )
    .unwrap_err();
    assert!(err.to_string().contains("Change 2"), "{err}");
    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM page", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn memory_supersedes_and_forgets() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let a = agent(&mut conn, "Recorder", &ws, "propose");
    let first = call(&mut conn, &a, "memory_write", json!({"title": "Deploys happen on Fridays", "body": "**Why:** team rule", "kind": "Decision", "scope": "release"})).unwrap();
    assert!(first.text.starts_with("Saved memory"));
    let old_id = first
        .text
        .trim_start_matches("Saved memory ")
        .trim_end_matches('.')
        .to_string();
    let recall = call(&mut conn, &a, "memory_recall", json!({"query": "deploys"}))
        .unwrap()
        .text;
    assert!(
        recall.contains("Deploys happen on Fridays") && recall.contains("Status: Active"),
        "{recall}"
    );
    call(
        &mut conn,
        &a,
        "memory_write",
        json!({"title": "Deploys happen on Tuesdays", "supersedes": old_id, "kind": "Decision"}),
    )
    .unwrap();
    let recall = call(&mut conn, &a, "memory_recall", json!({"query": "deploys"}))
        .unwrap()
        .text;
    assert!(
        recall.contains("Tuesdays") && !recall.contains("Fridays"),
        "{recall}"
    );
    let all = call(
        &mut conn,
        &a,
        "memory_recall",
        json!({"query": "deploys", "include_inactive": true}),
    )
    .unwrap()
    .text;
    assert!(all.contains("Status: Superseded"), "{all}");
    let new_id: String = conn
        .query_row(
            "SELECT id FROM page WHERE title = 'Deploys happen on Tuesdays'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    call(
        &mut conn,
        &a,
        "memory_forget",
        json!({"memory_id": new_id, "reason": "process changed"}),
    )
    .unwrap();
    assert_eq!(
        call(&mut conn, &a, "memory_recall", json!({"query": "deploys"}))
            .unwrap()
            .text,
        "No memories match.\n"
    );
    // Memory writes are saved directly even in propose mode.
    assert_eq!(ops::pending_count(&conn).unwrap(), 0);
    let pack = call(
        &mut conn,
        &a,
        "context_pack",
        json!({"query": "deploys", "budget_tokens": 1000}),
    )
    .unwrap()
    .text;
    assert!(pack.starts_with("# Context for Recorder"));
}

#[test]
fn task_queue_claims_leases_and_checks_the_original_todo() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let notes = page(&mut conn, &ws, "Notes", "- [ ] Rename the build script");
    let a = agent(&mut conn, "Builder", &ws, "propose");
    let b = agent(&mut conn, "Helper", &ws, "propose");
    let todos = call(&mut conn, &a, "todos", json!({})).unwrap().text;
    assert!(todos.contains("Rename the build script"), "{todos}");
    let block = repo::block::list(&conn, &notes.id)
        .unwrap()
        .into_iter()
        .find(|x| x.block_type == "todo")
        .unwrap()
        .id;
    call(
        &mut conn,
        &a,
        "todo_promote",
        json!({"block_id": block, "agent": "Builder"}),
    )
    .unwrap();
    call(
        &mut conn,
        &a,
        "task_create",
        json!({"title": "Anyone can do this"}),
    )
    .unwrap();

    // Helper only sees unassigned work.
    let claimed = call(&mut conn, &b, "task_next", json!({})).unwrap().text;
    assert!(claimed.contains("Anyone can do this"), "{claimed}");
    let claimed = call(&mut conn, &a, "task_next", json!({})).unwrap().text;
    assert!(claimed.contains("Rename the build script"), "{claimed}");
    assert_eq!(
        call(&mut conn, &b, "task_next", json!({})).unwrap().text,
        "No tasks are waiting for you."
    );
    let task_id = claimed
        .split("task id ")
        .nth(1)
        .unwrap()
        .split(')')
        .next()
        .unwrap()
        .to_string();
    // Someone else cannot finish it.
    assert!(call(&mut conn, &b, "task_complete", json!({"task_id": task_id})).is_err());
    call(&mut conn, &a, "task_heartbeat", json!({"task_id": task_id})).unwrap();
    call(
        &mut conn,
        &a,
        "task_complete",
        json!({"task_id": task_id, "result": "Renamed to build.mjs"}),
    )
    .unwrap();
    assert!(
        body(&conn, &notes.id).contains("- [x] Rename the build script"),
        "{}",
        body(&conn, &notes.id)
    );
    assert!(body(&conn, &task_id).contains("Renamed to build.mjs"));

    // A lease that runs out puts the task back.
    let helper_task: String = conn
        .query_row(
            "SELECT id FROM page WHERE title = 'Anyone can do this'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut v = Map::new();
    v.insert("Lease until".into(), json!("2000-01-01T00:00:00Z"));
    ops::apply_direct(
        &mut conn,
        &b,
        "test",
        &[Op::SetValues {
            page_id: helper_task.clone(),
            values: v,
        }],
    )
    .unwrap();
    assert_eq!(tasks::requeue_expired(&mut conn, &ws).unwrap(), 1);
    let list = call(&mut conn, &a, "task_list", json!({"status": "Queued"}))
        .unwrap()
        .text;
    assert!(list.contains("Anyone can do this"), "{list}");
}

#[test]
fn janitor_suggests_aliases_and_finds_tag_variants() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    page(&mut conn, &ws, "Release checklist", "");
    page(&mut conn, &ws, "Plan", "See [[Release checklst]]. #to-do");
    page(&mut conn, &ws, "Other", "More #todo");
    let report = janitor::report(&conn, &ws, &[], 50).unwrap();
    let unresolved = report
        .iter()
        .find(|f| f.check == "unresolved_links")
        .unwrap();
    assert!(
        matches!(&unresolved.fix, Some(Op::SetAliases { aliases, .. }) if aliases.contains(&"Release checklst".to_string()))
    );
    assert!(report.iter().any(|f| f.check == "tag_variants"));
    // Applying the suggested fix links the wikilink.
    let fix = unresolved.fix.clone().unwrap();
    ops::apply_as(
        &mut conn,
        &ops::Actor::user(vec![ws.clone()]),
        "fix",
        None,
        &[fix],
    )
    .unwrap();
    assert!(
        janitor::report(&conn, &ws, &["unresolved_links".into()], 50)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn mirror_writes_files_and_reads_edits_back() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let target = page(&mut conn, &ws, "Glossary", "Terms.");
    let p = page(&mut conn, &ws, "Plan", "See [[Glossary]].");
    let root = std::env::temp_dir().join(format!("suivelle-mirror-{}", crate::domain::new_id()));
    // A folder with other files is refused.
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("notes.txt"), "x").unwrap();
    assert!(mirror::configure(&conn, &ws, true, Some(root.to_string_lossy().into())).is_err());
    std::fs::remove_file(root.join("notes.txt")).unwrap();
    mirror::configure(&conn, &ws, true, Some(root.to_string_lossy().into())).unwrap();

    assert_eq!(mirror::sync_out(&conn, &ws, &root, false).unwrap(), 2);
    let text = std::fs::read_to_string(root.join("Plan.md")).unwrap();
    assert!(text.starts_with("---\nsuivelle: 1\nid: "), "{text}");
    assert!(text.contains("See [[Glossary]]."), "{text}");
    assert_eq!(
        mirror::sync_out(&conn, &ws, &root, true).unwrap(),
        0,
        "unchanged pages are not rewritten"
    );

    // An edit in the folder becomes a proposal by default.
    std::fs::write(
        root.join("Plan.md"),
        text.replace("See [[Glossary]].", "See [[Glossary]] first."),
    )
    .unwrap();
    let r = mirror::sync_in(&mut conn, &ws, &root, false, true).unwrap();
    assert_eq!(r.proposed, 1);
    assert_eq!(
        body(&conn, &p.id),
        format!("See [Glossary](suivelle://page/{}).", target.id)
    );
    let pid: String = conn
        .query_row(
            "SELECT id FROM proposal WHERE actor_kind = 'mirror'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    ops::approve(&mut conn, &pid, None, None).unwrap();
    assert!(body(&conn, &p.id).contains("first."));

    // With "apply", edits go straight in; a new file becomes a page.
    std::fs::write(root.join("Ideas.md"), "# Ideas\n\nA new note.").unwrap();
    let r = mirror::sync_in(&mut conn, &ws, &root, true, true).unwrap();
    assert_eq!(r.applied, 1);
    let ideas: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page WHERE title = 'Ideas' AND workspace_id = ?1",
            [&ws],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ideas, 1);
    mirror::sync_out(&conn, &ws, &root, false).unwrap();
    assert!(std::fs::read_to_string(root.join("Ideas.md"))
        .unwrap()
        .starts_with("---\nsuivelle: 1"));

    // A page changed in both places: the folder's version is kept aside and the app's wins.
    mirror::sync_out(&conn, &ws, &root, false).unwrap();
    let text = std::fs::read_to_string(root.join("Glossary.md")).unwrap();
    std::fs::write(
        root.join("Glossary.md"),
        text.replace("Terms.", "Folder terms."),
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    let g = repo::page::get(&tx, &target.id).unwrap().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    content::write_markdown(&tx, &g, "App terms.", WriteMode::Replace).unwrap();
    tx.commit().unwrap();
    mirror::sync_in(&mut conn, &ws, &root, true, false).unwrap();
    assert!(root.join("Glossary.conflict.md").exists());
    mirror::sync_out(&conn, &ws, &root, false).unwrap();
    assert!(std::fs::read_to_string(root.join("Glossary.md"))
        .unwrap()
        .contains("App terms."));
    assert_eq!(body(&conn, &target.id), "App terms.");

    // Trashing a page removes its file.
    services::page::delete(&mut conn, &p.id).unwrap();
    mirror::sync_out(&conn, &ws, &root, false).unwrap();
    assert!(!root.join("Plan.md").exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn spec_exports_respect_hand_edits() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let rules = page(&mut conn, &ws, "Conventions", "Use they/them for people.");
    let a = agent(&mut conn, "Doc Writer", &ws, "auto");
    let dir = std::env::temp_dir().join(format!("suivelle-spec-{}", crate::domain::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = spec::export_subagent(&conn, &a, &dir, false).unwrap();
    assert_eq!(out.status, "created");
    let file = dir.join(".claude/agents/doc-writer.md");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("---\nname: doc-writer\n"), "{text}");
    assert!(text.contains("mcp__suivelle__whoami") && text.contains("mcp__suivelle__memory_write"));
    assert_eq!(
        spec::export_subagent(&conn, &a, &dir, false)
            .unwrap()
            .status,
        "unchanged"
    );
    std::fs::write(&file, text.replace("Keeps notes tidy", "Hand edit")).unwrap();
    assert_eq!(
        spec::export_subagent(&conn, &a, &dir, false)
            .unwrap()
            .status,
        "modified"
    );
    assert_eq!(
        spec::export_subagent(&conn, &a, &dir, true).unwrap().status,
        "updated"
    );

    std::fs::write(dir.join("AGENTS.md"), "# Rules\n\nHand-written intro.\n").unwrap();
    let agents = list(&conn).unwrap();
    assert_eq!(
        spec::export_agents_md(&conn, &agents, std::slice::from_ref(&rules.id), &dir, false)
            .unwrap()
            .status,
        "updated"
    );
    let md = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
    assert!(
        md.starts_with("# Rules\n\nHand-written intro.")
            && md.contains("Use they/them for people.")
            && md.contains("**Doc Writer**")
    );
    assert_eq!(
        spec::export_agents_md(&conn, &agents, std::slice::from_ref(&rules.id), &dir, false)
            .unwrap()
            .status,
        "unchanged"
    );
    std::fs::write(dir.join("AGENTS.md"), md.replace("Use they/them", "Edited")).unwrap();
    assert_eq!(
        spec::export_agents_md(&conn, &agents, &[rules.id], &dir, false)
            .unwrap()
            .status,
        "modified"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn graph_tools_walk_links_relations_and_hierarchy() {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    let a1 = page(&mut conn, &ws, "A", "");
    let b1 = page(&mut conn, &ws, "B", "Links to [[A]].");
    let c1 = page(&mut conn, &ws, "C", "Links to [[B]].");
    let a = agent(&mut conn, "Navigator", &ws, "propose");
    let path = call(
        &mut conn,
        &a,
        "graph_path",
        json!({"from_page_id": c1.id, "to_page_id": a1.id}),
    )
    .unwrap()
    .text;
    assert!(
        path.contains("1. links to → **B**") && path.contains("2. links to → **A**"),
        "{path}"
    );
    let n = call(
        &mut conn,
        &a,
        "graph_neighbors",
        json!({"page_id": a1.id, "hops": 2}),
    )
    .unwrap()
    .text;
    assert!(n.contains("**B**") && n.contains("**C**"), "{n}");
    let back = call(&mut conn, &a, "graph_backlinks", json!({"page_id": a1.id}))
        .unwrap()
        .text;
    assert!(back.contains(&b1.id), "{back}");
}

#[derive(Clone)]
struct TestHost {
    conn: std::sync::Arc<std::sync::Mutex<Connection>>,
    notes: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
}

impl server::Host for TestHost {
    fn with_db<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut c = self.conn.lock().unwrap();
        f(&mut c)
    }
    fn read_only(&self) -> bool {
        false
    }
    fn react(&self, _: &mut Connection, _: Vec<crate::automation::engine::Event>) {}
    fn notify(&self, payload: Value) {
        self.notes.lock().unwrap().push(payload);
    }
}

#[test]
fn mcp_sessions_over_loopback() {
    use std::io::{BufRead, BufReader, Write};
    let mut conn = open_in_memory().unwrap();
    let ws = workspace(&mut conn, "Work");
    page(&mut conn, &ws, "Roadmap", "Ship the agent API.");
    let a = agent(&mut conn, "Claude", &ws, "propose");
    let token = rotate_token(&conn, &a.id).unwrap();
    let host = TestHost {
        conn: std::sync::Arc::new(std::sync::Mutex::new(conn)),
        notes: Default::default(),
    };
    let port = server::listen(host.clone()).unwrap();
    let session = |auth: &str| {
        let s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        writeln!(w, "{}", json!({ "auth": auth })).unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        (w, r, serde_json::from_str::<Value>(&line).unwrap())
    };
    let ask = |w: &mut std::net::TcpStream,
               r: &mut BufReader<std::net::TcpStream>,
               msg: Value|
     -> Value {
        writeln!(w, "{msg}").unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };

    // Turned off: refused with a reason.
    let (_, _, hello) = session(&token);
    assert_eq!(hello["ok"], false);
    assert!(hello["error"].as_str().unwrap().contains("turned off"));
    host.with_db(|c| {
        save_settings(
            c,
            &AgentSettings {
                api_enabled: true,
                default_mode: "propose".into(),
                mirror_edits: "propose".into(),
            },
        )
    })
    .unwrap();
    use server::Host;

    let (_, _, hello) = session("sva_wrong");
    assert_eq!(hello["ok"], false);

    let (mut w, mut r, hello) = session(&token);
    assert_eq!(hello["agent"], "Claude");
    let init = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}),
    );
    assert_eq!(init["result"]["serverInfo"]["name"], "suivelle");
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    // Notifications get no reply; the next answer belongs to the next request.
    writeln!(
        w,
        "{}",
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
    )
    .unwrap();
    let list = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    );
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"whoami")
            && names.contains(&"memory_write")
            && names.contains(&"task_next")
    );
    let found = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "search", "arguments": {"query": "agent"}}}),
    );
    assert_eq!(found["result"]["isError"], false);
    assert!(found["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Roadmap"));
    let made = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "page_create", "arguments": {"title": "Notes"}}}),
    );
    assert!(made["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Submitted for review"));
    assert_eq!(
        host.notes.lock().unwrap().last().unwrap()["proposalStatus"],
        "pending"
    );
    let bad = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "page_read", "arguments": {"page_id": "nope"}}}),
    );
    assert_eq!(bad["result"]["isError"], true);
    let unknown = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 6, "method": "sampling/createMessage"}),
    );
    assert_eq!(unknown["error"]["code"], -32601);
    // The /suivelle_… commands as MCP prompts.
    assert!(init["result"]["capabilities"]["prompts"].is_object());
    let prompts = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 8, "method": "prompts/list"}),
    );
    let names: Vec<&str> = prompts["result"]["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["init", "setup", "sync", "wrap-up"]);
    let got = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 9, "method": "prompts/get", "params": {"name": "wrap-up", "arguments": {"focus": "the API"}}}),
    );
    let text = got["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(
        text.contains("/suivelle_wrap-up") && text.ends_with("The user added: the API"),
        "{text}"
    );
    let audited: i64 = host
        .with_db(|c| Ok(c.query_row("SELECT COUNT(*) FROM agent_audit", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(audited, 3);

    // proposal_wait holds the call open until the user decides, without holding the database.
    let pid = host.notes.lock().unwrap().last().unwrap()["proposalId"]
        .as_str()
        .unwrap()
        .to_string();
    let decider = {
        let host = host.clone();
        let pid = pid.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            host.with_db(|c| ops::approve(c, &pid, None, Some("Go ahead".into())))
                .unwrap();
            host.with_db(|c| resume::follow_up(c, &pid)).unwrap()
        })
    };
    let started = std::time::Instant::now();
    let waited = ask(
        &mut w,
        &mut r,
        json!({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "proposal_wait", "arguments": {"proposal_id": pid, "timeout_seconds": 30}}}),
    );
    let text = waited["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("approved and applied") && text.contains("Go ahead"),
        "{text}"
    );
    assert!(
        started.elapsed() >= Duration::from_millis(700)
            && started.elapsed() < Duration::from_secs(10)
    );
    assert_eq!(
        decider.join().unwrap(),
        None,
        "the waiting session heard it, so no follow-up task"
    );

    // Pausing the agent ends the session at its next message.
    host.with_db(|c| {
        c.execute("UPDATE agent SET status = 'paused'", [])?;
        Ok(())
    })
    .unwrap();
    writeln!(
        w,
        "{}",
        json!({"jsonrpc": "2.0", "id": 7, "method": "ping"})
    )
    .unwrap();
    let mut line = String::new();
    assert_eq!(
        r.read_line(&mut line).unwrap_or(0),
        0,
        "connection closed: {line}"
    );
}
