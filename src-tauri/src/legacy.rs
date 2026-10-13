//! Old names occur only here, to keep existing installations and exports readable.
use std::path::{Path, PathBuf};
use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides, Config};

pub const PAGE_LINK: &str = "takoception://page/";
pub const ARCHIVE_FORMAT: &str = "takoception-archive";
const IDENTIFIER: &str = "app.takoception.desktop";

pub fn page_target(href: &str) -> Option<&str> {
    href.strip_prefix("suivelle://page/")
        .or_else(|| href.strip_prefix(PAGE_LINK))
}

fn existing_root(base: &Path, new_identifier: &str) -> Option<PathBuf> {
    let old = base.join(IDENTIFIER);
    let new = base.join(new_identifier);
    (old.join("data/workspace.db").exists() && !new.join("data/workspace.db").exists())
        .then_some(old)
}

/// Reuse the existing database, attachments, shell settings and webview profile in place.
/// Never copy an open WAL database or change isolated performance/test installations.
pub fn preserve_directories(config: &mut Config) {
    if config.identifier != "app.suivelle.desktop" || config.app.app_directories_override.is_some()
    {
        return;
    }
    let Some(base) = dirs::data_dir() else {
        return;
    };
    let Some(data) = existing_root(&base, &config.identifier) else {
        return;
    };
    let local_data = dirs::data_local_dir()
        .map(|base| base.join(IDENTIFIER))
        .filter(|path| path.exists());
    config.app.app_directories_override =
        Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
            data: Some(data),
            local_data,
            ..Default::default()
        }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_page_links_keep_their_backlinks() {
        let id = "00000000-0000-4000-8000-000000000001";
        let data = serde_json::json!({"type":"link", "attrs":{"href":format!("{PAGE_LINK}{id}")}});
        assert_eq!(
            crate::search::text::extract_refs(&data.to_string()),
            vec![id.to_string()]
        );
        assert_eq!(page_target(&format!("{PAGE_LINK}{id}")), Some(id));
    }
    #[test]
    fn reuse_old_database_but_never_override_a_new_one() {
        let root = std::env::temp_dir().join(format!("suivelle-rename-{}", uuid::Uuid::now_v7()));
        let old = root.join(IDENTIFIER).join("data");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("workspace.db"), b"fixture").unwrap();
        assert_eq!(
            existing_root(&root, "app.suivelle.desktop"),
            Some(root.join(IDENTIFIER))
        );
        let new = root.join("app.suivelle.desktop/data");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("workspace.db"), b"fixture").unwrap();
        assert_eq!(existing_root(&root, "app.suivelle.desktop"), None);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
