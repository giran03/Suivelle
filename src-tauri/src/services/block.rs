use super::*;

/// Keeps search, references and the page's modified time in step with a saved block.
fn index_block(conn: &Connection, page_id: &str, b: &Block) -> AppResult<()> {
    let page = repo::page::get(conn, page_id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
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
    crate::domain::embed::validate_block(&input.block_type, &data_json)?;

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
                .filter(|b| b.page_id == input.page_id && b.parent_block_id.as_deref() == parent)
                .ok_or_else(|| AppError::NotFound("sibling block".into()))?;
            match repo::block::next_sibling_position(&tx, &input.page_id, parent, after.position)? {
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
    crate::domain::embed::validate_block(&block.block_type, &block.data_json)?;
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
        crate::domain::embed::validate_block(&u.block_type, &u.data_json)?;
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
                Some(p) => repo::block::page_of(tx, p)?.as_deref() == Some(input.page_id.as_str()),
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
                if *p == u.id || (existing_page.is_some() && repo::block::in_subtree(tx, &u.id, p)?)
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
