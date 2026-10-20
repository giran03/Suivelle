//! Bundled, explicit-only workflow. No network, model launch, or REA setup occurs here.
use super::{read_file, write_file};
use crate::errors::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const VERSION: &str = "1.0.0";
const START: &str = "<!-- rea-workflow:start -->";
const END: &str = "<!-- rea-workflow:end -->";
static LOCK: Mutex<()> = Mutex::new(());
const FILES: &[(&str, &str)] = &[
    (
        "SKILL.md",
        include_str!("../../../resources/rea-workflow/SKILL.md"),
    ),
    (
        "agents/openai.yaml",
        include_str!("../../../resources/rea-workflow/agents/openai.yaml"),
    ),
    (
        "references/README.md",
        include_str!("../../../resources/rea-workflow/references/README.md"),
    ),
    (
        "references/prompts.md",
        include_str!("../../../resources/rea-workflow/references/prompts.md"),
    ),
    (
        "references/research.template.md",
        include_str!("../../../resources/rea-workflow/references/research.template.md"),
    ),
    (
        "references/review.template.md",
        include_str!("../../../resources/rea-workflow/references/review.template.md"),
    ),
    (
        "references/SPEC.template.md",
        include_str!("../../../resources/rea-workflow/references/SPEC.template.md"),
    ),
    (
        "references/verification.template.md",
        include_str!("../../../resources/rea-workflow/references/verification.template.md"),
    ),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub bundled_version: String,
    pub installed_version: Option<String>,
    pub installed: bool,
    pub current: bool,
    pub path: String,
    pub backups: Vec<String>,
}

fn folder(home: &Path) -> PathBuf {
    home.join(".agents/skills/rea-workflow")
}
fn runtime(enabled: bool) -> String {
    format!("{{\n  \"jevAssistedReviewAvailable\": {enabled},\n  \"requiresExplicitRequest\": true,\n  \"requiresTransmissionApproval\": true\n}}\n")
}

/// Build the complete write plan before editing anything. Surrounding instructions are preserved.
fn plan(home: &Path) -> AppResult<Vec<(PathBuf, String)>> {
    let root = folder(home);
    let shared = root.join("SKILL.md").to_string_lossy().replace('\\', "/");
    let mut files: Vec<_> = FILES
        .iter()
        .map(|(name, text)| (root.join(name), text.to_string()))
        .collect();
    let rule = format!("{START}\n# REA — explicit request only\nThe shared workflow is `{shared}` and is available across all projects. Read and use it only when the user explicitly asks to use REA or the REA workflow. Attachments, quoted prompts, available tools, project types and past runs do not activate it. Questions require explanation only. Do not start investigation, setup or rebuilding automatically. Clean builders and verifiers must never call REA or read original/research material.\n{END}");
    for relative in [
        ".codex/AGENTS.md",
        ".claude/CLAUDE.md",
        ".gemini/GEMINI.md",
        ".config/opencode/AGENTS.md",
    ] {
        let path = home.join(relative);
        let old = read_file(&path)?.text;
        let nl = if old.contains("\r\n") { "\r\n" } else { "\n" };
        let block = rule.replace('\n', nl);
        let text = match (old.find(START), old.find(END)) {
            (Some(s), Some(e))
                if e > s && old.matches(START).count() == 1 && old.matches(END).count() == 1 =>
            {
                format!("{}{}{}", &old[..s], block, &old[e + END.len()..])
            }
            (None, None) => format!(
                "{old}{}{block}{nl}",
                if old.is_empty() {
                    String::new()
                } else if old.ends_with('\n') {
                    nl.to_string()
                } else {
                    format!("{nl}{nl}")
                }
            ),
            _ => {
                return Err(AppError::Validation(format!(
                    "The REA markers in {} are incomplete or repeated. Fix them before installing.",
                    path.display()
                )))
            }
        };
        files.push((path, text));
    }
    let adapter = format!("---\nname: rea-workflow\ndescription: Use the shared REA workflow only on explicit user request.\ndisable-model-invocation: true\n---\n\nRead `{shared}` only when the user explicitly requests this workflow. Follow its role routing and requested scope. Installation never authorizes an investigation, build, provider transmission, hardware change or agent launch.\n");
    for relative in [
        ".codex/skills/rea-workflow",
        ".claude/skills/rea-workflow",
        ".cursor/skills/rea-workflow",
        ".gemini/skills/rea-workflow",
        ".gemini/config/skills/rea-workflow",
        ".config/opencode/skills/rea-workflow",
    ] {
        let dir = home.join(relative);
        // Earlier installations may already share the canonical directory via a junction.
        if std::fs::canonicalize(&dir)
            .ok()
            .zip(std::fs::canonicalize(&root).ok())
            .is_some_and(|(a, b)| a == b)
        {
            continue;
        }
        if let Ok(link) = std::fs::read_link(&dir) {
            let target = if link.is_absolute() {
                link
            } else {
                dir.parent().unwrap_or(home).join(link)
            };
            let target_text = target.to_string_lossy();
            let root_text = root.to_string_lossy();
            let same = if cfg!(windows) {
                target_text
                    .replace('\\', "/")
                    .trim_start_matches("//?/")
                    .eq_ignore_ascii_case(root_text.replace('\\', "/").trim_start_matches("//?/"))
            } else {
                target == root
            };
            // A dangling link to this root becomes valid after the canonical files are installed.
            if same {
                continue;
            }
            return Err(AppError::Validation(format!("{} links to a different location. Keep it unchanged and resolve the link before installing.", dir.display())));
        }
        files.push((dir.join("SKILL.md"), adapter.clone()));
        files.push((
            dir.join("agents/openai.yaml"),
            "policy:\n  allow_implicit_invocation: false\n".into(),
        ));
    }
    Ok(files)
}

fn status_inner(home: &Path) -> AppResult<Status> {
    let root = folder(home);
    let manifest = read_file(&root.join("suivelle-install.json"))?;
    let installed_version = serde_json::from_str::<serde_json::Value>(&manifest.text)
        .ok()
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from));
    let mut current = installed_version.as_deref() == Some(VERSION);
    current &= serde_json::from_str::<serde_json::Value>(
        &read_file(&root.join("review-availability.json"))?.text,
    )
    .ok()
    .is_some_and(|v| {
        v.get("jevAssistedReviewAvailable")
            .is_some_and(|v| v.is_boolean())
            && v.get("requiresExplicitRequest").and_then(|v| v.as_bool()) == Some(true)
            && v.get("requiresTransmissionApproval")
                .and_then(|v| v.as_bool())
                == Some(true)
    });
    for (path, expected) in plan(home)? {
        current &= read_file(&path)?.text == expected;
    }
    Ok(Status {
        bundled_version: VERSION.into(),
        installed_version,
        installed: root.join("SKILL.md").is_file(),
        current,
        path: root.to_string_lossy().into_owned(),
        backups: vec![],
    })
}

pub fn status(home: &Path) -> AppResult<Status> {
    let _guard = LOCK
        .lock()
        .map_err(|_| AppError::Internal("Workflow installer lock failed.".into()))?;
    status_inner(home)
}

pub fn install(home: &Path, jev_available: bool) -> AppResult<Status> {
    let _guard = LOCK
        .lock()
        .map_err(|_| AppError::Internal("Workflow installer lock failed.".into()))?;
    let root = folder(home);
    let mut files = plan(home)?;
    files.push((
        root.join("review-availability.json"),
        runtime(jev_available),
    ));
    // Last marker: a partial install remains repairable and never appears complete.
    files.push((
        root.join("suivelle-install.json"),
        format!("{{\"version\":\"{VERSION}\"}}\n"),
    ));
    let mut backups = vec![];
    for (path, text) in files {
        let old = read_file(&path)?;
        if old.text == text {
            continue;
        }
        if let Some(backup) = write_file(&path, &old, &text)? {
            backups.push(backup.to_string_lossy().into_owned());
        }
        if read_file(&path)?.text != text {
            return Err(AppError::Internal(format!(
                "Could not verify {}. Install again to repair the workflow.",
                path.display()
            )));
        }
    }
    let mut result = status_inner(home)?;
    if !result.current {
        return Err(AppError::Internal(
            "Workflow files changed during installation. Install again to repair them.".into(),
        ));
    }
    result.backups = backups;
    Ok(result)
}

/// Settings changes only update review eligibility; never remove or reinstall the workflow.
pub fn sync_review(home: &Path, jev_available: bool) -> AppResult<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| AppError::Internal("Workflow installer lock failed.".into()))?;
    let root = folder(home);
    if !root.join("suivelle-install.json").is_file() {
        return Ok(());
    }
    let path = root.join("review-availability.json");
    let old = read_file(&path)?;
    let text = runtime(jev_available);
    if old.text != text {
        write_file(&path, &old, &text)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn link_dir(target: &Path, link: &Path) {
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let out = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(target.to_string_lossy().replace('/', "\\"))
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }
    fn home() -> PathBuf {
        let p = std::env::temp_dir().join(format!("suivelle-rea-{}", crate::domain::new_id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn installs_without_jev_and_repeats_without_writes() {
        let h = home();
        assert!(!status(&h).unwrap().installed);
        let result = install(&h, false).unwrap();
        assert!(result.current);
        assert!(result.backups.is_empty());
        assert_eq!(result.installed_version.as_deref(), Some(VERSION));
        assert_eq!(
            std::fs::read_to_string(folder(&h).join("review-availability.json")).unwrap(),
            runtime(false)
        );
        assert!(install(&h, false).unwrap().backups.is_empty());
        for name in [".codex", ".claude", ".cursor", ".gemini"] {
            let adapter =
                std::fs::read_to_string(h.join(name).join("skills/rea-workflow/SKILL.md")).unwrap();
            assert!(adapter.contains("disable-model-invocation: true"));
            assert!(adapter.contains(
                &folder(&h)
                    .join("SKILL.md")
                    .to_string_lossy()
                    .replace('\\', "/")
            ));
        }
        std::fs::remove_dir_all(h).unwrap();
    }
    #[test]
    fn update_backs_up_existing_files_and_preserves_user_instructions() {
        let h = home();
        let p = h.join(".codex/AGENTS.md");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let old =
            format!("My own instructions\r\n{START}\r\nold workflow\r\n{END}\r\nKeep this too\r\n");
        std::fs::write(&p, &old).unwrap();
        std::fs::create_dir_all(folder(&h)).unwrap();
        std::fs::write(folder(&h).join("SKILL.md"), "legacy workflow").unwrap();
        let before = status(&h).unwrap();
        assert!(before.installed && !before.current && before.installed_version.is_none());
        let result = install(&h, false).unwrap();
        assert!(result.current && result.backups.len() >= 2);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("My own instructions\r\n"));
        assert!(text.ends_with("\r\nKeep this too\r\n"));
        assert_eq!(text.matches(START).count(), 1);
        assert_eq!(
            std::fs::read_to_string(p.with_file_name("AGENTS.md.suivelle-backup")).unwrap(),
            old
        );
        assert_eq!(
            std::fs::read_to_string(folder(&h).join("SKILL.md.suivelle-backup")).unwrap(),
            "legacy workflow"
        );
        std::fs::remove_dir_all(h).unwrap();
    }
    #[test]
    fn disabling_jev_keeps_workflow_and_reenabling_only_changes_availability() {
        let h = home();
        sync_review(&h, true).unwrap();
        assert!(!folder(&h).exists());
        install(&h, true).unwrap();
        let skill = std::fs::read(folder(&h).join("SKILL.md")).unwrap();
        sync_review(&h, false).unwrap();
        assert_eq!(std::fs::read(folder(&h).join("SKILL.md")).unwrap(), skill);
        assert_eq!(
            std::fs::read_to_string(folder(&h).join("review-availability.json")).unwrap(),
            runtime(false)
        );
        assert!(status(&h).unwrap().current);
        sync_review(&h, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(folder(&h).join("review-availability.json")).unwrap(),
            runtime(true)
        );
        assert_eq!(std::fs::read(folder(&h).join("SKILL.md")).unwrap(), skill);
        std::fs::remove_dir_all(h).unwrap();
    }
    #[test]
    fn missing_or_modified_files_and_old_versions_offer_repair() {
        let h = home();
        install(&h, false).unwrap();
        let reference = folder(&h).join("references/prompts.md");
        std::fs::write(&reference, "custom prompt").unwrap();
        assert!(!status(&h).unwrap().current);
        assert!(install(&h, false).unwrap().current);
        assert_eq!(
            std::fs::read_to_string(reference.with_file_name("prompts.md.suivelle-backup"))
                .unwrap(),
            "custom prompt"
        );
        std::fs::remove_file(folder(&h).join("review-availability.json")).unwrap();
        assert!(!status(&h).unwrap().current);
        install(&h, false).unwrap();
        std::fs::write(
            folder(&h).join("suivelle-install.json"),
            "{\"version\":\"0.9.0\"}",
        )
        .unwrap();
        assert!(!status(&h).unwrap().current);
        assert!(install(&h, false).unwrap().current);
        std::fs::remove_dir_all(h).unwrap();
    }
    #[test]
    fn malformed_instruction_markers_fail_before_any_installation() {
        let h = home();
        let p = h.join(".claude/CLAUDE.md");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, START).unwrap();
        assert!(install(&h, false).is_err());
        assert!(!folder(&h).exists());
        assert_eq!(std::fs::read_to_string(p).unwrap(), START);
        std::fs::remove_dir_all(h).unwrap();
    }
    #[test]
    fn preserves_dangling_shared_junction_without_replacing_canonical_skill_with_adapter() {
        let h = home();
        let shared = folder(&h);
        let link = h.join(".codex/skills/rea-workflow");
        link_dir(&shared, &link);
        assert!(!shared.exists());
        assert!(install(&h, false).unwrap().current);
        assert_eq!(
            std::fs::read_to_string(shared.join("SKILL.md")).unwrap(),
            FILES[0].1
        );
        assert_eq!(
            std::fs::canonicalize(link).unwrap(),
            std::fs::canonicalize(shared).unwrap()
        );
        assert!(install(&h, false).unwrap().backups.is_empty());
        std::fs::remove_dir_all(h).unwrap();
    }
    #[test]
    fn refuses_alias_linked_elsewhere_before_writing_any_workflow_files() {
        let h = home();
        let foreign = h.join("custom-skill");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("SKILL.md"), "Keep my skill").unwrap();
        link_dir(&foreign, &h.join(".claude/skills/rea-workflow"));
        assert!(install(&h, false).is_err());
        assert!(!folder(&h).exists());
        assert_eq!(
            std::fs::read_to_string(foreign.join("SKILL.md")).unwrap(),
            "Keep my skill"
        );
        std::fs::remove_dir_all(h).unwrap();
    }
}
