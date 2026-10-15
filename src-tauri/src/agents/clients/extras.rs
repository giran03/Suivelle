//! What Connect adds to an app besides its MCP entry, both optional and on by default:
//!
//! - the session-start lines, as a marked block in the app's user-level instructions file, so
//!   every session begins with `whoami`;
//! - small command files for `/suivelle_init`, `/suivelle_setup`, `/suivelle_sync` and
//!   `/suivelle_wrap-up`. Each only tells the agent to call the `command` tool, so the steps live
//!   in Suivelle and editing them never means rewriting files in every app.
//!
//! Like config edits, the instructions file keeps everything outside the block byte for byte, gets
//! a backup, and is written atomically. Command files Suivelle did not write are never touched.

use super::{read_file, write_file, Client, CommandsSpec, Env, FileText, Instructions};
use crate::agents::commands::{Command, COMMANDS, START_LINES};
use crate::errors::{AppError, AppResult};
use std::path::{Path, PathBuf};

pub const START: &str = "<!-- suivelle:start -->";
pub const END: &str = "<!-- suivelle:end -->";
/// A phrase every form of the session-start lines contains, marked or not.
const START_PHRASE: &str = "call suivelle whoami";
/// The sentence every Suivelle command file contains; it is how they are recognized.
const CALL: &str = "Call the suivelle tool `command`";

// ---------------------------------------------------------------------------------------------
// the session-start block
// ---------------------------------------------------------------------------------------------

fn newline(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

pub fn block(nl: &str) -> String {
    format!("{START}{nl}{}{nl}{END}", START_LINES.replace('\n', nl))
}

#[derive(Debug, PartialEq, Eq)]
pub enum BlockState {
    /// Marked and as Suivelle wrote it.
    Current,
    /// Marked, but changed by hand.
    Edited,
    /// The lines are there without markers (added by hand).
    Unmarked,
    Missing,
}

fn marked(text: &str) -> Option<(usize, usize)> {
    let s = text.find(START)?;
    let e = text[s..].find(END)? + s + END.len();
    Some((s, e))
}

pub fn block_state(text: &str) -> BlockState {
    match marked(text) {
        Some((s, e)) if text[s..e].replace("\r\n", "\n") == block("\n") => BlockState::Current,
        Some(_) => BlockState::Edited,
        None if text.contains(START_PHRASE) => BlockState::Unmarked,
        None => BlockState::Missing,
    }
}

/// The text with the block in place: rewritten inside its markers, wrapped around lines added by
/// hand (so they are not doubled), or appended after a blank line.
pub fn add_block(text: &str) -> String {
    let nl = newline(text);
    if let Some((s, e)) = marked(text) {
        return format!("{}{}{}", &text[..s], block(nl), &text[e..]);
    }
    if let Some(at) = text.find(START_PHRASE) {
        let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let line_end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        let line_end = if text[..line_end].ends_with('\r') { line_end - 1 } else { line_end };
        // Take the heading above it along.
        let start = match text[..line_start.saturating_sub(1)].rfind('\n').map_or(0, |i| i + 1) {
            h if line_start > 0 && text[h..line_start].trim_end() == START_LINES.lines().next().unwrap_or_default() => h,
            _ => line_start,
        };
        return format!("{}{}{}", &text[..start], block(nl), &text[line_end..]);
    }
    let mut out = text.to_string();
    if !out.is_empty() {
        if !out.ends_with(nl) {
            out.push_str(nl);
        }
        if !out.ends_with(&format!("{nl}{nl}")) {
            out.push_str(nl);
        }
    }
    out.push_str(&block(nl));
    out.push_str(nl);
    out
}

/// The text without the block (and without the blank line `add_block` put before it).
pub fn remove_block(text: &str) -> String {
    let Some((s, mut e)) = marked(text) else { return text.to_string() };
    let nl = newline(text);
    if text[e..].starts_with(nl) {
        e += nl.len();
    }
    let start = if text[..s].ends_with(&format!("{nl}{nl}")) { s - nl.len() } else { s };
    format!("{}{}", &text[..start], &text[e..])
}

pub fn instructions_of(env: &Env, c: &Client) -> Option<Instructions> {
    let spec = c.instructions.as_ref()?;
    match env.paths(&spec.paths).into_iter().next() {
        Some(p) => Some(Instructions::File(p)),
        None => spec.place.clone().map(Instructions::Place),
    }
}

// ---------------------------------------------------------------------------------------------
// command files
// ---------------------------------------------------------------------------------------------

pub fn file_name(spec: &CommandsSpec, name: &str) -> String {
    let ext = match spec.format.as_str() {
        "toml" => ".toml",
        "vscode" => ".prompt.md",
        _ => ".md",
    };
    format!("suivelle_{name}{ext}")
}

/// How the user types the command in that app.
pub fn typed(spec: &CommandsSpec, name: &str) -> String {
    format!("{}suivelle_{name}", spec.invoke)
}

pub fn stub(spec: &CommandsSpec, cmd: &Command) -> String {
    let (name, desc) = (cmd.name, cmd.description);
    let follow = "then follow the steps it returns. If the suivelle tools are not available, say Suivelle is not connected and stop.";
    let typed_args = "passing as arguments any text typed after the command";
    match spec.format.as_str() {
        "toml" => format!("description = \"Suivelle: {desc}\"\nprompt = \"\"\"\n{CALL} with name \"{name}\" and arguments \"{{{{args}}}}\", {follow}\n\"\"\"\n"),
        "cursor" => format!("# Suivelle: {desc}\n\n{CALL} with name \"{name}\", {typed_args}, {follow}\n"),
        "vscode" => format!("---\ndescription: \"Suivelle: {desc}\"\nmode: agent\n---\n\n{CALL} with name \"{name}\", {typed_args}, {follow}\n"),
        _ => format!("---\ndescription: \"Suivelle: {desc}\"\nargument-hint: \"[focus]\"\n---\n\n{CALL} with name \"{name}\" and arguments \"$ARGUMENTS\", {follow}\n"),
    }
}

pub fn is_ours(text: &str) -> bool {
    text.contains(CALL)
}

fn commands_dir(env: &Env, c: &Client) -> Option<(PathBuf, &'static CommandsSpec)> {
    let spec = super::client(&c.id).ok()?.commands.as_ref()?;
    env.paths(&spec.dir).into_iter().next().map(|d| (d, spec))
}

/// The commands as the user types them in this app; empty when the app has no command files.
pub fn typed_names(c: &Client) -> Vec<String> {
    c.commands.as_ref().map(|s| COMMANDS.iter().map(|cmd| typed(s, cmd.name)).collect()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// adding and removing
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct Added {
    pub instructions: Option<PathBuf>,
    pub commands: Vec<PathBuf>,
    pub backups: Vec<String>,
    pub notes: Vec<String>,
}

fn add_instructions(path: &Path, out: &mut Added) -> AppResult<()> {
    let old = read_file(path)?;
    let text = add_block(&old.text);
    if text != old.text {
        if let Some(b) = write_file(path, &old, &text)? {
            out.backups.push(b.display().to_string());
        }
    }
    if block_state(&read_file(path)?.text) != BlockState::Current {
        return Err(AppError::Internal(format!("{} did not read back as written. Its backup is beside it.", path.display())));
    }
    Ok(())
}

fn add_command(path: &Path, text: &str) -> AppResult<bool> {
    let old = read_file(path)?;
    if old.existed && !is_ours(&old.text) {
        return Ok(false);
    }
    if old.text != text {
        // Suivelle's own file: no backup needed.
        write_file(path, &FileText { existed: false, ..old }, text)?;
    }
    Ok(true)
}

/// Adds what was asked for. Failures become notes: the MCP entry already works without these.
pub fn add(env: &Env, c: &Client, instructions: bool, commands: bool) -> Added {
    let mut out = Added::default();
    if instructions {
        match instructions_of(env, c) {
            Some(Instructions::File(path)) => match add_instructions(&path, &mut out) {
                Ok(()) => out.instructions = Some(path),
                Err(e) => out.notes.push(format!("Could not add the session-start lines to {} ({e}).", path.display())),
            },
            Some(Instructions::Place(place)) => {
                out.notes.push(format!("{} keeps instructions in {place}; paste the session-start lines there yourself.", c.name))
            }
            None => {}
        }
    }
    if commands {
        if let Some((dir, spec)) = commands_dir(env, c) {
            for cmd in COMMANDS {
                let path = dir.join(file_name(spec, cmd.name));
                match add_command(&path, &stub(spec, cmd)) {
                    Ok(true) => out.commands.push(path),
                    Ok(false) => out.notes.push(format!("Left {} alone: Suivelle did not write it.", path.display())),
                    Err(e) => out.notes.push(format!("Could not write {} ({e}).", path.display())),
                }
            }
        }
    }
    out
}

/// Takes out the block and the command files. `keep_instructions` when another connected app
/// reads the same instructions file (Gemini CLI and Antigravity share one).
pub fn remove(instructions: Option<&Path>, commands: &[PathBuf], keep_instructions: bool) -> Vec<String> {
    let mut notes = Vec::new();
    if let (Some(path), false) = (instructions, keep_instructions) {
        let step = || -> AppResult<()> {
            let old = read_file(path)?;
            let text = remove_block(&old.text);
            if old.existed && text != old.text {
                write_file(path, &old, &text)?;
            }
            Ok(())
        };
        if let Err(e) = step() {
            notes.push(format!("Could not take the session-start lines out of {} ({e}).", path.display()));
        }
    }
    for path in commands {
        if read_file(path).is_ok_and(|f| f.existed && is_ours(&f.text)) {
            if let Err(e) = std::fs::remove_file(path) {
                notes.push(format!("Could not remove {} ({e}).", path.display()));
            }
        }
    }
    notes
}

/// What is wrong with what Connect added, if anything.
pub fn problem(instructions: Option<&Path>, commands: &[PathBuf]) -> Option<String> {
    if let Some(path) = instructions {
        let state = read_file(path).map(|f| block_state(&f.text));
        if !matches!(state, Ok(BlockState::Current)) {
            return Some(format!("The Suivelle session-start lines in {} were changed or removed. Repair writes them again.", path.display()));
        }
    }
    if commands.iter().any(|p| !read_file(p).is_ok_and(|f| f.existed && is_ours(&f.text))) {
        return Some("Some /suivelle_… command files were changed or removed. Repair writes them again.".into());
    }
    None
}
