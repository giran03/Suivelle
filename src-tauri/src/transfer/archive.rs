//! The portable workspace archive: a zip of plain JSON and files that can be read without
//! Suivelle and imported into any workspace as new pages and databases.
//!
//! ```text
//! manifest.json        format, version, counts
//! workspace.json       name and icon
//! pages/<id>.json      one per page, database page, record page and dashboard (with its blocks)
//! databases/<id>.json  properties, views, records (values and links) and record templates
//! attachments.json     name, type and size of each file
//! attachments/<hash>   the files themselves
//! ```
//!
//! Importing never touches what is already there: everything gets new ids and lands under one
//! new page. Ids inside the archive are only used to wire the pieces together.

use super::insert_page;
use crate::dashboards;
use crate::databases::service::{self as dbs, load_properties, load_views};
use crate::databases::{
    DatabaseCreate, PropertyCreate, RecordCreate, SetValue, ViewConfig, ViewCreate,
};
use crate::domain::{new_id, now, BlockBatch, MAX_BLOCK_DATA_BYTES};
use crate::errors::{AppError, AppResult};
use crate::files;
use crate::repositories as repo;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub const FORMAT: &str = "suivelle-archive";
pub const VERSION: u64 = 2;
const MAX_ENTRIES: usize = 300_000;
const MAX_JSON_BYTES: u64 = 256 * 1024 * 1024;

fn portable_settings(text: &str) -> Value {
    let settings: Value = serde_json::from_str(text).unwrap_or(json!({}));
    let mut out = Map::new();
    for key in [
        "description",
        "accent",
        "theme",
        "sidebarDensity",
        "templatesPageId",
        "syncedPageId",
    ] {
        if let Some(value) = settings.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

fn hash_copy(input: &mut impl Read, output: &mut impl Write) -> AppResult<(String, u64)> {
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        output.write_all(&buffer[..n])?;
        size += n as u64;
    }
    Ok((
        hash.finalize().iter().map(|b| format!("{b:02x}")).collect(),
        size,
    ))
}

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

fn zip_err(e: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!("this is not a readable archive: {e}"))
}

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub pages: usize,
    pub databases: usize,
    pub records: usize,
    pub dashboards: usize,
    pub attachments: usize,
    pub automations: usize,
}

fn put(zip: &mut ZipWriter<File>, name: &str, bytes: &[u8]) -> AppResult<()> {
    zip.start_file(
        name,
        SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(bytes.len() as u64 > u32::MAX as u64 / 2),
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;
    zip.write_all(bytes)?;
    Ok(())
}

fn put_json(zip: &mut ZipWriter<File>, name: &str, v: &Value) -> AppResult<()> {
    put(
        zip,
        name,
        &serde_json::to_vec_pretty(v).map_err(|e| AppError::Internal(e.to_string()))?,
    )
}

fn page_json(conn: &Connection, p: &crate::domain::Page) -> AppResult<Value> {
    let blocks: Vec<Value> = repo::block::list(conn, &p.id)?
        .into_iter()
        .map(|b| {
            json!({
                "id": b.id, "parentId": b.parent_block_id, "type": b.block_type, "position": b.position,
                "schemaVersion": b.schema_version,
                "data": serde_json::from_str::<Value>(&b.data_json).unwrap_or(Value::Null),
            })
        })
        .collect();
    let mut v = json!({
        "id": p.id, "parentId": p.parent_page_id, "title": p.title, "icon": p.icon, "cover": p.cover,
        "kind": p.kind, "position": p.position, "favorite": p.favorite, "archived": p.archived,
        "createdAt": p.created_at, "updatedAt": p.updated_at, "blocks": blocks,
    });
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM calendar_collection WHERE page_id=?1)",
        [&p.id],
        |r| r.get::<_, bool>(0),
    )? {
        v["calendarCollection"] = json!(true);
    }
    if p.kind == "dashboard" {
        if let Ok(d) = dashboards::get(conn, &p.id) {
            v["dashboard"] = serde_json::to_value(&d.layout).unwrap_or(Value::Null);
        }
    }
    Ok(v)
}

fn database_json(conn: &Connection, db_id: &str, page_id: &str) -> AppResult<Value> {
    let props: Vec<Value> = load_properties(conn, db_id)?
        .into_iter()
        .map(|p| json!({ "id": p.id, "name": p.name, "type": p.property_type, "config": p.config, "position": p.position }))
        .collect();
    let views: Vec<Value> = load_views(conn, db_id)?
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            let mut j = json!({ "id": v.id, "name": v.name, "type": v.view_type, "config": v.config, "position": i });
            if v.view_type == "canvas" {
                if let Ok(c) = crate::databases::canvas::export_json(conn, &v.id) {
                    j["canvas"] = c;
                }
            }
            j
        })
        .collect();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.page_id, r.unique_id, r.created_at FROM db_record r JOIN page p ON p.id = r.page_id
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id",
    )?;
    let recs: Vec<(String, String, i64, String)> = stmt
        .query_map([db_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut records = Vec::new();
    for (id, page, uid, created) in recs {
        let mut values = Map::new();
        let mut v =
            conn.prepare("SELECT property_id, value_json FROM db_value WHERE record_id = ?1")?;
        for row in v.query_map([&id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (pid, vj) = row?;
            values.insert(pid, serde_json::from_str(&vj).unwrap_or(Value::Null));
        }
        let mut links: Map<String, Value> = Map::new();
        let mut l = conn.prepare("SELECT property_id, to_record_id FROM db_relation WHERE from_record_id = ?1 ORDER BY property_id, position")?;
        for row in l.query_map([&id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (pid, to) = row?;
            links
                .entry(pid)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .expect("array")
                .push(json!(to));
        }
        records.push(json!({ "id": id, "pageId": page, "uniqueId": uid, "createdAt": created, "values": values, "links": links }));
    }
    let templates: Vec<Value> = super::super::databases::record_templates::list(conn, db_id)?
        .into_iter()
        .map(|t| {
            let body: Value = conn
                .query_row("SELECT body_json FROM db_record_template WHERE id = ?1", [&t.id], |r| r.get::<_, String>(0))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(json!([]));
            json!({ "id": t.id, "name": t.name, "title": t.title, "values": t.values, "body": body, "isDefault": t.is_default })
        })
        .collect();
    Ok(
        json!({ "id": db_id, "pageId": page_id, "properties": props, "views": views, "records": records, "templates": templates }),
    )
}

/// Writes the whole workspace (everything not in the trash) to `dest`. The file appears only
/// when it is complete.
pub fn export_workspace(
    conn: &Connection,
    store_root: &Path,
    workspace_id: &str,
    dest: &Path,
) -> AppResult<Counts> {
    let ws = repo::workspace::get(conn, workspace_id)?
        .ok_or_else(|| AppError::NotFound("workspace".into()))?;
    let part = dest.with_extension(format!("{}.part", new_id()));
    let result = (|| -> AppResult<Counts> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)?;
        let mut zip = ZipWriter::new(file);
        let mut counts = Counts::default();
        let mut stmt = conn.prepare("SELECT id FROM page WHERE workspace_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id")?;
        let ids: Vec<String> = stmt
            .query_map([workspace_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        for id in &ids {
            let Some(p) = repo::page::get(conn, id)? else {
                continue;
            };
            match p.kind.as_str() {
                "record" => counts.records += 1,
                "database" => counts.databases += 1,
                "dashboard" => counts.dashboards += 1,
                _ => counts.pages += 1,
            }
            put_json(&mut zip, &format!("pages/{id}.json"), &page_json(conn, &p)?)?;
        }
        let mut stmt = conn.prepare("SELECT d.id, d.page_id FROM db_database d JOIN page p ON p.id = d.page_id WHERE d.workspace_id = ?1 AND p.deleted_at IS NULL")?;
        let dbs_list: Vec<(String, String)> = stmt
            .query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        for (db, page) in &dbs_list {
            put_json(
                &mut zip,
                &format!("databases/{db}.json"),
                &database_json(conn, db, page)?,
            )?;
        }
        let mut automations = Vec::new();
        for (db, _) in &dbs_list {
            for automation in crate::automation::list(conn, db)? {
                automations.push(
                    serde_json::to_value(automation)
                        .map_err(|e| AppError::Internal(e.to_string()))?,
                );
            }
        }
        counts.automations = automations.len();
        put_json(&mut zip, "automations.json", &json!(automations))?;
        let boards = crate::databases::canvas::list_boards(conn, &ws.id)?
            .iter()
            .map(|b| crate::databases::canvas::export_board_json(conn, &b.id))
            .collect::<AppResult<Vec<Value>>>()?;
        if !boards.is_empty() {
            put_json(&mut zip, "canvases.json", &json!(boards))?;
        }
        let mut stmt = conn.prepare(
            "SELECT hash, original_name, mime_type, size FROM attachment WHERE workspace_id = ?1",
        )?;
        let atts: Vec<(String, String, String, i64)> = stmt
            .query_map([workspace_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        let mut listed = Vec::new();
        for (hash, name, mime, size) in atts {
            let blob = files::blob_path(store_root, &hash);
            let mut f = File::open(&blob).map_err(|e| {
                AppError::Validation(format!(
                    "The file “{name}” is missing or unreadable: {e}. Restore it before exporting."
                ))
            })?;
            zip.start_file(
                format!("attachments/{hash}"),
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .large_file(size > i64::from(u32::MAX) / 2),
            )
            .map_err(|e| AppError::Internal(e.to_string()))?;
            let (got, copied) = hash_copy(&mut f, &mut zip)?;
            if got != hash || copied != size as u64 {
                return bad(format!("The file “{name}” does not match its checksum or size. Restore it before exporting."));
            }
            listed.push(json!({ "hash": hash, "name": name, "mime": mime, "size": size }));
            counts.attachments += 1;
        }
        put_json(&mut zip, "attachments.json", &Value::Array(listed))?;
        put_json(
            &mut zip,
            "workspace.json",
            &json!({ "name": ws.name, "icon": ws.icon, "settings": portable_settings(&ws.settings_json) }),
        )?;
        put_json(
            &mut zip,
            "manifest.json",
            &json!({
                "format": FORMAT, "version": VERSION, "appVersion": env!("CARGO_PKG_VERSION"),
                "schemaVersion": crate::database::latest_version(), "createdAt": now(),
                "workspaceName": ws.name, "counts": counts,
            }),
        )?;
        zip.finish()
            .map_err(|e| AppError::Internal(e.to_string()))?
            .sync_all()?;
        Archive::open(&part)?.validate()?;
        Ok(counts)
    })();
    match result {
        Ok(c) => {
            if let Err(e) = std::fs::rename(&part, dest) {
                let _ = std::fs::remove_file(&part);
                return Err(e.into());
            }
            Ok(c)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

pub struct Archive {
    zip: ZipArchive<File>,
    names: HashSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub app_version: String,
    pub created_at: String,
    pub workspace_name: String,
    pub counts: Counts,
    pub workspace_icon: Option<String>,
    pub settings: Value,
}

fn clean_name(n: &str) -> bool {
    !n.is_empty()
        && !n.starts_with('/')
        && !n.contains('\\')
        && !n.contains(':')
        && !n.split('/').any(|c| c == ".." || c == ".")
}

impl Archive {
    pub fn open(path: &Path) -> AppResult<Archive> {
        let zip = ZipArchive::new(File::open(path)?).map_err(zip_err)?;
        if zip.len() > MAX_ENTRIES {
            return bad("this archive has too many files");
        }
        let names: HashSet<String> = zip
            .file_names()
            .filter(|n| clean_name(n))
            .map(String::from)
            .collect();
        Ok(Archive { zip, names })
    }

    fn json(&mut self, name: &str) -> AppResult<Value> {
        if !self.names.contains(name) {
            return bad(format!("the archive is missing {name}"));
        }
        let entry = self.zip.by_name(name).map_err(zip_err)?;
        if entry.size() > MAX_JSON_BYTES {
            return bad(format!("{name} is too large"));
        }
        let mut buf = Vec::new();
        entry.take(MAX_JSON_BYTES + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > MAX_JSON_BYTES {
            return bad(format!("{name} is too large"));
        }
        serde_json::from_slice(&buf)
            .map_err(|e| AppError::Validation(format!("{name} is not valid: {e}")))
    }

    fn list(&self, prefix: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .names
            .iter()
            .filter(|n| n.starts_with(prefix) && n.ends_with(".json"))
            .cloned()
            .collect();
        v.sort();
        v
    }

    /// Checks the manifest and counts what is inside.
    pub fn info(&mut self) -> AppResult<Info> {
        let m = self.json("manifest.json")?;
        if !matches!(
            m.get("format").and_then(Value::as_str),
            Some(FORMAT) | Some(crate::legacy::ARCHIVE_FORMAT)
        ) {
            return bad("this is not a Suivelle archive");
        }
        let version = m.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version == 0 || version > VERSION {
            return bad(
                "this archive was made by a newer version of Suivelle; update the app to import it",
            );
        }
        let n = |k: &str| {
            m.pointer(&format!("/counts/{k}"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize
        };
        Ok(Info {
            app_version: m
                .get("appVersion")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            created_at: m
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            workspace_name: m
                .get("workspaceName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            counts: Counts {
                pages: n("pages"),
                databases: n("databases"),
                records: n("records"),
                dashboards: n("dashboards"),
                attachments: n("attachments"),
                automations: n("automations"),
            },
            workspace_icon: if self.names.contains("workspace.json") {
                self.json("workspace.json")?["icon"]
                    .as_str()
                    .map(String::from)
            } else {
                None
            },
            settings: if self.names.contains("workspace.json") {
                self.json("workspace.json")?
                    .get("settings")
                    .cloned()
                    .unwrap_or(json!({}))
            } else {
                json!({})
            },
        })
    }

    /// Preflight a complete workspace transfer without changing the database or blob store.
    pub fn validate(&mut self) -> AppResult<()> {
        if self.zip.file_names().any(|n| !clean_name(n)) || self.names.len() != self.zip.len() {
            return bad("The archive contains unsafe or duplicate file names.");
        }
        let info = self.info()?;
        let manifest = self.json("manifest.json")?;
        let mut ids = HashSet::new();
        let mut pages = HashMap::new();
        let mut counts = Counts::default();
        for name in self.list("pages/") {
            let page = self.json(&name)?;
            let id = s(&page, "id");
            if id.is_empty() || !ids.insert(id.to_string()) {
                return bad("The archive contains missing or duplicate page IDs.");
            }
            match s(&page, "kind") {
                "page" => counts.pages += 1,
                "database" => counts.databases += 1,
                "record" => counts.records += 1,
                "dashboard" => counts.dashboards += 1,
                _ => {
                    return bad(format!(
                        "Unsupported page type in {name}. Update Suivelle before importing."
                    ))
                }
            }
            let blocks = page["blocks"]
                .as_array()
                .ok_or_else(|| AppError::Validation(format!("{name} is missing its blocks.")))?;
            for block in blocks {
                if s(block, "id").is_empty() || !ids.insert(s(block, "id").to_string()) {
                    return bad("The archive contains missing or duplicate block IDs.");
                }
                if !crate::domain::BLOCK_TYPES.contains(&s(block, "type")) {
                    return bad(format!(
                        "Unsupported block type “{}”. Update Suivelle before importing.",
                        s(block, "type")
                    ));
                }
                if block["data"].to_string().len() > MAX_BLOCK_DATA_BYTES {
                    return bad("The archive contains a block that is too large to import.");
                }
            }
            pages.insert(id.to_string(), page);
        }
        for (id, page) in &pages {
            let mut seen = HashSet::from([id.as_str()]);
            let mut parent = page.get("parentId").and_then(Value::as_str);
            while let Some(p) = parent {
                if !seen.insert(p) {
                    return bad("The archive contains a circular page hierarchy.");
                }
                let Some(next) = pages.get(p) else {
                    break;
                }; // A trashed parent is excluded from portable archives.
                parent = next.get("parentId").and_then(Value::as_str);
            }
        }
        let mut db_pages = HashSet::new();
        for name in self.list("databases/") {
            let db = self.json(&name)?;
            if !db_pages.insert(s(&db, "pageId").to_string())
                || pages
                    .get(s(&db, "pageId"))
                    .is_none_or(|p| s(p, "kind") != "database")
            {
                return bad("A database definition does not match its page.");
            }
            for record in db["records"]
                .as_array()
                .ok_or_else(|| AppError::Validation(format!("{name} is missing its records.")))?
            {
                if pages
                    .get(s(record, "pageId"))
                    .is_none_or(|p| s(p, "kind") != "record")
                {
                    return bad("A record is missing its page.");
                }
            }
            for view in db["views"]
                .as_array()
                .ok_or_else(|| AppError::Validation(format!("{name} is missing its views.")))?
            {
                serde_json::from_value::<ViewConfig>(view["config"].clone()).map_err(|e| {
                    AppError::Validation(format!("A view configuration is invalid: {e}"))
                })?;
            }
            // File references inside template bodies are checked after the attachment list.
        }
        if db_pages.len() != counts.databases {
            return bad("A database is missing its definition.");
        }
        let attachments = if self.names.contains("attachments.json") {
            self.json("attachments.json")?
        } else {
            json!([])
        };
        let mut hashes = HashSet::new();
        for attachment in attachments
            .as_array()
            .ok_or_else(|| AppError::Validation("Invalid attachment list.".into()))?
        {
            let hash = s(attachment, "hash");
            if !files::is_hash(hash) || !hashes.insert(hash.to_string()) {
                return bad("Invalid or duplicate attachment checksum.");
            }
            let entry = format!("attachments/{hash}");
            if !self.names.contains(&entry) {
                return bad(format!(
                    "The archive is missing the file “{}”.",
                    s(attachment, "name")
                ));
            }
            let mut file = self.zip.by_name(&entry).map_err(zip_err)?;
            if file.size() > files::MAX_ATTACHMENT_BYTES {
                return bad("An attachment exceeds the supported file size.");
            }
            let (got, size) = hash_copy(&mut file, &mut std::io::sink())?;
            if got != hash || attachment["size"].as_u64() != Some(size) {
                return bad(format!(
                    "The file “{}” does not match its checksum or size.",
                    s(attachment, "name")
                ));
            }
            counts.attachments += 1;
        }
        if let Some(hash) = info
            .workspace_icon
            .as_deref()
            .and_then(|i| i.strip_prefix("image:"))
        {
            if !hashes.contains(hash) {
                return bad("The workspace icon is missing its image.");
            }
        }
        for page in pages.values() {
            for field in ["cover", "icon"] {
                if let Some(hash) = page[field].as_str().and_then(|c| c.strip_prefix("image:")) {
                    if !hashes.contains(hash) {
                        return bad(format!("A page {field} is missing its image."));
                    }
                }
            }
            validate_files(&page["blocks"], &hashes)?;
        }
        for name in self.list("databases/") {
            validate_files(&self.json(&name)?, &hashes)?;
        }
        if self.names.contains("automations.json") {
            let automation_list = self.json("automations.json")?;
            for automation in automation_list
                .as_array()
                .ok_or_else(|| AppError::Validation("Invalid automation list.".into()))?
            {
                serde_json::from_value::<crate::automation::AutomationSave>(automation.clone())
                    .map_err(|e| AppError::Validation(format!("An automation is invalid: {e}")))?;
                counts.automations += 1;
            }
        }
        if manifest["version"].as_u64().unwrap_or(1) >= 2
            && serde_json::to_value(&counts).ok() != serde_json::to_value(&info.counts).ok()
        {
            return bad("The archive's contents do not match its manifest counts.");
        }
        Ok(())
    }
}

fn validate_files(value: &Value, hashes: &HashSet<String>) -> AppResult<()> {
    match value {
        Value::Array(list) => {
            for item in list {
                validate_files(item, hashes)?;
            }
        }
        Value::Object(object) => {
            if let Some(text) = object.get("dataJson").and_then(Value::as_str) {
                let data: Value = serde_json::from_str(text).map_err(|e| {
                    AppError::Validation(format!("Invalid template block data: {e}"))
                })?;
                validate_files(&data, hashes)?;
            }
            if let Some(attachment) = object.get("attachment").filter(|v| v.is_object()) {
                if !hashes.contains(s(attachment, "hash")) {
                    return bad("A block or template references a missing file.");
                }
            }
            for v in object.values() {
                validate_files(v, hashes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn remap_files(value: &mut Value, files: &HashMap<String, Value>) {
    match value {
        Value::Array(list) => {
            for item in list {
                remap_files(item, files);
            }
        }
        Value::Object(object) => {
            if let Some(value) = object.get_mut("dataJson") {
                if let Some(mut data) = value
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                {
                    remap_files(&mut data, files);
                    *value = json!(data.to_string());
                }
            }
            if let Some(attachment) = object.get_mut("attachment").filter(|v| v.is_object()) {
                *attachment = files
                    .get(s(attachment, "hash"))
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            for v in object.values_mut() {
                remap_files(v, files);
            }
        }
        _ => {}
    }
}

fn remap(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some(n) = map.get(s.as_str()) {
                *s = n.clone();
            } else if let Some(link) = crate::legacy::page_target(s) {
                let (page, suffix) = link
                    .split_once('#')
                    .map_or((link, ""), |(p, _)| (p, &link[p.len()..]));
                if let Some(n) = map.get(page) {
                    let anchor = suffix.strip_prefix('#').and_then(|old| map.get(old));
                    *s = format!(
                        "suivelle://page/{n}{}",
                        anchor
                            .map(|b| format!("#{b}"))
                            .unwrap_or_else(|| suffix.into())
                    );
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| remap(x, map)),
        Value::Object(o) => {
            let old = std::mem::take(o);
            for (k, mut x) in old {
                if k == "dataJson" {
                    if let Some(mut data) = x
                        .as_str()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    {
                        remap(&mut data, map);
                        x = json!(data.to_string());
                    }
                } else {
                    remap(&mut x, map);
                }
                o.insert(map.get(&k).cloned().unwrap_or(k), x);
            }
        }
        _ => {}
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub pages: usize,
    pub databases: usize,
    pub records: usize,
    pub dashboards: usize,
    pub attachments: usize,
    pub automations: usize,
    pub warnings: Vec<String>,
}

struct Db {
    json: Value,
    new_id: String,
}

/// Merges an archive into a workspace under `container`. Everything is created inside the
/// caller's transaction; attachments are stored as they are read.
pub fn apply(
    tx: &Connection,
    store_root: &Path,
    workspace_id: &str,
    container: &str,
    archive: &mut Archive,
) -> AppResult<Stats> {
    apply_in(tx, store_root, workspace_id, Some(container), archive)
}

fn apply_in(
    tx: &Connection,
    store_root: &Path,
    workspace_id: &str,
    container: Option<&str>,
    archive: &mut Archive,
) -> AppResult<Stats> {
    archive.info()?;
    let mut st = Stats::default();
    let warn = |st: &mut Stats, msg: String| {
        if st.warnings.len() < 50 {
            st.warnings.push(msg);
        }
    };

    // ---- attachments ----
    let mut att_map: HashMap<String, Value> = HashMap::new();
    if archive.names.contains("attachments.json") {
        let list = archive.json("attachments.json")?;
        for a in list.as_array().cloned().unwrap_or_default() {
            let hash = s(&a, "hash").to_string();
            let entry = format!("attachments/{hash}");
            if !files::is_hash(&hash) || !archive.names.contains(&entry) {
                continue;
            }
            let mut e = archive.zip.by_name(&entry).map_err(zip_err)?;
            let (got, size) = files::store_reader(store_root, &mut e, files::MAX_ATTACHMENT_BYTES)?;
            if got != hash {
                warn(
                    &mut st,
                    format!(
                        "“{}” did not match its checksum and was skipped",
                        s(&a, "name")
                    ),
                );
                continue;
            }
            let name = s(&a, "name");
            let mime = s(&a, "mime");
            let row = files::insert_attachment_in(
                tx,
                workspace_id,
                &hash,
                name,
                if mime.is_empty() {
                    "application/octet-stream"
                } else {
                    mime
                },
                size,
            )?;
            att_map.insert(hash.clone(), json!({ "id": row.id, "hash": hash, "name": row.original_name, "mime": row.mime_type, "size": row.size }));
            st.attachments += 1;
        }
    }

    // ---- read every page ----
    let mut pages: Vec<Value> = Vec::new();
    for name in archive.list("pages/") {
        pages.push(archive.json(&name)?);
    }
    let by_old: HashMap<String, usize> = pages
        .iter()
        .enumerate()
        .map(|(i, p)| (s(p, "id").to_string(), i))
        .collect();
    let depth_of = |start: &str| -> usize {
        let mut cur = start.to_string();
        let mut d = 0;
        while let Some(parent) = by_old
            .get(&cur)
            .and_then(|i| pages[*i].get("parentId"))
            .and_then(Value::as_str)
        {
            if !by_old.contains_key(parent) || d > 64 {
                break;
            }
            cur = parent.to_string();
            d += 1;
        }
        d
    };
    let mut order: Vec<usize> = (0..pages.len())
        .filter(|i| !matches!(s(&pages[*i], "kind"), "record" | "dashboard"))
        .collect();
    order.sort_by_key(|i| depth_of(s(&pages[*i], "id")));

    let mut db_files: HashMap<String, Value> = HashMap::new();
    for name in archive.list("databases/") {
        let v = archive.json(&name)?;
        db_files.insert(s(&v, "pageId").to_string(), v);
    }

    // ---- pages and empty databases ----
    let mut canvas_work: Vec<(String, Value)> = Vec::new();
    let mut id_map: HashMap<String, String> = HashMap::new(); // pages, records, properties, views, databases, blocks, templates
    for p in &pages {
        for b in p["blocks"].as_array().cloned().unwrap_or_default() {
            id_map.insert(s(&b, "id").to_string(), new_id());
        }
    }
    let mut dbs_in: Vec<Db> = Vec::new();
    for &i in &order {
        let p = &pages[i];
        let old = s(p, "id").to_string();
        let parent = p
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|pp| id_map.get(pp).cloned())
            .or_else(|| container.map(String::from));
        let title = s(p, "title").chars().take(500).collect::<String>();
        let icon = p.get("icon").and_then(Value::as_str);
        if s(p, "kind") == "database" {
            let Some(dbj) = db_files.remove(&old) else {
                warn(
                    &mut st,
                    format!("The database “{title}” has no data in the archive and was skipped"),
                );
                continue;
            };
            let title_prop = dbj["properties"]
                .as_array()
                .and_then(|a| a.iter().find(|x| s(x, "type") == "title"))
                .map_or("Name", |x| s(x, "name"))
                .to_string();
            let made = dbs::create_database_empty_in(
                tx,
                DatabaseCreate {
                    workspace_id: workspace_id.into(),
                    parent_page_id: parent,
                    title: Some(title),
                },
                &title_prop,
            )?;
            if icon.is_some() {
                tx.execute(
                    "UPDATE page SET icon = ?2, favorite = ?3 WHERE id = ?1",
                    params![
                        made.page.id,
                        icon,
                        p.get("favorite").and_then(Value::as_bool).unwrap_or(false) as i64
                    ],
                )?;
            }
            id_map.insert(old.clone(), made.page.id.clone());
            id_map.insert(s(&dbj, "id").to_string(), made.database.id.clone());
            if let Some(tp) = dbj["properties"]
                .as_array()
                .and_then(|a| a.iter().find(|x| s(x, "type") == "title"))
            {
                if let Some(np) = load_properties(tx, &made.database.id)?
                    .into_iter()
                    .find(|x| x.property_type == "title")
                {
                    id_map.insert(s(tp, "id").to_string(), np.id);
                }
            }
            dbs_in.push(Db {
                json: dbj,
                new_id: made.database.id.clone(),
            });
            st.databases += 1;
        } else {
            let made = insert_page(
                tx,
                None,
                workspace_id,
                parent.as_deref(),
                &title,
                icon,
                "page",
                p.get("favorite").and_then(Value::as_bool).unwrap_or(false),
            )?;
            if p.get("calendarCollection")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                tx.execute(
                    "INSERT INTO calendar_collection(page_id,workspace_id) VALUES(?1,?2)",
                    params![made.id, workspace_id],
                )?;
            }
            id_map.insert(old, made.id);
            st.pages += 1;
        }
    }

    // ---- properties: plain ones, then relations, rollups and formulas ----
    let plain = |t: &str| !matches!(t, "title" | "relation" | "rollup" | "formula");
    let props_of = |d: &Db| -> Vec<Value> {
        let mut v = d.json["properties"].as_array().cloned().unwrap_or_default();
        v.sort_by(|a, b| {
            a["position"]
                .as_f64()
                .partial_cmp(&b["position"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        v
    };
    for d in &dbs_in {
        for p in props_of(d).iter().filter(|p| plain(s(p, "type"))) {
            match dbs::add_property_in(
                tx,
                PropertyCreate {
                    database_id: d.new_id.clone(),
                    name: s(p, "name").into(),
                    property_type: s(p, "type").into(),
                    config: p.get("config").cloned(),
                },
            ) {
                Ok(np) => {
                    id_map.insert(s(p, "id").to_string(), np.id);
                }
                Err(e) => warn(
                    &mut st,
                    format!("Property “{}” was skipped: {e}", s(p, "name")),
                ),
            }
        }
    }
    let mut handled: HashSet<String> = HashSet::new();
    for d in &dbs_in {
        let all = props_of(d);
        for p in all.iter().filter(|p| s(p, "type") == "relation") {
            let old = s(p, "id").to_string();
            if handled.contains(&old) {
                continue;
            }
            let target = s(&p["config"], "targetDatabaseId");
            let Some(target_new) = id_map.get(target).cloned() else {
                warn(
                    &mut st,
                    format!(
                        "The relation “{}” points outside the archive and was skipped",
                        s(p, "name")
                    ),
                );
                continue;
            };
            let reverse_old = p["config"]
                .get("reverseId")
                .and_then(Value::as_str)
                .map(String::from);
            let reverse_name = reverse_old.as_ref().and_then(|r| {
                dbs_in
                    .iter()
                    .flat_map(props_of)
                    .find(|x| s(x, "id") == r)
                    .map(|x| s(&x, "name").to_string())
            });
            let config = json!({ "targetDatabaseId": target_new, "twoWay": reverse_old.is_some(), "reverseName": reverse_name });
            match dbs::add_property_in(
                tx,
                PropertyCreate {
                    database_id: d.new_id.clone(),
                    name: s(p, "name").into(),
                    property_type: "relation".into(),
                    config: Some(config),
                },
            ) {
                Ok(np) => {
                    id_map.insert(old.clone(), np.id.clone());
                    handled.insert(old);
                    if let (Some(r), Some(nr)) = (
                        reverse_old,
                        np.config.get("reverseId").and_then(Value::as_str),
                    ) {
                        id_map.insert(r.clone(), nr.to_string());
                        handled.insert(r);
                    }
                }
                Err(e) => warn(
                    &mut st,
                    format!("The relation “{}” was skipped: {e}", s(p, "name")),
                ),
            }
        }
    }
    for kind in ["rollup", "formula"] {
        let mut todo: Vec<(usize, Value)> = Vec::new();
        for (di, d) in dbs_in.iter().enumerate() {
            todo.extend(
                props_of(d)
                    .into_iter()
                    .filter(|p| s(p, "type") == kind)
                    .map(|p| (di, p)),
            );
        }
        // A formula can use another formula, so keep trying while progress is made.
        for _ in 0..4 {
            let mut left = Vec::new();
            for (di, p) in todo {
                let mut config = p.get("config").cloned().unwrap_or(Value::Null);
                remap(&mut config, &id_map);
                match dbs::add_property_in(
                    tx,
                    PropertyCreate {
                        database_id: dbs_in[di].new_id.clone(),
                        name: s(&p, "name").into(),
                        property_type: kind.into(),
                        config: Some(config),
                    },
                ) {
                    Ok(np) => {
                        id_map.insert(s(&p, "id").to_string(), np.id);
                    }
                    Err(_) => left.push((di, p)),
                }
            }
            todo = left;
            if todo.is_empty() {
                break;
            }
        }
        for (_, p) in todo {
            warn(
                &mut st,
                format!(
                    "The {kind} “{}” could not be recreated and was skipped",
                    s(&p, "name")
                ),
            );
        }
    }

    // Properties such as buttons can refer to records and templates, which are created later.
    // Refresh every property configuration once the complete ID map exists below.

    // ---- views ----
    for d in &dbs_in {
        let old_default: Vec<String> = load_views(tx, &d.new_id)?
            .into_iter()
            .map(|v| v.id)
            .collect();
        let mut views = d.json["views"].as_array().cloned().unwrap_or_default();
        views.sort_by(|a, b| {
            a["position"]
                .as_f64()
                .partial_cmp(&b["position"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut made = 0;
        for v in views {
            let mut config = v.get("config").cloned().unwrap_or(Value::Null);
            remap(&mut config, &id_map);
            let cfg: ViewConfig = serde_json::from_value(config)
                .map_err(|e| AppError::Validation(format!("Invalid view configuration: {e}")))?;
            match dbs::create_view_in(
                tx,
                ViewCreate {
                    database_id: d.new_id.clone(),
                    name: Some(s(&v, "name").into()),
                    view_type: s(&v, "type").into(),
                    config: Some(cfg),
                },
            ) {
                Ok(nv) => {
                    if let Some(c) = v.get("canvas") {
                        canvas_work.push((nv.id.clone(), c.clone()));
                    }
                    id_map.insert(s(&v, "id").to_string(), nv.id);
                    made += 1;
                }
                Err(e) => warn(
                    &mut st,
                    format!("The view “{}” was skipped: {e}", s(&v, "name")),
                ),
            }
        }
        if made > 0 {
            for id in old_default {
                tx.execute("DELETE FROM db_view WHERE id = ?1", [id])?;
            }
        }
    }

    // ---- records ----
    let mut record_pages: HashMap<String, Value> = HashMap::new();
    for p in &pages {
        if s(p, "kind") == "record" {
            record_pages.insert(s(p, "id").to_string(), p.clone());
        }
    }
    let mut link_work: Vec<(String, String, Vec<String>)> = Vec::new();
    for d in &dbs_in {
        let props = load_properties(tx, &d.new_id)?;
        let mut recs = d.json["records"].as_array().cloned().unwrap_or_default();
        recs.sort_by_key(|r| r["uniqueId"].as_i64().unwrap_or(0));
        for r in recs {
            let title = record_pages
                .get(s(&r, "pageId"))
                .map(|p| s(p, "title").chars().take(500).collect::<String>())
                .unwrap_or_default();
            let mut values = Map::new();
            if let Some(o) = r["values"].as_object() {
                for (pid, v) in o {
                    let Some(np) = id_map.get(pid) else { continue };
                    if props.iter().any(|p| {
                        &p.id == np
                            && !crate::databases::values::is_computed(&p.property_type)
                            && p.property_type != "relation"
                            && p.property_type != "title"
                    }) {
                        values.insert(np.clone(), v.clone());
                    }
                }
            }
            let row = match dbs::create_record_in(
                tx,
                RecordCreate {
                    database_id: d.new_id.clone(),
                    title: Some(title.clone()),
                    values: values.clone(),
                    template_id: None,
                },
            ) {
                Ok(row) => row,
                Err(_) => {
                    // A value that no longer fits must not lose the record.
                    warn(&mut st, format!("Some values of “{title}” were skipped"));
                    dbs::create_record_in(
                        tx,
                        RecordCreate {
                            database_id: d.new_id.clone(),
                            title: Some(title),
                            values: Map::new(),
                            template_id: None,
                        },
                    )?
                }
            };
            id_map.insert(s(&r, "id").to_string(), row.id.clone());
            id_map.insert(s(&r, "pageId").to_string(), row.page_id.clone());
            if let Some(o) = r["links"].as_object() {
                for (pid, ids) in o {
                    link_work.push((
                        row.id.clone(),
                        pid.clone(),
                        ids.as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(Value::as_str)
                                    .map(String::from)
                                    .collect()
                            })
                            .unwrap_or_default(),
                    ));
                }
            }
            st.records += 1;
        }
    }
    for (record, pid, targets) in link_work {
        let (Some(np), ids) = (
            id_map.get(&pid),
            targets
                .iter()
                .filter_map(|t| id_map.get(t).cloned())
                .collect::<Vec<_>>(),
        ) else {
            continue;
        };
        if ids.is_empty() {
            continue;
        }
        if let Err(e) = dbs::set_value_in(
            tx,
            SetValue {
                record_id: record,
                property_id: np.clone(),
                value: json!(ids),
            },
        ) {
            warn(&mut st, format!("A relation link was skipped: {e}"));
        }
    }

    // ---- canvas layouts (need the imported record ids) ----
    for (view_id, data) in canvas_work {
        let ops = crate::databases::canvas::import_ops(&data, &|old| id_map.get(old).cloned());
        if let Err(e) = crate::databases::canvas::apply_in(tx, &view_id, &ops) {
            warn(&mut st, format!("A canvas layout was skipped: {e}"));
        }
    }

    // ---- record templates ----
    for d in &dbs_in {
        let mut position = 0.0;
        for t in d.json["templates"].as_array().cloned().unwrap_or_default() {
            position += 1.0;
            let template_id = new_id();
            id_map.insert(s(&t, "id").into(), template_id.clone());
            let mut values = t.get("values").cloned().unwrap_or(json!({}));
            remap(&mut values, &id_map);
            let mut body = t.get("body").cloned().unwrap_or(json!([]));
            remap(&mut body, &id_map);
            remap_files(&mut body, &att_map);
            tx.execute(
                "INSERT INTO db_record_template (id, database_id, name, title, values_json, body_json, is_default, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![template_id, d.new_id, s(&t, "name"), s(&t, "title"), values.to_string(), body.to_string(), t.get("isDefault").and_then(Value::as_bool).unwrap_or(false) as i64, position, now()],
            )?;
        }
    }

    // ---- dashboards ----
    for p in pages.iter().filter(|p| s(p, "kind") == "dashboard") {
        let parent = p
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|pp| id_map.get(pp).cloned())
            .or_else(|| container.map(String::from));
        let made = insert_page(
            tx,
            None,
            workspace_id,
            parent.as_deref(),
            &s(p, "title").chars().take(500).collect::<String>(),
            p.get("icon").and_then(Value::as_str),
            "dashboard",
            false,
        )?;
        let mut layout = p.get("dashboard").cloned().unwrap_or(json!({}));
        remap(&mut layout, &id_map);
        let layout: dashboards::Layout = serde_json::from_value(layout)
            .map_err(|e| AppError::Validation(format!("Invalid dashboard: {e}")))?;
        let layout = dashboards::normalize(layout)?;
        tx.execute(
            "INSERT INTO dashboard (page_id, workspace_id, layout_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![made.id, workspace_id, serde_json::to_string(&layout).unwrap_or_else(|_| "{}".into()), now()],
        )?;
        id_map.insert(s(p, "id").to_string(), made.id);
        st.dashboards += 1;
    }

    // ---- blocks, now that every page has its new id ----
    for p in &pages {
        if matches!(s(p, "kind"), "dashboard") {
            continue;
        }
        let Some(page_id) = id_map.get(s(p, "id")).cloned() else {
            continue;
        };
        let blocks = p["blocks"].as_array().cloned().unwrap_or_default();
        let mut upserts = Vec::new();
        for b in &blocks {
            let kind = s(b, "type");
            if !crate::domain::BLOCK_TYPES.contains(&kind) {
                warn(
                    &mut st,
                    format!("Unsupported block type “{kind}” was skipped"),
                );
                continue;
            }
            let mut data = b.get("data").cloned().unwrap_or(json!({}));
            remap_files(&mut data, &att_map);
            remap(&mut data, &id_map);
            let text = data.to_string();
            if text.len() > MAX_BLOCK_DATA_BYTES {
                warn(
                    &mut st,
                    format!("A very large block on “{}” was skipped", s(p, "title")),
                );
                continue;
            }
            upserts.push(crate::domain::BlockUpsert {
                id: id_map[s(b, "id")].clone(),
                parent_block_id: b
                    .get("parentId")
                    .and_then(Value::as_str)
                    .and_then(|x| id_map.get(x).cloned()),
                block_type: kind.into(),
                position: b["position"]
                    .as_f64()
                    .filter(|x| x.is_finite())
                    .unwrap_or(0.0),
                data_json: text,
                schema_version: b["schemaVersion"].as_i64().unwrap_or(2),
            });
        }
        for chunk in upserts.chunks(4000) {
            crate::services::block::apply_batch_in(
                tx,
                &BlockBatch {
                    page_id: page_id.clone(),
                    upserts: chunk
                        .iter()
                        .map(|u| crate::domain::BlockUpsert {
                            id: u.id.clone(),
                            parent_block_id: u.parent_block_id.clone(),
                            block_type: u.block_type.clone(),
                            position: u.position,
                            data_json: u.data_json.clone(),
                            schema_version: u.schema_version,
                        })
                        .collect(),
                    delete_ids: vec![],
                },
            )?;
        }
    }

    // Restore page metadata and hierarchy only after all page kinds have their new IDs.
    for p in &pages {
        if let Some(id) = id_map.get(s(p, "id")) {
            let parent = p["parentId"]
                .as_str()
                .and_then(|old| id_map.get(old).map(String::as_str))
                .or(container);
            tx.execute("UPDATE page SET parent_page_id = ?2, icon = ?3, cover = ?4, favorite = ?5, archived = ?6, position = ?7 WHERE id = ?1",
                params![id, parent, p["icon"].as_str(), p["cover"].as_str(), p["favorite"].as_bool().unwrap_or(false), p["archived"].as_bool().unwrap_or(false), p["position"].as_f64().filter(|x| x.is_finite()).unwrap_or(0.0)])?;
        }
    }
    for d in &dbs_in {
        for property in props_of(d) {
            if let Some(id) = id_map.get(s(&property, "id")) {
                let mut config = property.get("config").cloned().unwrap_or(json!({}));
                remap(&mut config, &id_map);
                tx.execute(
                    "UPDATE db_property SET config_json = ?2, position = ?3 WHERE id = ?1",
                    params![
                        id,
                        config.to_string(),
                        property["position"].as_f64().unwrap_or(0.0)
                    ],
                )?;
            }
        }
        // Relation filter values can refer to records, so remap views again after record creation.
        for view in d.json["views"].as_array().cloned().unwrap_or_default() {
            if let Some(id) = id_map.get(s(&view, "id")) {
                let mut config = view.get("config").cloned().unwrap_or(json!({}));
                remap(&mut config, &id_map);
                tx.execute(
                    "UPDATE db_view SET config_json = ?2, position = ?3 WHERE id = ?1",
                    params![
                        id,
                        config.to_string(),
                        view["position"].as_f64().unwrap_or(0.0)
                    ],
                )?;
            }
        }
        for template in d.json["templates"].as_array().cloned().unwrap_or_default() {
            if let Some(id) = id_map.get(s(&template, "id")) {
                let mut body = template.get("body").cloned().unwrap_or(json!([]));
                let mut values = template.get("values").cloned().unwrap_or(json!({}));
                remap(&mut body, &id_map);
                remap_files(&mut body, &att_map);
                remap(&mut values, &id_map);
                tx.execute(
                    "UPDATE db_record_template SET body_json = ?2, values_json = ?3 WHERE id = ?1",
                    params![id, body.to_string(), values.to_string()],
                )?;
            }
        }
    }
    if archive.names.contains("automations.json") {
        for mut automation in archive
            .json("automations.json")?
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            remap(&mut automation, &id_map);
            automation["id"] = Value::Null;
            automation["enabled"] = json!(false);
            let input = serde_json::from_value(automation)
                .map_err(|e| AppError::Validation(format!("Invalid automation: {e}")))?;
            crate::automation::save_in(tx, input)?;
            st.automations += 1;
        }
    }
    if archive.names.contains("canvases.json") {
        let boards = archive
            .json("canvases.json")?
            .as_array()
            .cloned()
            .unwrap_or_default();
        for b in boards {
            let made = crate::databases::canvas::create_board(tx, workspace_id, s(&b, "name"));
            let result = made.and_then(|board| {
                let ops = crate::databases::canvas::import_ops(&b["canvas"], &|old| {
                    id_map.get(old).cloned()
                });
                crate::databases::canvas::apply_board_in(tx, &board.id, &ops)
            });
            if let Err(e) = result {
                warn(&mut st, format!("A canvas was skipped: {e}"));
            }
        }
    }
    if container.is_none() && archive.names.contains("workspace.json") {
        let settings = archive
            .json("workspace.json")?
            .get("settings")
            .cloned()
            .unwrap_or(json!({}));
        let current = repo::workspace::get(tx, workspace_id)?
            .ok_or_else(|| AppError::NotFound("workspace".into()))?;
        let mut profile: Value = serde_json::from_str(&current.settings_json)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        for key in ["syncedPageId", "templatesPageId"] {
            if let Some(mapped) = settings[key].as_str().and_then(|old| id_map.get(old)) {
                profile[key] = json!(mapped);
            }
        }
        tx.execute(
            "UPDATE workspace SET settings_json = ?2 WHERE id = ?1",
            params![workspace_id, profile.to_string()],
        )?;
    }
    Ok(st)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImported {
    pub workspace: crate::domain::Workspace,
    pub counts: Stats,
}

pub fn import_workspace(
    conn: &mut Connection,
    store: &Path,
    path: &Path,
    name: &str,
    appearance: bool,
) -> AppResult<WorkspaceImported> {
    let mut archive = Archive::open(path)?;
    archive.validate()?;
    let info = archive.info()?;
    crate::domain::validate_name(name)?;
    let tx = conn.transaction()?;
    let mut name = name.trim().to_string();
    let base: String = name.chars().take(175).collect();
    let names: HashSet<String> = repo::workspace::list(&tx)?
        .into_iter()
        .map(|w| w.name.to_lowercase())
        .collect();
    let mut copy = 1;
    while names.contains(&name.to_lowercase()) {
        name = if copy == 1 {
            format!("{base} (imported)")
        } else {
            format!("{base} (imported {copy})")
        };
        copy += 1;
    }
    let mut settings = portable_settings(&info.settings.to_string());
    if !appearance {
        if let Some(o) = settings.as_object_mut() {
            for k in ["theme", "accent", "sidebarDensity"] {
                o.remove(k);
            }
        }
    }
    // Special page IDs are populated after import, not copied from the old workspace.
    if let Some(o) = settings.as_object_mut() {
        o.remove("syncedPageId");
        o.remove("templatesPageId");
    }
    let workspace = crate::services::workspace::create_in(
        &tx,
        crate::domain::WorkspaceCreate {
            name,
            icon: info.workspace_icon,
            settings_json: Some(settings.to_string()),
        },
    )?;
    let counts = apply_in(&tx, store, &workspace.id, None, &mut archive)?;
    if !counts.warnings.is_empty() {
        return bad(format!(
            "The workspace could not be imported completely: {}",
            counts.warnings.join("; ")
        ));
    }
    let workspace = repo::workspace::get(&tx, &workspace.id)?
        .ok_or_else(|| AppError::NotFound("workspace".into()))?;
    tx.commit()?;
    Ok(WorkspaceImported { workspace, counts })
}
