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
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| AppError::Validation("invalid settings".into()))?;
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
    if value
        .get("backupKeep")
        .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=1000).contains(&n)))
    {
        return Err(AppError::Validation(
            "keep between 1 and 1000 automatic backups".into(),
        ));
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

pub fn create_with_image(
    conn: &mut Connection,
    root: &std::path::Path,
    input: WorkspaceCreate,
    file_name: &str,
    bytes: &[u8],
) -> AppResult<Workspace> {
    if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
        return Err(AppError::Validation(
            "choose an image between 1 byte and 10 MB".into(),
        ));
    }
    let name = crate::files::manage::clean_name(file_name);
    if !crate::files::mime_for(&name).starts_with("image/")
        || !crate::files::manage::looks_like_image(bytes)
    {
        return Err(AppError::Validation("choose a supported image file".into()));
    }
    let tx = conn.transaction()?;
    let mut w = create_in(
        &tx,
        WorkspaceCreate {
            icon: None,
            ..input
        },
    )?;
    let hash = crate::files::manage::import_bytes_in(&tx, root, &w.id, &name, bytes)?.hash;
    w.icon = Some(format!("image:{hash}"));
    tx.execute(
        "UPDATE workspace SET icon = ?1 WHERE id = ?2",
        rusqlite::params![w.icon, w.id],
    )?;
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
    let workspace =
        repo::workspace::get(conn, id)?.ok_or_else(|| AppError::NotFound("workspace".into()))?;
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

pub fn set_backup_policy(
    conn: &mut Connection,
    enabled: Option<bool>,
    keep: Option<usize>,
) -> AppResult<Vec<Workspace>> {
    if keep.is_some_and(|n| !(1..=1000).contains(&n)) {
        return Err(AppError::Validation(
            "keep between 1 and 1000 automatic backups".into(),
        ));
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
