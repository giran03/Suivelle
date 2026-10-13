//! Application services: validation + transactions + repository orchestration.
//! All mutations go through here so there is a single write path.

use crate::domain::*;
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use rusqlite::Connection;

pub mod duplicate;

pub mod workspace {
    use super::*;

    fn validate_icon(icon: Option<&str>) -> AppResult<()> {
        if let Some(hash) = icon.and_then(|i| i.strip_prefix("image:")) {
            return if crate::files::is_hash(hash) {
                Ok(())
            } else {
                Err(AppError::Validation("invalid workspace image icon".into()))
            };
        }
        if icon.is_some_and(|i| i.chars().count() > 64 || i.chars().any(char::is_control)) {
            return Err(AppError::Validation(
                "workspace icon must be at most 64 printable characters".into(),
            ));
        }
        Ok(())
    }

    fn validate_settings(json: &str) -> AppResult<()> {
        validate_json_object(json, "settings", 100_000)?;
        let value: serde_json::Value = serde_json::from_str(json)
            .map_err(|_| AppError::Validation("invalid settings".into()))?;
        for (key, allowed) in [
            ("theme", &["system", "light", "dark"][..]),
            ("sidebarDensity", &["comfortable", "normal", "compact"][..]),
        ] {
            if let Some(v) = value.get(key) {
                if !v.as_str().is_some_and(|s| allowed.contains(&s)) {
                    return Err(AppError::Validation(format!("invalid {key} setting")));
                }
            }
        }
        if value.get("accent").is_some_and(|v| {
            !v.as_str().is_some_and(|s| {
                ["violet", "gray", "red", "orange", "green", "blue"].contains(&s)
                    || s.strip_prefix('#').is_some_and(|hex| {
                        matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
                    })
            })
        }) {
            return Err(AppError::Validation("invalid accent setting".into()));
        }
        if value
            .get("description")
            .is_some_and(|v| v.as_str().is_none_or(|s| s.chars().count() > 280))
        {
            return Err(AppError::Validation(
                "description must be at most 280 characters".into(),
            ));
        }
        if value.get("autoBackup").is_some_and(|v| !v.is_boolean()) {
            return Err(AppError::Validation("autoBackup must be a boolean".into()));
        }
        if value.get("backupKeep").is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=1000).contains(&n))) {
            return Err(AppError::Validation("keep between 1 and 1000 automatic backups".into()));
        }
        Ok(())
    }

    pub fn create(conn: &mut Connection, input: WorkspaceCreate) -> AppResult<Workspace> {
        if input
            .icon
            .as_deref()
            .is_some_and(|i| i.starts_with("image:"))
        {
            return Err(AppError::Validation(
                "create the workspace before uploading an image icon".into(),
            ));
        }
        let tx = conn.transaction()?;
        let w = create_in(&tx, input)?;
        tx.commit()?;
        Ok(w)
    }

    pub(crate) fn create_in(conn: &Connection, input: WorkspaceCreate) -> AppResult<Workspace> {
        validate_name(&input.name)?;
        validate_icon(input.icon.as_deref())?;
        if let Some(json) = &input.settings_json {
            validate_settings(json)?;
        }
        // Backups protect the whole local installation, so new workspaces inherit its policy.
        let settings_json = repo::workspace::get_first(conn)?
            .and_then(|w| serde_json::from_str::<serde_json::Value>(&w.settings_json).ok())
            .map(|v| serde_json::json!({"autoBackup":v.get("autoBackup").and_then(serde_json::Value::as_bool).unwrap_or(true), "backupKeep":v.get("backupKeep").and_then(serde_json::Value::as_u64).filter(|n| (1..=1000).contains(n)).unwrap_or(3)}).to_string())
            .unwrap_or_else(|| "{}".into());
        let mut profile = input
            .settings_json
            .as_deref()
            .map(serde_json::from_str::<serde_json::Value>)
            .transpose()
            .map_err(|_| AppError::Validation("invalid settings".into()))?
            .unwrap_or_else(|| serde_json::json!({}));
        let inherited: serde_json::Value =
            serde_json::from_str(&settings_json).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(on) = inherited.get("autoBackup") {
            profile["autoBackup"] = on.clone();
        }
        if let Some(keep) = inherited.get("backupKeep") {
            profile["backupKeep"] = keep.clone();
        }
        let settings_json = profile.to_string();
        let now = now();
        let w = Workspace {
            id: new_id(),
            name: input.name.trim().to_string(),
            icon: input.icon,
            settings_json,
            schema_version: 1,
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        repo::workspace::insert(conn, &w)?;
        Ok(w)
    }

    pub fn update(conn: &mut Connection, input: WorkspaceUpdate) -> AppResult<Workspace> {
        validate_id(&input.id, "workspace")?;
        if let Some(n) = &input.name {
            validate_name(n)?;
        }
        validate_icon(input.icon.as_deref())?;
        if let Some(json) = &input.settings_json {
            validate_settings(json)?;
        }
        let tx = conn.transaction()?;
        let w = repo::workspace::get(&tx, &input.id)?
            .ok_or_else(|| AppError::NotFound("workspace".into()))?;
        let name = input.name.map(|n| n.trim().to_string()).unwrap_or(w.name);
        let icon = if input.clear_icon {
            None
        } else {
            input.icon.or(w.icon)
        };
        let settings = input.settings_json.unwrap_or(w.settings_json);
        if let Some(hash) = icon.as_deref().and_then(|i| i.strip_prefix("image:")) {
            let owned: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachment WHERE workspace_id = ?1 AND hash = ?2 AND mime_type LIKE 'image/%')",
                rusqlite::params![input.id, hash], |r| r.get(0),
            )?;
            if !owned {
                return Err(AppError::Validation(
                    "the workspace icon image is missing; upload it again".into(),
                ));
            }
        }
        repo::workspace::update_profile(&tx, &input.id, &name, icon.as_deref(), &settings, &now())?;
        let w = repo::workspace::get(&tx, &input.id)?
            .ok_or_else(|| AppError::NotFound("workspace".into()))?;
        tx.commit()?;
        Ok(w)
    }

    pub fn validate_deletion(conn: &Connection, id: &str, confirmation: &str) -> AppResult<()> {
        validate_id(id, "workspace")?;
        let workspace = repo::workspace::get(conn, id)?
            .ok_or_else(|| AppError::NotFound("workspace".into()))?;
        if workspace.name != confirmation.trim() {
            return Err(AppError::Validation(
                "type the workspace name to confirm deletion".into(),
            ));
        }
        if repo::workspace::count(conn)? <= 1 {
            return Err(AppError::Validation(
                "the last workspace cannot be deleted".into(),
            ));
        }
        Ok(())
    }

    /// Keep the database stable until the verified safety copy and deletion both finish.
    pub fn delete_safely(
        conn: &std::sync::Mutex<Connection>,
        paths: &crate::backup::Paths,
        id: &str,
        confirmation: &str,
    ) -> AppResult<String> {
        let mut conn = conn
            .lock()
            .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
        validate_deletion(&conn, id, confirmation)?;
        let pending = crate::backup::begin(&conn, paths, "safety")?;
        let backup = crate::backup::finish_in_app(paths, pending)?;
        delete(&mut conn, id)?;
        Ok(backup.name)
    }

    /// The backup archive includes every workspace; its daily schedule is installation-wide.
    pub fn set_auto_backup(conn: &mut Connection, enabled: bool) -> AppResult<Vec<Workspace>> {
        set_backup_policy(conn, Some(enabled), None)
    }

    pub fn set_backup_policy(conn: &mut Connection, enabled: Option<bool>, keep: Option<usize>) -> AppResult<Vec<Workspace>> {
        if keep.is_some_and(|n| !(1..=1000).contains(&n)) {
            return Err(AppError::Validation("keep between 1 and 1000 automatic backups".into()));
        }
        let tx = conn.transaction()?;
        for w in repo::workspace::list(&tx)? {
            let mut settings = serde_json::from_str::<serde_json::Value>(&w.settings_json)
                .unwrap_or_else(|_| serde_json::json!({}));
            if !settings.is_object() {
                settings = serde_json::json!({});
            }
            if let Some(enabled) = enabled {
                settings["autoBackup"] = serde_json::Value::Bool(enabled);
            }
            if let Some(keep) = keep {
                settings["backupKeep"] = serde_json::json!(keep);
            }
            repo::workspace::update_settings(&tx, &w.id, &settings.to_string(), &now())?;
        }
        let workspaces = repo::workspace::list(&tx)?;
        tx.commit()?;
        Ok(workspaces)
    }

    /// Permanently deletes a workspace and everything in it. The last workspace cannot be deleted.
    pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
        validate_id(id, "workspace")?;
        let tx = conn.transaction()?;
        if repo::workspace::count(&tx)? <= 1 {
            return Err(AppError::Validation(
                "the last workspace cannot be deleted".into(),
            ));
        }
        search::index::remove_workspace(&tx, id)?;
        if repo::workspace::delete(&tx, id)? == 0 {
            return Err(AppError::NotFound("workspace".into()));
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_settings(
        conn: &mut Connection,
        input: WorkspaceUpdateSettings,
    ) -> AppResult<Workspace> {
        validate_id(&input.id, "workspace")?;
        validate_settings(&input.settings_json)?;
        let tx = conn.transaction()?;
        if repo::workspace::update_settings(&tx, &input.id, &input.settings_json, &now())? == 0 {
            return Err(AppError::NotFound("workspace".into()));
        }
        let w = repo::workspace::get(&tx, &input.id)?
            .ok_or_else(|| AppError::NotFound("workspace".into()))?;
        tx.commit()?;
        Ok(w)
    }
}

pub mod page {
    use super::*;

    pub fn create(conn: &mut Connection, input: PageCreate) -> AppResult<Page> {
        validate_id(&input.workspace_id, "workspace")?;
        if let Some(p) = &input.parent_page_id {
            validate_id(p, "parent page")?;
        }
        let title = input.title.unwrap_or_default();
        validate_title(&title)?;

        let tx = conn.transaction()?;
        if repo::workspace::get(&tx, &input.workspace_id)?.is_none() {
            return Err(AppError::NotFound("workspace".into()));
        }
        if let Some(pid) = &input.parent_page_id {
            match repo::page::get(&tx, pid)? {
                Some(p) if p.workspace_id == input.workspace_id && p.deleted_at.is_none() => {
                    if p.kind != "page" {
                        return Err(AppError::Validation(
                            "databases and records cannot contain pages".into(),
                        ));
                    }
                }
                _ => return Err(AppError::NotFound("parent page".into())),
            }
        }
        let now = now();
        let page = Page {
            id: new_id(),
            workspace_id: input.workspace_id.clone(),
            parent_page_id: input.parent_page_id.clone(),
            title,
            icon: input.icon,
            cover: None,
            position: repo::page::next_position(
                &tx,
                &input.workspace_id,
                input.parent_page_id.as_deref(),
            )?,
            favorite: false,
            archived: false,
            deleted_at: None,
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
            child_count: 0,
            kind: "page".into(),
        };
        repo::page::insert(&tx, &page)?;
        search::index::upsert_page(&tx, &page)?;
        tx.commit()?;
        Ok(page)
    }

    pub fn update(conn: &mut Connection, input: PageUpdate) -> AppResult<Page> {
        validate_id(&input.id, "page")?;
        if let Some(t) = &input.title {
            validate_title(t)?;
        }
        if let Some(p) = input.position {
            validate_position(p)?;
        }
        let tx = conn.transaction()?;
        let mut page = repo::page::get(&tx, &input.id)?
            .filter(|p| p.deleted_at.is_none())
            .ok_or_else(|| AppError::NotFound("page".into()))?;
        if let Some(t) = input.title {
            page.title = t;
        }
        if input.icon.is_some() {
            page.icon = input.icon;
        }
        if input.cover.is_some() {
            page.cover = input.cover;
        }
        if let Some(p) = input.position {
            page.position = p;
        }
        if let Some(f) = input.favorite {
            page.favorite = f;
        }
        if let Some(a) = input.archived {
            page.archived = a;
        }
        page.updated_at = now();
        repo::page::update(&tx, &page)?;
        search::index::upsert_page(&tx, &page)?;
        page.revision += 1;
        tx.commit()?;
        Ok(page)
    }

    /// Moves a page under a new parent (or to the top level) and positions it before a sibling.
    pub fn move_page(conn: &mut Connection, input: PageMove) -> AppResult<Page> {
        validate_id(&input.id, "page")?;
        if let Some(p) = &input.parent_page_id {
            validate_id(p, "parent page")?;
        }
        if let Some(b) = &input.before_page_id {
            validate_id(b, "sibling page")?;
        }
        let tx = conn.transaction()?;
        let page = repo::page::get(&tx, &input.id)?
            .filter(|p| p.deleted_at.is_none())
            .ok_or_else(|| AppError::NotFound("page".into()))?;
        let parent = input.parent_page_id.as_deref();
        if let Some(pid) = parent {
            match repo::page::get(&tx, pid)? {
                Some(p) if p.workspace_id == page.workspace_id && p.deleted_at.is_none() => {
                    if p.kind != "page" {
                        return Err(AppError::Validation(
                            "databases and records cannot contain pages".into(),
                        ));
                    }
                }
                _ => return Err(AppError::NotFound("parent page".into())),
            }
            if repo::page::in_subtree(&tx, &page.id, pid)? {
                return Err(AppError::Validation(
                    "a page cannot be moved into itself or its descendants".into(),
                ));
            }
        }
        if page.kind == "record" {
            return Err(AppError::Validation(
                "records stay inside their database".into(),
            ));
        }
        let position = place_among_siblings(&tx, &page, parent, input.before_page_id.as_deref())?;
        repo::page::set_parent_position(&tx, &page.id, parent, position, &now())?;
        let moved =
            repo::page::get(&tx, &page.id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
        tx.commit()?;
        Ok(moved)
    }

    /// Position that puts `page` before `before` (or last) among the live children of `parent`.
    fn place_among_siblings(
        conn: &Connection,
        page: &Page,
        parent: Option<&str>,
        before: Option<&str>,
    ) -> AppResult<f64> {
        let mut siblings: Vec<Page> = repo::page::list_children(conn, &page.workspace_id, parent)?
            .into_iter()
            .filter(|p| p.id != page.id)
            .collect();
        let Some(before_id) = before else {
            return Ok(siblings.last().map_or(0.0, |p| p.position + 1.0));
        };
        let mut idx = siblings
            .iter()
            .position(|p| p.id == before_id)
            .ok_or_else(|| AppError::NotFound("sibling page".into()))?;
        // Positions are fractional midpoints; renumber when the gap gets too small to split.
        if idx > 0 && siblings[idx].position - siblings[idx - 1].position < 1e-6 {
            for (i, sib) in siblings.iter_mut().enumerate() {
                sib.position = i as f64;
                repo::page::set_position(conn, &sib.id, sib.position)?;
            }
            idx = siblings
                .iter()
                .position(|p| p.id == before_id)
                .unwrap_or(idx);
        }
        Ok(if idx == 0 {
            siblings[0].position - 1.0
        } else {
            (siblings[idx - 1].position + siblings[idx].position) / 2.0
        })
    }

    /// Restores a trashed page with the descendants trashed alongside it.
    /// If its parent is still in the trash the page comes back at the top level.
    pub fn restore(conn: &mut Connection, id: &str) -> AppResult<Page> {
        validate_id(id, "page")?;
        let tx = conn.transaction()?;
        let page = repo::page::get(&tx, id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
        let deleted_at = page
            .deleted_at
            .clone()
            .ok_or_else(|| AppError::Validation("page is not in the trash".into()))?;
        let now = now();
        let parent_trashed = match &page.parent_page_id {
            Some(pid) => repo::page::get(&tx, pid)?.is_none_or(|p| p.deleted_at.is_some()),
            None => false,
        };
        if parent_trashed && page.kind == "record" {
            return Err(AppError::Validation("restore the database first".into()));
        }
        repo::page::restore_tree(&tx, id, &deleted_at, &now)?;
        if parent_trashed {
            let pos = repo::page::next_position(&tx, &page.workspace_id, None)?;
            repo::page::set_parent_position(&tx, id, None, pos, &now)?;
        }
        let restored =
            repo::page::get(&tx, id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
        tx.commit()?;
        Ok(restored)
    }

    /// Irreversibly deletes a page that is already in the trash, with its descendants and blocks.
    pub fn delete_permanent(conn: &mut Connection, id: &str) -> AppResult<()> {
        validate_id(id, "page")?;
        let tx = conn.transaction()?;
        let page = repo::page::get(&tx, id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
        if page.deleted_at.is_none() {
            return Err(AppError::Validation(
                "only pages in the trash can be deleted permanently".into(),
            ));
        }
        for pid in repo::page::subtree_ids(&tx, id)? {
            search::index::remove_page(&tx, &pid)?;
        }
        repo::page::hard_delete(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn empty_trash(conn: &mut Connection, workspace_id: &str) -> AppResult<()> {
        validate_id(workspace_id, "workspace")?;
        let tx = conn.transaction()?;
        for pid in repo::page::trashed_ids(&tx, workspace_id)? {
            search::index::remove_page(&tx, &pid)?;
        }
        repo::page::hard_delete_trashed(&tx, workspace_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Soft delete (move to trash) of the page and its descendants.
    pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
        validate_id(id, "page")?;
        let tx = conn.transaction()?;
        if repo::page::soft_delete_tree(&tx, id, &now())? == 0 {
            return Err(AppError::NotFound("page".into()));
        }
        tx.commit()?;
        Ok(())
    }
}

pub mod block {
    use super::*;

    /// Keeps search, references and the page's modified time in step with a saved block.
    fn index_block(conn: &Connection, page_id: &str, b: &Block) -> AppResult<()> {
        let page =
            repo::page::get(conn, page_id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
        search::index::upsert_block(
            conn,
            &page.workspace_id,
            page_id,
            &b.id,
            &b.block_type,
            b.schema_version,
            &b.data_json,
        )?;
        repo::page::touch_updated(conn, page_id, &now())
    }

    fn require_live_page(conn: &Connection, page_id: &str) -> AppResult<()> {
        match repo::page::get(conn, page_id)? {
            Some(p) if p.deleted_at.is_none() => Ok(()),
            _ => Err(AppError::NotFound("page".into())),
        }
    }

    pub fn create(conn: &mut Connection, input: BlockCreate) -> AppResult<Block> {
        validate_id(&input.page_id, "page")?;
        validate_block_type(&input.block_type)?;
        let data_json = input.data_json.unwrap_or_else(|| "{}".into());
        validate_json_object(&data_json, "block data", MAX_BLOCK_DATA_BYTES)?;

        let tx = conn.transaction()?;
        require_live_page(&tx, &input.page_id)?;
        if let Some(parent) = &input.parent_block_id {
            validate_id(parent, "parent block")?;
            match repo::block::get(&tx, parent)? {
                Some(b) if b.page_id == input.page_id => {}
                _ => return Err(AppError::NotFound("parent block".into())),
            }
        }
        let parent = input.parent_block_id.as_deref();
        let position = match &input.after_block_id {
            Some(after_id) => {
                validate_id(after_id, "block")?;
                let after = repo::block::get(&tx, after_id)?
                    .filter(|b| {
                        b.page_id == input.page_id && b.parent_block_id.as_deref() == parent
                    })
                    .ok_or_else(|| AppError::NotFound("sibling block".into()))?;
                match repo::block::next_sibling_position(
                    &tx,
                    &input.page_id,
                    parent,
                    after.position,
                )? {
                    Some(next) => (after.position + next) / 2.0,
                    None => after.position + 1.0,
                }
            }
            None => repo::block::next_position(&tx, &input.page_id, parent)?,
        };
        let now = now();
        let block = Block {
            id: new_id(),
            page_id: input.page_id,
            parent_block_id: input.parent_block_id,
            block_type: input.block_type,
            position,
            data_json,
            schema_version: BLOCK_SCHEMA_VERSION,
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        repo::block::insert(&tx, &block)?;
        index_block(&tx, &block.page_id, &block)?;
        tx.commit()?;
        Ok(block)
    }

    pub fn update(conn: &mut Connection, input: BlockUpdate) -> AppResult<Block> {
        validate_id(&input.id, "block")?;
        if let Some(t) = &input.block_type {
            validate_block_type(t)?;
        }
        if let Some(d) = &input.data_json {
            validate_json_object(d, "block data", MAX_BLOCK_DATA_BYTES)?;
        }
        if let Some(p) = input.position {
            validate_position(p)?;
        }
        let tx = conn.transaction()?;
        let mut block =
            repo::block::get(&tx, &input.id)?.ok_or_else(|| AppError::NotFound("block".into()))?;
        if let Some(t) = input.block_type {
            block.block_type = t;
        }
        if let Some(d) = input.data_json {
            block.data_json = d;
        }
        if let Some(p) = input.position {
            block.position = p;
        }
        block.updated_at = now();
        repo::block::update(&tx, &block)?;
        index_block(&tx, &block.page_id, &block)?;
        block.revision += 1;
        tx.commit()?;
        Ok(block)
    }

    /// Applies the editor's pending changes for one page atomically: upserts (parents before
    /// children), then deletions. Rows that belong to another page are rejected.
    pub fn apply_batch(conn: &mut Connection, input: BlockBatch) -> AppResult<()> {
        validate_id(&input.page_id, "page")?;
        if input.upserts.len() + input.delete_ids.len() > MAX_BATCH_OPS {
            return Err(AppError::Validation(
                "too many block changes in one batch".into(),
            ));
        }
        for u in &input.upserts {
            validate_id(&u.id, "block")?;
            if let Some(p) = &u.parent_block_id {
                validate_id(p, "parent block")?;
            }
            validate_block_type(&u.block_type)?;
            validate_json_object(&u.data_json, "block data", MAX_BLOCK_DATA_BYTES)?;
            validate_position(u.position)?;
            if !(1..=BLOCK_SCHEMA_VERSION).contains(&u.schema_version) {
                return Err(AppError::Validation(
                    "unsupported block schema version".into(),
                ));
            }
        }
        for d in &input.delete_ids {
            validate_id(d, "block")?;
        }

        let tx = conn.transaction()?;
        require_live_page(&tx, &input.page_id)?;
        crate::history::before_edit(
            &tx,
            &input.page_id,
            input.upserts.len() + input.delete_ids.len(),
        )?;
        apply_batch_in(&tx, &input)?;
        tx.commit()?;
        Ok(())
    }

    /// The body of [`apply_batch`] for a caller that holds the transaction and has validated the
    /// batch (history restore uses it with blocks that came from the database itself).
    pub fn apply_batch_in(tx: &Connection, input: &BlockBatch) -> AppResult<()> {
        require_live_page(tx, &input.page_id)?;
        let workspace_id = repo::page::get(tx, &input.page_id)?
            .map(|p| p.workspace_id)
            .ok_or_else(|| AppError::NotFound("page".into()))?;
        let now = now();
        let mut pending: Vec<&BlockUpsert> = input.upserts.iter().collect();
        while !pending.is_empty() {
            let before = pending.len();
            let mut deferred = Vec::new();
            for u in pending {
                let parent_ready = match &u.parent_block_id {
                    None => true,
                    Some(p) => {
                        repo::block::page_of(tx, p)?.as_deref() == Some(input.page_id.as_str())
                    }
                };
                if !parent_ready {
                    deferred.push(u);
                    continue;
                }
                let existing_page = repo::block::page_of(tx, &u.id)?;
                if existing_page.as_deref().is_some_and(|p| p != input.page_id) {
                    return Err(AppError::Validation("block belongs to another page".into()));
                }
                if let Some(p) = &u.parent_block_id {
                    if *p == u.id
                        || (existing_page.is_some() && repo::block::in_subtree(tx, &u.id, p)?)
                    {
                        return Err(AppError::Validation(
                            "a block cannot be nested inside itself".into(),
                        ));
                    }
                }
                repo::block::upsert(
                    tx,
                    &Block {
                        id: u.id.clone(),
                        page_id: input.page_id.clone(),
                        parent_block_id: u.parent_block_id.clone(),
                        block_type: u.block_type.clone(),
                        position: u.position,
                        data_json: u.data_json.clone(),
                        schema_version: u.schema_version,
                        revision: 1,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    },
                )?;
                search::index::upsert_block(
                    tx,
                    &workspace_id,
                    &input.page_id,
                    &u.id,
                    &u.block_type,
                    u.schema_version,
                    &u.data_json,
                )?;
            }
            if deferred.len() == before {
                return Err(AppError::Validation("invalid block hierarchy".into()));
            }
            pending = deferred;
        }
        for d in &input.delete_ids {
            if repo::block::page_of(tx, d)?.as_deref() == Some(input.page_id.as_str()) {
                search::index::remove_block_tree(tx, d)?;
                repo::block::delete(tx, d)?;
            }
        }
        if !input.upserts.is_empty() || !input.delete_ids.is_empty() {
            repo::page::touch_updated(tx, &input.page_id, &now)?;
        }
        Ok(())
    }

    pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
        validate_id(id, "block")?;
        let tx = conn.transaction()?;
        let page_id = repo::block::page_of(&tx, id)?;
        search::index::remove_block_tree(&tx, id)?;
        if repo::block::delete(&tx, id)? == 0 {
            return Err(AppError::NotFound("block".into()));
        }
        if let Some(p) = page_id {
            repo::page::touch_updated(&tx, &p, &now())?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::open_in_memory;

    fn setup() -> (Connection, Workspace) {
        let mut conn = open_in_memory().unwrap();
        let ws = workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Test".into(),
                icon: None,
                ..Default::default()
            },
        )
        .unwrap();
        (conn, ws)
    }

    fn new_page(conn: &mut Connection, ws: &Workspace, parent: Option<&str>, title: &str) -> Page {
        page::create(
            conn,
            PageCreate {
                workspace_id: ws.id.clone(),
                parent_page_id: parent.map(String::from),
                title: Some(title.into()),
                icon: None,
            },
        )
        .unwrap()
    }

    fn new_block(conn: &mut Connection, page_id: &str, after: Option<&str>, text: &str) -> Block {
        block::create(
            conn,
            BlockCreate {
                page_id: page_id.into(),
                parent_block_id: None,
                block_type: "paragraph".into(),
                data_json: Some(format!("{{\"text\":\"{text}\"}}")),
                after_block_id: after.map(String::from),
            },
        )
        .unwrap()
    }

    #[test]
    fn workspace_roundtrip_and_settings() {
        let (mut conn, ws) = setup();
        assert_eq!(
            repo::workspace::get_first(&conn).unwrap().unwrap().id,
            ws.id
        );
        let updated = workspace::update_settings(
            &mut conn,
            WorkspaceUpdateSettings {
                id: ws.id.clone(),
                settings_json: "{\"theme\":\"dark\"}".into(),
            },
        )
        .unwrap();
        assert_eq!(updated.settings_json, "{\"theme\":\"dark\"}");
        assert_eq!(updated.revision, 2);
    }

    #[test]
    fn workspace_rejects_bad_input() {
        let (mut conn, ws) = setup();
        assert!(matches!(
            workspace::create(
                &mut conn,
                WorkspaceCreate {
                    name: "  ".into(),
                    icon: None,
                    ..Default::default()
                }
            ),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            workspace::update_settings(
                &mut conn,
                WorkspaceUpdateSettings {
                    id: ws.id,
                    settings_json: "[1]".into()
                }
            ),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn page_hierarchy_and_ordering() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let b = new_page(&mut conn, &ws, None, "B");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        let roots = repo::page::list_children(&conn, &ws.id, None).unwrap();
        assert_eq!(
            roots.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
            ["A", "B"]
        );
        assert!(b.position > a.position);
        let kids = repo::page::list_children(&conn, &ws.id, Some(&a.id)).unwrap();
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].id, a1.id);
    }

    #[test]
    fn page_update_bumps_revision() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "Old");
        let u = page::update(
            &mut conn,
            PageUpdate {
                id: p.id.clone(),
                title: Some("New".into()),
                icon: None,
                cover: None,
                position: None,
                favorite: Some(true),
                archived: None,
            },
        )
        .unwrap();
        assert_eq!(u.title, "New");
        assert!(u.favorite);
        let stored = repo::page::get(&conn, &p.id).unwrap().unwrap();
        assert_eq!(stored.revision, 2);
        assert_eq!(stored.title, "New");
    }

    #[test]
    fn page_delete_is_soft_and_recursive() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        page::delete(&mut conn, &a.id).unwrap();
        assert!(repo::page::list_children(&conn, &ws.id, None)
            .unwrap()
            .is_empty());
        let stored = repo::page::get(&conn, &a1.id).unwrap().unwrap();
        assert!(stored.deleted_at.is_some());
        assert!(matches!(
            page::delete(&mut conn, &a.id),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            page::create(
                &mut conn,
                PageCreate {
                    workspace_id: ws.id.clone(),
                    parent_page_id: Some(a.id),
                    title: None,
                    icon: None
                }
            ),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn page_validation() {
        let (mut conn, ws) = setup();
        let long = "x".repeat(MAX_TITLE_LEN + 1);
        assert!(matches!(
            page::create(
                &mut conn,
                PageCreate {
                    workspace_id: ws.id.clone(),
                    parent_page_id: None,
                    title: Some(long),
                    icon: None
                }
            ),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            page::create(
                &mut conn,
                PageCreate {
                    workspace_id: "nope".into(),
                    parent_page_id: None,
                    title: None,
                    icon: None
                }
            ),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            page::create(
                &mut conn,
                PageCreate {
                    workspace_id: new_id(),
                    parent_page_id: None,
                    title: None,
                    icon: None
                }
            ),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn block_crud_and_ordering() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let b1 = new_block(&mut conn, &p.id, None, "one");
        let b3 = new_block(&mut conn, &p.id, None, "three");
        let b2 = new_block(&mut conn, &p.id, Some(&b1.id), "two");
        let listed = repo::block::list(&conn, &p.id).unwrap();
        assert_eq!(
            listed.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
            [&b1.id, &b2.id, &b3.id]
        );

        let u = block::update(
            &mut conn,
            BlockUpdate {
                id: b2.id.clone(),
                block_type: Some("heading_1".into()),
                data_json: Some("{\"text\":\"2\"}".into()),
                position: None,
            },
        )
        .unwrap();
        assert_eq!(u.block_type, "heading_1");
        assert_eq!(
            repo::block::get(&conn, &b2.id).unwrap().unwrap().revision,
            2
        );

        block::delete(&mut conn, &b2.id).unwrap();
        assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
        assert!(matches!(
            block::delete(&mut conn, &b2.id),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn block_validation() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let bad = |t: &str, d: Option<&str>| BlockCreate {
            page_id: p.id.clone(),
            parent_block_id: None,
            block_type: t.into(),
            data_json: d.map(String::from),
            after_block_id: None,
        };
        // Cloned inputs so `conn` can be reborrowed.
        assert!(matches!(
            block::create(&mut conn, bad("embed", None)),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            block::create(&mut conn, bad("paragraph", Some("not json"))),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            block::create(&mut conn, bad("paragraph", Some("[1]"))),
            Err(AppError::Validation(_))
        ));
        let huge = format!("{{\"t\":\"{}\"}}", "x".repeat(MAX_BLOCK_DATA_BYTES));
        assert!(matches!(
            block::create(&mut conn, bad("paragraph", Some(&huge))),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn blocks_cannot_cross_pages() {
        let (mut conn, ws) = setup();
        let p1 = new_page(&mut conn, &ws, None, "P1");
        let p2 = new_page(&mut conn, &ws, None, "P2");
        let b = new_block(&mut conn, &p1.id, None, "x");
        let res = block::create(
            &mut conn,
            BlockCreate {
                page_id: p2.id,
                parent_block_id: Some(b.id),
                block_type: "paragraph".into(),
                data_json: None,
                after_block_id: None,
            },
        );
        assert!(matches!(res, Err(AppError::NotFound(_))));
    }

    #[test]
    fn nested_blocks_cascade_on_delete() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let parent = new_block(&mut conn, &p.id, None, "parent");
        block::create(
            &mut conn,
            BlockCreate {
                page_id: p.id.clone(),
                parent_block_id: Some(parent.id.clone()),
                block_type: "paragraph".into(),
                data_json: None,
                after_block_id: None,
            },
        )
        .unwrap();
        assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
        block::delete(&mut conn, &parent.id).unwrap();
        assert!(repo::block::list(&conn, &p.id).unwrap().is_empty());
    }

    fn titles(pages: &[Page]) -> Vec<&str> {
        pages.iter().map(|p| p.title.as_str()).collect()
    }

    fn mv(
        conn: &mut Connection,
        id: &str,
        parent: Option<&str>,
        before: Option<&str>,
    ) -> AppResult<Page> {
        page::move_page(
            conn,
            PageMove {
                id: id.into(),
                parent_page_id: parent.map(String::from),
                before_page_id: before.map(String::from),
            },
        )
    }

    #[test]
    fn child_count_tracks_live_children() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        new_page(&mut conn, &ws, Some(&a.id), "A2");
        assert_eq!(
            repo::page::get(&conn, &a.id).unwrap().unwrap().child_count,
            2
        );
        page::delete(&mut conn, &a1.id).unwrap();
        assert_eq!(
            repo::page::get(&conn, &a.id).unwrap().unwrap().child_count,
            1
        );
    }

    #[test]
    fn move_reorders_among_siblings() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let b = new_page(&mut conn, &ws, None, "B");
        let c = new_page(&mut conn, &ws, None, "C");
        mv(&mut conn, &c.id, None, Some(&a.id)).unwrap(); // C first
        assert_eq!(
            titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
            ["C", "A", "B"]
        );
        mv(&mut conn, &c.id, None, Some(&b.id)).unwrap(); // C between A and B
        assert_eq!(
            titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
            ["A", "C", "B"]
        );
        mv(&mut conn, &a.id, None, None).unwrap(); // A last
        assert_eq!(
            titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
            ["C", "B", "A"]
        );
    }

    #[test]
    fn move_reparents_and_blocks_cycles() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let b = new_page(&mut conn, &ws, Some(&a.id), "B");
        let c = new_page(&mut conn, &ws, Some(&b.id), "C");
        let x = new_page(&mut conn, &ws, None, "X");
        let moved = mv(&mut conn, &x.id, Some(&c.id), None).unwrap();
        assert_eq!(moved.parent_page_id.as_deref(), Some(c.id.as_str()));
        // A cannot move under its own descendant, or under itself.
        assert!(matches!(
            mv(&mut conn, &a.id, Some(&c.id), None),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            mv(&mut conn, &a.id, Some(&a.id), None),
            Err(AppError::Validation(_))
        ));
        // Back to the top level.
        let top = mv(&mut conn, &x.id, None, None).unwrap();
        assert!(top.parent_page_id.is_none());
    }

    #[test]
    fn move_rejects_foreign_or_trashed_targets() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let b = new_page(&mut conn, &ws, None, "B");
        let trashed = new_page(&mut conn, &ws, None, "T");
        page::delete(&mut conn, &trashed.id).unwrap();
        assert!(matches!(
            mv(&mut conn, &a.id, Some(&trashed.id), None),
            Err(AppError::NotFound(_))
        ));
        // `before` must be a sibling under the target parent.
        let child = new_page(&mut conn, &ws, Some(&b.id), "child");
        assert!(matches!(
            mv(&mut conn, &a.id, None, Some(&child.id)),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            mv(&mut conn, &trashed.id, None, None),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn repeated_inserts_at_front_keep_order() {
        let (mut conn, ws) = setup();
        let anchor = new_page(&mut conn, &ws, None, "anchor");
        let first = new_page(&mut conn, &ws, None, "first");
        mv(&mut conn, &first.id, None, Some(&anchor.id)).unwrap();
        // Repeatedly squeeze pages between `first` and `anchor` to force midpoint renumbering.
        for i in 0..60 {
            let p = new_page(&mut conn, &ws, None, &format!("p{i}"));
            mv(&mut conn, &p.id, None, Some(&anchor.id)).unwrap();
        }
        let list = repo::page::list_children(&conn, &ws.id, None).unwrap();
        assert_eq!(list.len(), 62);
        assert_eq!(list.first().unwrap().title, "first");
        assert_eq!(list.last().unwrap().title, "anchor");
        assert_eq!(list[list.len() - 2].title, "p59");
    }

    #[test]
    fn trash_lists_batch_roots_and_restores_tree() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        let a2 = new_page(&mut conn, &ws, Some(&a1.id), "A2");
        page::delete(&mut conn, &a.id).unwrap();
        let trash = repo::page::list_trash(&conn, &ws.id).unwrap();
        assert_eq!(titles(&trash), ["A"]);
        let restored = page::restore(&mut conn, &a.id).unwrap();
        assert!(restored.deleted_at.is_none());
        assert!(repo::page::get(&conn, &a2.id)
            .unwrap()
            .unwrap()
            .deleted_at
            .is_none());
        assert!(repo::page::list_trash(&conn, &ws.id).unwrap().is_empty());
        assert!(matches!(
            page::restore(&mut conn, &a.id),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn restore_keeps_independently_trashed_descendants_in_trash() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        page::delete(&mut conn, &a1.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        page::delete(&mut conn, &a.id).unwrap();
        // A1 was trashed first, so it is its own trash root.
        assert_eq!(repo::page::list_trash(&conn, &ws.id).unwrap().len(), 2);
        page::restore(&mut conn, &a.id).unwrap();
        assert!(repo::page::get(&conn, &a1.id)
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some());
        // Restoring A1 while its parent is live puts it back under A.
        let r = page::restore(&mut conn, &a1.id).unwrap();
        assert_eq!(r.parent_page_id.as_deref(), Some(a.id.as_str()));
    }

    #[test]
    fn restore_child_of_trashed_parent_goes_to_top_level() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        page::delete(&mut conn, &a1.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        page::delete(&mut conn, &a.id).unwrap();
        let r = page::restore(&mut conn, &a1.id).unwrap();
        assert!(r.parent_page_id.is_none());
        assert!(r.deleted_at.is_none());
        assert_eq!(
            titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
            ["A1"]
        );
    }

    #[test]
    fn permanent_delete_requires_trash_and_removes_everything() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "A");
        let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
        let b = new_block(&mut conn, &a1.id, None, "x");
        assert!(matches!(
            page::delete_permanent(&mut conn, &a.id),
            Err(AppError::Validation(_))
        ));
        page::delete(&mut conn, &a.id).unwrap();
        page::delete_permanent(&mut conn, &a.id).unwrap();
        assert!(repo::page::get(&conn, &a.id).unwrap().is_none());
        assert!(repo::page::get(&conn, &a1.id).unwrap().is_none());
        assert!(repo::block::get(&conn, &b.id).unwrap().is_none());
    }

    #[test]
    fn empty_trash_only_removes_trashed_pages() {
        let (mut conn, ws) = setup();
        let keep = new_page(&mut conn, &ws, None, "keep");
        let gone = new_page(&mut conn, &ws, None, "gone");
        page::delete(&mut conn, &gone.id).unwrap();
        page::empty_trash(&mut conn, &ws.id).unwrap();
        assert!(repo::page::get(&conn, &gone.id).unwrap().is_none());
        assert!(repo::page::get(&conn, &keep.id).unwrap().is_some());
    }

    #[test]
    fn favorites_exclude_trashed_pages() {
        let (mut conn, ws) = setup();
        let a = new_page(&mut conn, &ws, None, "Alpha");
        let b = new_page(&mut conn, &ws, None, "beta");
        for id in [&a.id, &b.id] {
            page::update(
                &mut conn,
                PageUpdate {
                    id: id.clone(),
                    title: None,
                    icon: None,
                    cover: None,
                    position: None,
                    favorite: Some(true),
                    archived: None,
                },
            )
            .unwrap();
        }
        assert_eq!(
            titles(&repo::page::list_favorites(&conn, &ws.id).unwrap()),
            ["Alpha", "beta"]
        );
        page::delete(&mut conn, &a.id).unwrap();
        assert_eq!(
            titles(&repo::page::list_favorites(&conn, &ws.id).unwrap()),
            ["beta"]
        );
    }

    #[test]
    fn workspace_update_and_delete_rules() {
        let (mut conn, ws) = setup();
        let u = workspace::update(
            &mut conn,
            WorkspaceUpdate {
                id: ws.id.clone(),
                name: Some("  Renamed ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(u.name, "Renamed");
        assert!(matches!(
            workspace::update(
                &mut conn,
                WorkspaceUpdate {
                    id: ws.id.clone(),
                    name: Some(" ".into()),
                    ..Default::default()
                }
            ),
            Err(AppError::Validation(_))
        ));
        // The last workspace is protected.
        assert!(matches!(
            workspace::delete(&mut conn, &ws.id),
            Err(AppError::Validation(_))
        ));
        let other = workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Other".into(),
                icon: None,
                ..Default::default()
            },
        )
        .unwrap();
        let p = new_page(&mut conn, &other, None, "inside");
        workspace::delete(&mut conn, &other.id).unwrap();
        assert!(repo::page::get(&conn, &p.id).unwrap().is_none());
        assert!(repo::workspace::get(&conn, &ws.id).unwrap().is_some());
    }

    #[test]
    fn workspace_profiles_are_atomic_validated_and_resettable() {
        let (mut conn, ws) = setup();
        let updated = workspace::update(&mut conn, WorkspaceUpdate { id: ws.id.clone(), name: Some("Studio".into()), icon: Some("symbol:code".into()), settings_json: Some(r#"{"theme":"dark","description":"Research","accent":"blue","sidebarDensity":"compact","future":42}"#.into()), ..Default::default() }).unwrap();
        assert_eq!(updated.revision, ws.revision + 1);
        assert_eq!(updated.icon.as_deref(), Some("symbol:code"));
        let cleared = workspace::update(
            &mut conn,
            WorkspaceUpdate {
                id: ws.id.clone(),
                clear_icon: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cleared.icon.is_none());
        assert!(cleared.settings_json.contains("future"));
        for json in [
            r#"{"accent":"unknown"}"#,
            r##"{"accent":"#12345678"}"##,
            r##"{"accent":"#ggg"}"##,
            r#"{"accent":"url(x)"}"#,
            r#"{"theme":42}"#,
            r#"{"sidebarDensity":"tiny"}"#,
            r#"{"autoBackup":"false"}"#,
        ] {
            assert!(workspace::update(
                &mut conn,
                WorkspaceUpdate {
                    id: ws.id.clone(),
                    name: Some("Should not stick".into()),
                    settings_json: Some(json.into()),
                    ..Default::default()
                }
            )
            .is_err());
            assert_eq!(
                repo::workspace::get(&conn, &ws.id).unwrap().unwrap().name,
                "Studio"
            );
        }
        let before = repo::workspace::count(&conn).unwrap();
        assert!(workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Bad".into(),
                settings_json: Some(r#"{"accent":"invalid"}"#.into()),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(repo::workspace::count(&conn).unwrap(), before);
        assert!(workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Bad icon".into(),
                icon: Some("x".repeat(65)),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn workspace_listing_stats_and_backup_policy_are_scoped() {
        let (mut conn, ws) = setup();
        let other = workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Other".into(),
                ..Default::default()
            },
        )
        .unwrap();
        new_page(&mut conn, &ws, None, "A");
        new_page(&mut conn, &other, None, "B");
        let p = new_page(&mut conn, &other, None, "C");
        page::delete(&mut conn, &p.id).unwrap();
        assert_eq!(repo::workspace::list(&conn).unwrap().len(), 2);
        assert_eq!(repo::workspace::stats(&conn, &ws.id).unwrap().pages, 1);
        let stats = repo::workspace::stats(&conn, &other.id).unwrap();
        assert_eq!((stats.pages, stats.trashed), (2, 1));
        let all = workspace::set_auto_backup(&mut conn, false).unwrap();
        assert!(all.iter().all(
            |w| serde_json::from_str::<serde_json::Value>(&w.settings_json).unwrap()["autoBackup"]
                == false
        ));
        for invalid in [0, 1001] {
            assert!(workspace::set_backup_policy(&mut conn, None, Some(invalid)).is_err());
        }
        let all = workspace::set_backup_policy(&mut conn, None, Some(7)).unwrap();
        assert!(all.iter().all(|w| {
            let settings: serde_json::Value = serde_json::from_str(&w.settings_json).unwrap();
            settings["backupKeep"] == 7 && settings["autoBackup"] == false
        }));
        let created = workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "New".into(),
                settings_json: Some(r#"{"accent":"green","autoBackup":true}"#.into()),
                ..Default::default()
            },
        )
        .unwrap();
        let settings: serde_json::Value = serde_json::from_str(&created.settings_json).unwrap();
        assert_eq!(settings["autoBackup"], false);
        assert_eq!(settings["backupKeep"], 7);
        assert_eq!(settings["accent"], "green");
        assert!(workspace::validate_deletion(&conn, &other.id, "Wrong").is_err());
        workspace::validate_deletion(&conn, &other.id, "Other").unwrap();
    }

    fn upsert(id: &str, parent: Option<&str>, position: f64, text: &str) -> BlockUpsert {
        BlockUpsert {
            id: id.into(),
            parent_block_id: parent.map(String::from),
            block_type: "paragraph".into(),
            position,
            data_json: format!("{{\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}"),
            schema_version: 2,
        }
    }

    fn batch(page: &Page, upserts: Vec<BlockUpsert>, deletes: &[&str]) -> BlockBatch {
        BlockBatch {
            page_id: page.id.clone(),
            upserts,
            delete_ids: deletes.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn batch_inserts_updates_and_deletes_atomically() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let (a, b, c) = (new_id(), new_id(), new_id());
        block::apply_batch(
            &mut conn,
            batch(
                &p,
                vec![upsert(&a, None, 0.0, "a"), upsert(&b, None, 1.0, "b")],
                &[],
            ),
        )
        .unwrap();
        assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
        // Update a, add c between, delete b.
        block::apply_batch(
            &mut conn,
            batch(
                &p,
                vec![upsert(&a, None, 0.0, "a2"), upsert(&c, None, 0.5, "c")],
                &[&b],
            ),
        )
        .unwrap();
        let list = repo::block::list(&conn, &p.id).unwrap();
        assert_eq!(
            list.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            [a.as_str(), c.as_str()]
        );
        let a_row = repo::block::get(&conn, &a).unwrap().unwrap();
        assert_eq!(a_row.revision, 2);
        assert!(a_row.data_json.contains("a2"));
        assert_eq!(a_row.schema_version, 2);
    }

    #[test]
    fn batch_orders_children_after_parents_and_cascades_deletes() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let (parent, child) = (new_id(), new_id());
        // Child listed first on purpose.
        block::apply_batch(
            &mut conn,
            batch(
                &p,
                vec![
                    upsert(&child, Some(&parent), 0.0, "kid"),
                    upsert(&parent, None, 0.0, "top"),
                ],
                &[],
            ),
        )
        .unwrap();
        assert_eq!(
            repo::block::get(&conn, &child)
                .unwrap()
                .unwrap()
                .parent_block_id
                .as_deref(),
            Some(parent.as_str())
        );
        block::apply_batch(&mut conn, batch(&p, vec![], &[&parent])).unwrap();
        assert!(repo::block::list(&conn, &p.id).unwrap().is_empty());
    }

    #[test]
    fn batch_can_reparent_without_losing_the_child() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let (a, b, kid) = (new_id(), new_id(), new_id());
        block::apply_batch(
            &mut conn,
            batch(
                &p,
                vec![
                    upsert(&a, None, 0.0, "a"),
                    upsert(&b, None, 1.0, "b"),
                    upsert(&kid, Some(&a), 0.0, "k"),
                ],
                &[],
            ),
        )
        .unwrap();
        // Move the child to b and delete a in the same batch.
        block::apply_batch(
            &mut conn,
            batch(&p, vec![upsert(&kid, Some(&b), 0.0, "k")], &[&a]),
        )
        .unwrap();
        let k = repo::block::get(&conn, &kid).unwrap().unwrap();
        assert_eq!(k.parent_block_id.as_deref(), Some(b.as_str()));
    }

    #[test]
    fn batch_rejects_cycles_foreign_blocks_and_bad_input() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let other = new_page(&mut conn, &ws, None, "Other");
        let (a, b) = (new_id(), new_id());
        block::apply_batch(
            &mut conn,
            batch(
                &p,
                vec![upsert(&a, None, 0.0, "a"), upsert(&b, Some(&a), 0.0, "b")],
                &[],
            ),
        )
        .unwrap();
        // a under its own child b.
        assert!(matches!(
            block::apply_batch(
                &mut conn,
                batch(&p, vec![upsert(&a, Some(&b), 0.0, "a")], &[])
            ),
            Err(AppError::Validation(_))
        ));
        // Self parent.
        assert!(matches!(
            block::apply_batch(
                &mut conn,
                batch(&p, vec![upsert(&a, Some(&a), 0.0, "a")], &[])
            ),
            Err(AppError::Validation(_))
        ));
        // Block id owned by another page.
        assert!(matches!(
            block::apply_batch(
                &mut conn,
                batch(&other, vec![upsert(&a, None, 0.0, "x")], &[])
            ),
            Err(AppError::Validation(_))
        ));
        // Missing parent never resolves.
        assert!(matches!(
            block::apply_batch(
                &mut conn,
                batch(&p, vec![upsert(&new_id(), Some(&new_id()), 0.0, "x")], &[])
            ),
            Err(AppError::Validation(_))
        ));
        let mut bad = upsert(&new_id(), None, 0.0, "x");
        bad.block_type = "embed".into();
        assert!(matches!(
            block::apply_batch(&mut conn, batch(&p, vec![bad], &[])),
            Err(AppError::Validation(_))
        ));
        let mut bad = upsert(&new_id(), None, f64::NAN, "x");
        bad.schema_version = 2;
        assert!(matches!(
            block::apply_batch(&mut conn, batch(&p, vec![bad], &[])),
            Err(AppError::Validation(_))
        ));
        let mut bad = upsert(&new_id(), None, 0.0, "x");
        bad.schema_version = 3;
        assert!(matches!(
            block::apply_batch(&mut conn, batch(&p, vec![bad], &[])),
            Err(AppError::Validation(_))
        ));
        // Nothing from the failed batches leaked in.
        assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
    }

    #[test]
    fn failed_batch_rolls_back_earlier_operations() {
        let (mut conn, ws) = setup();
        let p = new_page(&mut conn, &ws, None, "P");
        let good = new_id();
        let mut bad = upsert(&new_id(), None, 1.0, "x");
        bad.block_type = "embed".into();
        assert!(block::apply_batch(
            &mut conn,
            batch(&p, vec![upsert(&good, None, 0.0, "g"), bad], &[])
        )
        .is_err());
        assert!(repo::block::get(&conn, &good).unwrap().is_none());
        // A trashed page cannot be edited.
        page::delete(&mut conn, &p.id).unwrap();
        assert!(matches!(
            block::apply_batch(
                &mut conn,
                batch(&p, vec![upsert(&new_id(), None, 0.0, "x")], &[])
            ),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn error_serializes_as_typed_object() {
        let v = serde_json::to_value(AppError::Validation("bad".into())).unwrap();
        assert_eq!(v["code"], "validation");
        assert_eq!(v["message"], "bad");
    }
}
