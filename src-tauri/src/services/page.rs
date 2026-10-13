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
    let moved = repo::page::get(&tx, &page.id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
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
    let restored = repo::page::get(&tx, id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
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
