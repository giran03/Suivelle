//! Scoped metadata for the node map. Content stays in pages, blocks and database relations.
pub mod edit;
#[cfg(test)]
mod edit_tests;
use crate::domain::validate_id;
use crate::errors::{AppError, AppResult};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapQuery {
    #[serde(default)]
    pub workspace_ids: Vec<String>,
    pub page_id: Option<String>,
    pub hops: Option<u8>,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub include_records: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub kind: String,
    pub icon: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub count: i64,
    pub record_id: Option<String>,
    pub database_id: Option<String>,
    pub tags: Vec<String>,
    pub values: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: String,
    pub label: String,
    pub property_id: Option<String>,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapProperty {
    pub id: String,
    pub database_id: String,
    pub name: String,
    pub kind: String,
    pub config: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapData {
    pub nodes: Vec<MapNode>,
    pub edges: Vec<MapEdge>,
    pub properties: Vec<MapProperty>,
    pub total_nodes: i64,
    pub truncated: bool,
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}
fn workspace_node(id: &str) -> String {
    format!("workspace:{id}")
}

pub fn snapshot(conn: &Connection, input: &MapQuery) -> AppResult<MapData> {
    if input.workspace_ids.len() > 64
        || input.search.chars().count() > 200
        || input.hops.is_some_and(|h| !(1..=3).contains(&h))
    {
        return Err(AppError::Validation(
            "Choose up to 64 workspaces, 1–3 hops and a search under 200 characters.".into(),
        ));
    }
    for id in &input.workspace_ids {
        validate_id(id, "workspace")?;
    }
    if let Some(id) = &input.page_id {
        validate_id(id, "page")?;
    }
    let limit = input.limit.unwrap_or(1000).clamp(1, 5000);
    let mut nodes = Vec::new();
    let mut ws = conn.prepare("SELECT w.id,w.name,w.icon,w.created_at,w.updated_at,COUNT(p.id) FROM workspace w LEFT JOIN page p ON p.workspace_id=w.id AND p.deleted_at IS NULL GROUP BY w.id ORDER BY w.created_at,w.id")?;
    for row in ws.query_map([], |r| {
        Ok(MapNode {
            id: workspace_node(&r.get::<_, String>(0)?),
            workspace_id: r.get(0)?,
            parent_id: None,
            title: r.get(1)?,
            kind: "workspace".into(),
            icon: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
            count: r.get(5)?,
            favorite: false,
            archived: false,
            record_id: None,
            database_id: None,
            tags: vec![],
            values: BTreeMap::new(),
        })
    })? {
        nodes.push(row?);
    }
    let overview =
        input.workspace_ids.is_empty() && input.page_id.is_none() && input.search.trim().is_empty();
    if !input
        .workspace_ids
        .iter()
        .all(|id| nodes.iter().any(|n| &n.workspace_id == id))
    {
        return Err(AppError::NotFound("workspace".into()));
    }
    if overview {
        let mut stmt=conn.prepare("SELECT s.workspace_id,t.workspace_id,COUNT(DISTINCT r.source_page_id || ':' || r.target_page_id) FROM page_reference r JOIN page s ON s.id=r.source_page_id AND s.deleted_at IS NULL JOIN page t ON t.id=r.target_page_id AND t.deleted_at IS NULL WHERE s.workspace_id!=t.workspace_id GROUP BY s.workspace_id,t.workspace_id")?;
        let edges = stmt
            .query_map([], |r| {
                let a = workspace_node(&r.get::<_, String>(0)?);
                let b = workspace_node(&r.get::<_, String>(1)?);
                Ok(MapEdge {
                    id: format!("reference:{a}:{b}"),
                    source: a,
                    target: b,
                    kind: "reference".into(),
                    label: "Cross-workspace references".into(),
                    property_id: None,
                    count: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(MapData {
            total_nodes: nodes.len() as i64,
            nodes,
            edges,
            properties: vec![],
            truncated: false,
        });
    }
    let mut conditions = vec!["p.deleted_at IS NULL".to_string()];
    let mut args: Vec<SqlValue> = vec![];
    if !input.include_records {
        conditions.push("p.kind!='record'".into());
    }
    if !input.workspace_ids.is_empty() {
        conditions.push(format!(
            "p.workspace_id IN ({})",
            placeholders(input.workspace_ids.len())
        ));
        args.extend(input.workspace_ids.iter().cloned().map(SqlValue::Text));
    }
    if !input.search.trim().is_empty() {
        conditions.push("p.title LIKE ? ESCAPE '\\'".into());
        let escaped = input
            .search
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        args.push(SqlValue::Text(format!("%{escaped}%")));
    }
    if let Some(id) = &input.page_id {
        // The recursive walk includes actual page edges, never workspace membership (which would
        // turn a two-hop neighborhood into every sibling in the workspace).
        let visible = if input.include_records {
            "1"
        } else {
            "s.kind!='record' AND t.kind!='record'"
        };
        let relations = if input.include_records { "1" } else { "0" };
        conditions.push(format!("p.id IN (WITH RECURSIVE adjacency(a,b) AS (SELECT s.id,t.id FROM page s JOIN page t ON t.id=s.parent_page_id WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL AND {visible} UNION SELECT r.source_page_id,r.target_page_id FROM page_reference r JOIN page s ON s.id=r.source_page_id AND s.deleted_at IS NULL JOIN page t ON t.id=r.target_page_id AND t.deleted_at IS NULL WHERE {visible} UNION SELECT a.page_id,b.page_id FROM db_relation r JOIN db_record a ON a.id=r.from_record_id JOIN db_record b ON b.id=r.to_record_id JOIN page s ON s.id=a.page_id AND s.deleted_at IS NULL JOIN page t ON t.id=b.page_id AND t.deleted_at IS NULL WHERE {relations}), walk(id,depth) AS (SELECT ?,0 UNION SELECT CASE WHEN a=walk.id THEN b ELSE a END,depth+1 FROM adjacency JOIN walk ON a=walk.id OR b=walk.id WHERE depth<?) SELECT id FROM walk)"));
        args.push(SqlValue::Text(id.clone()));
        args.push(SqlValue::Integer(input.hops.unwrap_or(1) as i64));
    }
    let filter = conditions.join(" AND ");
    let total_nodes: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM page p WHERE {filter}"),
        params_from_iter(args.iter()),
        |r| r.get(0),
    )?;
    let sql=format!("SELECT p.id,p.workspace_id,p.parent_page_id,p.title,p.kind,p.icon,p.favorite,p.archived,p.created_at,p.updated_at,r.id,r.database_id FROM page p LEFT JOIN db_record r ON r.page_id=p.id WHERE {filter} ORDER BY p.created_at,p.id LIMIT {limit}");
    let mut stmt = conn.prepare(&sql)?;
    for row in stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok(MapNode {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            parent_id: r.get(2)?,
            title: r.get(3)?,
            kind: r.get(4)?,
            icon: r.get(5)?,
            favorite: r.get(6)?,
            archived: r.get(7)?,
            created_at: r.get(8)?,
            updated_at: r.get(9)?,
            record_id: r.get(10)?,
            database_id: r.get(11)?,
            count: 0,
            tags: vec![],
            values: BTreeMap::new(),
        })
    })? {
        nodes.push(row?);
    }
    let page_ids: Vec<String> = nodes
        .iter()
        .filter(|n| n.kind != "workspace")
        .map(|n| n.id.clone())
        .collect();
    let at: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();
    let mut edges = Vec::new();
    for n in &nodes {
        if n.kind == "workspace" {
            continue;
        }
        let source = match &n.parent_id {
            Some(id) if at.contains_key(id) => id.clone(),
            Some(_) => continue,
            None => workspace_node(&n.workspace_id),
        };
        let kind = if n.kind == "record" {
            "membership"
        } else {
            "contains"
        };
        edges.push(MapEdge {
            id: format!("{kind}:{}", n.id),
            source,
            target: n.id.clone(),
            kind: kind.into(),
            label: if kind == "membership" {
                "Record of"
            } else {
                "Contains"
            }
            .into(),
            property_id: None,
            count: 1,
        });
    }
    let mut properties = Vec::new();
    let mut truncated = total_nodes > page_ids.len() as i64;
    if !page_ids.is_empty() {
        let ids = placeholders(page_ids.len());
        let mut references=conn.prepare(&format!("SELECT DISTINCT source_page_id,target_page_id FROM page_reference WHERE source_page_id IN ({ids}) ORDER BY source_page_id,target_page_id LIMIT 20001"))?;
        let mut read = 0;
        for row in references.query_map(params_from_iter(page_ids.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            read += 1;
            if read > 20000 {
                truncated = true;
                break;
            }
            let (a, b) = row?;
            if a == b || !at.contains_key(&b) {
                continue;
            }
            edges.push(MapEdge {
                id: format!("reference:{a}:{b}"),
                source: a,
                target: b,
                kind: "reference".into(),
                label: "References".into(),
                property_id: None,
                count: 1,
            });
        }
        let mut tags = conn.prepare(&format!(
            "SELECT DISTINCT page_id,tag FROM block_tag WHERE page_id IN ({ids}) ORDER BY tag"
        ))?;
        for row in tags.query_map(params_from_iter(page_ids.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (id, tag) = row?;
            nodes[at[&id]].tags.push(tag);
        }
        if input.include_records {
            let mut relations=conn.prepare(&format!("SELECT a.page_id,b.page_id,p.id,p.name FROM db_relation r JOIN db_record a ON a.id=r.from_record_id JOIN db_record b ON b.id=r.to_record_id JOIN db_property p ON p.id=r.property_id WHERE a.page_id IN ({ids}) ORDER BY p.id,a.page_id,b.page_id LIMIT 20001"))?;
            let mut read = 0;
            for row in relations.query_map(params_from_iter(page_ids.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })? {
                read += 1;
                if read > 20000 {
                    truncated = true;
                    break;
                }
                let (a, b, p, label) = row?;
                if !at.contains_key(&b) {
                    continue;
                }
                edges.push(MapEdge {
                    id: format!("relation:{p}:{a}:{b}"),
                    source: a,
                    target: b,
                    kind: "relation".into(),
                    label,
                    property_id: Some(p),
                    count: 1,
                });
            }
            let dbs: HashSet<_> = nodes
                .iter()
                .filter_map(|n| n.database_id.as_ref())
                .collect();
            if !dbs.is_empty() {
                let mut ps=conn.prepare(&format!("SELECT id,database_id,name,type,config_json FROM db_property WHERE database_id IN ({}) ORDER BY database_id,position",placeholders(dbs.len())))?;
                for row in ps.query_map(params_from_iter(dbs.iter()), |r| {
                    Ok(MapProperty {
                        id: r.get(0)?,
                        database_id: r.get(1)?,
                        name: r.get(2)?,
                        kind: r.get(3)?,
                        config: serde_json::from_str(&r.get::<_, String>(4)?)
                            .unwrap_or(Value::Null),
                    })
                })? {
                    properties.push(row?);
                }
                let mut values=conn.prepare(&format!("SELECT r.page_id,v.property_id,v.value_json FROM db_value v JOIN db_record r ON r.id=v.record_id WHERE r.page_id IN ({ids})"))?;
                for row in values.query_map(params_from_iter(page_ids.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })? {
                    let (id, p, v) = row?;
                    nodes[at[&id]]
                        .values
                        .insert(p, serde_json::from_str(&v).unwrap_or(Value::Null));
                }
            }
        }
    }
    for e in &edges {
        for id in [&e.source, &e.target] {
            if let Some(i) = at.get(id) {
                if nodes[*i].kind != "workspace" {
                    nodes[*i].count += 1;
                }
            }
        }
    }
    // Neighborhoods show their workspace anchors only, not unrelated empty workspace clusters.
    if input.page_id.is_some() {
        let owners: HashSet<_> = nodes
            .iter()
            .filter(|n| n.kind != "workspace")
            .map(|n| n.workspace_id.clone())
            .chain(input.workspace_ids.iter().cloned())
            .collect();
        nodes.retain(|n| n.kind != "workspace" || owners.contains(&n.workspace_id));
    }
    Ok(MapData {
        nodes,
        edges,
        properties,
        total_nodes,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::open_in_memory, domain::*, services};
    #[test]
    fn scopes_search_and_neighborhoods_are_bounded_and_do_not_hide_truncation() {
        let mut conn = open_in_memory().unwrap();
        let ws = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Map".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let a = services::page::create(
            &mut conn,
            PageCreate {
                workspace_id: ws.id.clone(),
                parent_page_id: None,
                title: Some("Alpha".into()),
                icon: None,
            },
        )
        .unwrap();
        let b = services::page::create(
            &mut conn,
            PageCreate {
                workspace_id: ws.id.clone(),
                parent_page_id: Some(a.id.clone()),
                title: Some("Beta".into()),
                icon: None,
            },
        )
        .unwrap();
        let overview = snapshot(&conn, &MapQuery::default()).unwrap();
        assert_eq!(overview.nodes.len(), 1);
        assert_eq!(overview.nodes[0].count, 2);
        let graph = snapshot(
            &conn,
            &MapQuery {
                workspace_ids: vec![ws.id.clone()],
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(graph.truncated);
        assert_eq!(graph.total_nodes, 2);
        let graph = snapshot(
            &conn,
            &MapQuery {
                page_id: Some(b.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(graph.nodes.len(), 3);
        assert!(graph
            .edges
            .iter()
            .any(|e| e.source == a.id && e.target == b.id && e.kind == "contains"));
        let graph = snapshot(
            &conn,
            &MapQuery {
                search: "Beta".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(graph.total_nodes, 1);
        assert_eq!(
            snapshot(
                &conn,
                &MapQuery {
                    search: "%".into(),
                    ..Default::default()
                }
            )
            .unwrap()
            .total_nodes,
            0
        );
        conn.execute("UPDATE page SET deleted_at='gone' WHERE id=?", [&b.id])
            .unwrap();
        assert_eq!(
            snapshot(
                &conn,
                &MapQuery {
                    workspace_ids: vec![ws.id],
                    ..Default::default()
                }
            )
            .unwrap()
            .total_nodes,
            1
        );
        assert!(snapshot(
            &conn,
            &MapQuery {
                hops: Some(4),
                ..Default::default()
            }
        )
        .is_err());
    }
}
