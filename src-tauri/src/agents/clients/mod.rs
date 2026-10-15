//! Agent apps on this computer (Claude Code, Codex, Cursor, …): finding them and connecting them to
//! Suivelle with one click.
//!
//! Each app reads its MCP servers from a config file in the user's folder. Connecting an app
//! creates one Suivelle agent for it, with its own token, and adds a `suivelle` server to that
//! file (through the app's own command line when it has one). Only that one entry is ever
//! touched: the rest of the file stays byte for byte, a backup of the previous version is kept
//! beside it, writes are atomic and read back. Nothing here scans processes, starts an agent or
//! uses the network; the app starts `suivelle-mcp` itself the next time it runs.
//!
//! Which apps exist, where their configs live and what an entry looks like is data
//! (`catalogue.json`), so it can follow the apps as they change.

pub mod bridge;
pub mod extras;
pub mod jsonc;
pub mod secret;
pub mod subagents;
mod toml;

#[cfg(test)]
mod tests;

use super::{Agent, AgentInput};
use crate::domain::{now, validate_id};
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The server name written into every app's config.
pub const SERVER: &str = "suivelle";
const MAX_CONFIG: u64 = 8 * 1024 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// catalogue
// ---------------------------------------------------------------------------------------------

/// Paths per system: "windows", "macos", "linux", plus "any" for all of them.
pub type OsPaths = BTreeMap<String, Vec<String>>;

#[derive(Debug, Clone, Deserialize)]
pub struct Catalogue {
    pub version: u32,
    pub clients: Vec<Client>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub detect: Detect,
    pub config: ConfigSpec,
    #[serde(default)]
    pub cli: Option<Cli>,
    /// Where the app keeps user-level commands, for the /suivelle_… command files.
    #[serde(default)]
    pub commands: Option<CommandsSpec>,
    /// Where the app reads user-level instructions, for the session-start lines.
    #[serde(default)]
    pub instructions: Option<InstructionsSpec>,
    pub restart: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsSpec {
    pub dir: OsPaths,
    /// "md" (front matter, `$ARGUMENTS`), "cursor" (plain Markdown), "toml" (Gemini CLI,
    /// `{{args}}`) or "vscode" (`.prompt.md`).
    pub format: String,
    /// How the app spells a command before its name: "/" or Codex's "/prompts:".
    pub invoke: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionsSpec {
    #[serde(default)]
    pub paths: OsPaths,
    /// For apps that keep instructions in their settings instead of a file.
    #[serde(default)]
    pub place: Option<String>,
}

/// Where an app's user-level instructions live.
pub enum Instructions {
    File(PathBuf),
    Place(String),
}

/// Where the session-start lines go for an app, on this computer.
pub fn instructions_target(client_id: &str) -> Option<Instructions> {
    let c = client(client_id).ok()?;
    let env = Env::system().ok()?;
    extras::instructions_of(&env, c)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Detect {
    #[serde(default)]
    pub exe: Vec<String>,
    #[serde(default)]
    pub paths: OsPaths,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigSpec {
    pub paths: OsPaths,
    /// "first": the file that already has the entry, else the first that exists, else
    /// `paths[create]`. "all": every file that exists (apps that read more than one).
    #[serde(default = "first")]
    pub write: String,
    #[serde(default)]
    pub create: usize,
    /// "json" (comments and trailing commas allowed) or "toml".
    pub format: String,
    /// Keys leading to the servers object, e.g. `["mcpServers"]`.
    pub container: Vec<String>,
    pub entry: Shape,
}

fn first() -> String {
    "first".into()
}

/// Where an app keeps a server's command, arguments and environment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shape {
    pub command: String,
    #[serde(default)]
    pub args: Option<String>,
    /// The command and its arguments as one array (opencode).
    #[serde(default)]
    pub command_array: bool,
    pub env: String,
    /// Fixed members, such as `"type": "stdio"`.
    #[serde(default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cli {
    pub exe: String,
    /// Arguments; `{json}`, `{command}`, `{args}` and `{envFlags}` are filled in.
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

pub fn catalogue() -> &'static Catalogue {
    static CATALOGUE: OnceLock<Catalogue> = OnceLock::new();
    CATALOGUE.get_or_init(|| serde_json::from_str(include_str!("catalogue.json")).expect("the bundled agent app catalogue is valid"))
}

fn client(id: &str) -> AppResult<&'static Client> {
    catalogue()
        .clients
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::NotFound("agent app".into()))
}

// ---------------------------------------------------------------------------------------------
// the computer
// ---------------------------------------------------------------------------------------------

/// The parts of this computer the connector looks at. Tests point it at a temporary folder.
#[derive(Debug, Clone)]
pub struct Env {
    pub home: PathBuf,
    pub config: PathBuf,
    pub path: Vec<PathBuf>,
    pub os: &'static str,
    /// Use apps' own command lines when they have one.
    pub cli: bool,
    /// Keep tokens in the system credential store instead of config files.
    pub credentials: bool,
    /// Where the connector is installed for apps to run.
    pub bin_dir: PathBuf,
    /// The connector shipped with this build.
    pub bundled: Option<PathBuf>,
    /// The Suivelle program the connector may start.
    pub app: Option<PathBuf>,
}

impl Env {
    pub fn system() -> AppResult<Env> {
        let missing = || AppError::Internal("Could not find the user folder.".into());
        Ok(Env {
            home: dirs::home_dir().ok_or_else(missing)?,
            config: dirs::config_dir().ok_or_else(missing)?,
            path: std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default(),
            os: std::env::consts::OS,
            cli: true,
            credentials: secret::available(),
            bin_dir: bridge::stable_dir().ok_or_else(missing)?,
            bundled: bridge::bundled(),
            app: std::env::current_exe().ok(),
        })
    }

    fn expand(&self, p: &str) -> PathBuf {
        let (mut out, rest) = if let Some(r) = p.strip_prefix("{home}") {
            (self.home.clone(), r)
        } else if let Some(r) = p.strip_prefix("{config}") {
            (self.config.clone(), r)
        } else {
            (PathBuf::new(), p)
        };
        for seg in rest.split('/').filter(|s| !s.is_empty()) {
            out.push(seg);
        }
        out
    }

    fn paths(&self, spec: &OsPaths) -> Vec<PathBuf> {
        let os = if self.os == "windows" || self.os == "macos" { self.os } else { "linux" };
        spec.get("any")
            .into_iter()
            .chain(spec.get(os))
            .flatten()
            .map(|p| self.expand(p))
            .collect()
    }

    /// A program on PATH, the way a shell would find it.
    pub fn find_exe(&self, name: &str) -> Option<PathBuf> {
        let exts: &[&str] = if self.os == "windows" { &[".exe", ".cmd", ".bat"] } else { &[""] };
        self.path
            .iter()
            .flat_map(|dir| exts.iter().map(move |e| dir.join(format!("{name}{e}"))))
            .find(|p| p.is_file())
    }
}

// ---------------------------------------------------------------------------------------------
// entries
// ---------------------------------------------------------------------------------------------

/// A server entry in any app's format, reduced to what matters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl Entry {
    pub fn fingerprint(&self) -> String {
        let text = serde_json::to_string(self).unwrap_or_default();
        Sha256::digest(text.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
    }

    /// The token the entry carries, if it carries one itself.
    fn token(&self) -> Option<&str> {
        self.env.get("SUIVELLE_AGENT_TOKEN").map(String::as_str)
    }

    /// The agent named by `--credential <id>`.
    fn credential(&self) -> Option<&str> {
        let at = self.args.iter().position(|a| a == "--credential")?;
        self.args.get(at + 1).map(String::as_str)
    }
}

impl Shape {
    pub fn fields(&self, e: &Entry) -> jsonc::Fields {
        let mut out: jsonc::Fields = Vec::new();
        if let Some(t) = self.extra.get("type") {
            out.push(("type".into(), t.clone()));
        }
        if self.command_array {
            let all: Vec<Value> = std::iter::once(&e.command).chain(&e.args).map(|s| Value::String(s.clone())).collect();
            out.push((self.command.clone(), Value::Array(all)));
        } else {
            out.push((self.command.clone(), Value::String(e.command.clone())));
            let args = e.args.iter().map(|s| Value::String(s.clone())).collect();
            out.push((self.args.clone().unwrap_or_else(|| "args".into()), Value::Array(args)));
        }
        if !e.env.is_empty() {
            let env = e.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
            out.push((self.env.clone(), Value::Object(env)));
        }
        for (k, v) in &self.extra {
            if k != "type" {
                out.push((k.clone(), v.clone()));
            }
        }
        out
    }

    pub fn read(&self, v: &Value) -> Entry {
        let strings = |v: Option<&Value>| -> Vec<String> {
            v.and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        let (command, args) = if self.command_array {
            let mut all = strings(v.get(&self.command));
            let command = if all.is_empty() { String::new() } else { all.remove(0) };
            (command, all)
        } else {
            (
                v.get(&self.command).and_then(Value::as_str).unwrap_or_default().to_string(),
                strings(v.get(self.args.as_deref().unwrap_or("args"))),
            )
        };
        let env = v
            .get(&self.env)
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        Entry { command, args, env }
    }
}

fn read_entry(c: &Client, text: &str) -> Result<Option<Entry>, String> {
    match c.config.format.as_str() {
        "toml" => toml::get(text, &c.config.container),
        _ => Ok(jsonc::get(text, &c.config.container, SERVER)?.map(|v| c.config.entry.read(&v))),
    }
}

fn write_entry(c: &Client, text: &str, e: &Entry) -> Result<(String, bool), String> {
    match c.config.format.as_str() {
        "toml" => {
            let created = !text.contains(&format!("[{}", c.config.container.join(".")));
            Ok((toml::set(text, &c.config.container, e)?, created))
        }
        _ => jsonc::set(text, &c.config.container, SERVER, &c.config.entry.fields(e)),
    }
}

fn remove_entry(c: &Client, text: &str, drop_container: bool) -> Result<String, String> {
    match c.config.format.as_str() {
        "toml" => toml::unset(text, &c.config.container),
        _ => jsonc::unset(text, &c.config.container, SERVER, drop_container),
    }
}

/// What to paste by hand: a whole document to merge, or Codex's table.
pub fn snippet(c: &Client, e: &Entry) -> String {
    match c.config.format.as_str() {
        "toml" => toml::render(e, &c.config.container, "\n"),
        _ => jsonc::set("{}", &c.config.container, SERVER, &c.config.entry.fields(e))
            .map(|(t, _)| t)
            .unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------------------------
// config files
// ---------------------------------------------------------------------------------------------

struct FileText {
    text: String,
    bom: bool,
    existed: bool,
}

fn read_file(path: &Path) -> AppResult<FileText> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileText { text: String::new(), bom: false, existed: false })
        }
        Err(e) => return Err(e.into()),
    };
    if meta.len() > MAX_CONFIG {
        return Err(AppError::Validation(format!("{} is too large to edit safely.", path.display())));
    }
    let bytes = std::fs::read(path)?;
    let (bom, bytes) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (true, rest.to_vec()),
        None => (false, bytes),
    };
    let text = String::from_utf8(bytes).map_err(|_| AppError::Validation(format!("{} is not UTF-8 text.", path.display())))?;
    Ok(FileText { text, bom, existed: true })
}

/// Writes `text` over `path` atomically, after copying the previous version to
/// `<file>.suivelle-backup`. Returns the backup's path.
fn write_file(path: &Path, old: &FileText, text: &str) -> AppResult<Option<PathBuf>> {
    // Write through a link to the file it points at, instead of replacing the link.
    let target = match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => std::fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let dir = target.parent().ok_or_else(|| AppError::Validation("Bad config path.".into()))?;
    std::fs::create_dir_all(dir)?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let backup = if old.existed {
        let b = dir.join(format!("{name}.suivelle-backup"));
        std::fs::copy(&target, &b)?;
        Some(b)
    } else {
        None
    };
    let tmp = dir.join(format!(".{name}.suivelle-tmp"));
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if old.bom {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(&tmp, &bytes)?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(backup)
}

/// Config files that exist, with the suivelle entry each holds (or why it could not be read).
fn existing(env: &Env, c: &Client) -> Vec<(PathBuf, Result<Option<Entry>, String>)> {
    env.paths(&c.config.paths)
        .into_iter()
        .filter(|p| p.is_file())
        .map(|p| {
            let entry = read_file(&p)
                .map_err(|e| e.to_string())
                .and_then(|f| read_entry(c, &f.text).map_err(|e| format!("{}: {e}", p.display())));
            (p, entry)
        })
        .collect()
}

/// The files Connect writes.
fn targets(env: &Env, c: &Client) -> Vec<PathBuf> {
    let all = env.paths(&c.config.paths);
    let found = existing(env, c);
    if c.config.write == "all" && !found.is_empty() {
        return found.into_iter().map(|(p, _)| p).collect();
    }
    if let Some((p, _)) = found.iter().find(|(_, e)| matches!(e, Ok(Some(_)))) {
        return vec![p.clone()];
    }
    if let Some((p, _)) = found.first() {
        return vec![p.clone()];
    }
    all.get(c.config.create).or(all.first()).cloned().into_iter().collect()
}

// ---------------------------------------------------------------------------------------------
// command lines
// ---------------------------------------------------------------------------------------------

fn cli_args(c: &Client, template: &[String], e: &Entry) -> Vec<String> {
    let mut out = Vec::new();
    for a in template {
        match a.as_str() {
            "{json}" => {
                let obj: Map<String, Value> = c.config.entry.fields(e).into_iter().collect();
                out.push(Value::Object(obj).to_string());
            }
            "{command}" => out.push(e.command.clone()),
            "{args}" => out.extend(e.args.iter().cloned()),
            "{envFlags}" => {
                for (k, v) in &e.env {
                    out.push("--env".into());
                    out.push(format!("{k}={v}"));
                }
            }
            other => out.push(other.to_string()),
        }
    }
    out
}

/// Runs a program without a shell window, with a time limit. Errors carry its last output line.
fn run(exe: &Path, args: &[String]) -> Result<(), String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.take(64 * 1024).read_to_string(&mut s);
        }
        s
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let err = reader.join().unwrap_or_default();
                return if status.success() {
                    Ok(())
                } else {
                    let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
                    Err(if last.is_empty() { format!("exited with {status}") } else { last })
                };
            }
            Ok(None) if started.elapsed() > CLI_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("did not finish in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Record {
    client_id: String,
    agent_id: String,
    method: String,
    config_paths: Vec<String>,
    fingerprint: Option<String>,
    created_container: bool,
    credential: bool,
    bridge_path: String,
    connected_at: String,
    /// The user's choices; `None` for apps connected before Suivelle offered these.
    want_instructions: Option<bool>,
    want_commands: Option<bool>,
    instructions_path: Option<String>,
    commands: Vec<String>,
}

impl Record {
    fn extras(&self) -> (Option<PathBuf>, Vec<PathBuf>) {
        (self.instructions_path.as_ref().map(PathBuf::from), self.commands.iter().map(PathBuf::from).collect())
    }
}

fn record(conn: &Connection, client_id: &str) -> AppResult<Option<Record>> {
    Ok(conn
        .query_row(
            "SELECT client_id, agent_id, method, config_paths_json, fingerprint, created_container, credential, bridge_path, connected_at,
                    want_instructions, want_commands, instructions_path, commands_json
             FROM agent_client WHERE client_id = ?1",
            [client_id],
            |r| {
                Ok(Record {
                    client_id: r.get(0)?,
                    agent_id: r.get(1)?,
                    method: r.get(2)?,
                    config_paths: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                    fingerprint: r.get(4)?,
                    created_container: r.get(5)?,
                    credential: r.get(6)?,
                    bridge_path: r.get(7)?,
                    connected_at: r.get(8)?,
                    want_instructions: r.get(9)?,
                    want_commands: r.get(10)?,
                    instructions_path: r.get(11)?,
                    commands: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
                })
            },
        )
        .optional()?)
}

fn save_record(conn: &Connection, r: &Record) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_client (client_id, agent_id, method, config_paths_json, fingerprint, created_container, credential, bridge_path, connected_at,
                                   want_instructions, want_commands, instructions_path, commands_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(client_id) DO UPDATE SET agent_id = excluded.agent_id, method = excluded.method,
           config_paths_json = excluded.config_paths_json, fingerprint = excluded.fingerprint,
           created_container = excluded.created_container OR agent_client.created_container,
           credential = excluded.credential, bridge_path = excluded.bridge_path, connected_at = excluded.connected_at,
           want_instructions = excluded.want_instructions, want_commands = excluded.want_commands,
           instructions_path = excluded.instructions_path, commands_json = excluded.commands_json",
        params![
            r.client_id,
            r.agent_id,
            r.method,
            serde_json::to_string(&r.config_paths).unwrap_or_else(|_| "[]".into()),
            r.fingerprint,
            r.created_container,
            r.credential,
            r.bridge_path,
            r.connected_at,
            r.want_instructions,
            r.want_commands,
            r.instructions_path,
            serde_json::to_string(&r.commands).unwrap_or_else(|_| "[]".into())
        ],
    )?;
    Ok(())
}

/// Whether another connected app reads the same instructions file (Gemini CLI and Antigravity).
fn shared_instructions(conn: &Connection, client_id: &str, path: &Path) -> bool {
    conn.query_row(
        "SELECT 1 FROM agent_client WHERE client_id <> ?1 AND instructions_path = ?2",
        params![client_id, path.display().to_string()],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The app an agent is connected through, if any.
pub fn client_of(conn: &Connection, agent_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT client_id FROM agent_client WHERE agent_id = ?1", [agent_id], |r| r.get(0))
        .optional()?)
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// What showed the app is installed ("claude on PATH", a folder).
    pub found: Vec<String>,
    /// The files Connect changes (or changed).
    pub config_paths: Vec<String>,
    /// "cli" when Connect uses the app's own command, otherwise "file".
    pub method: String,
    /// "not_connected", "foreign" (a suivelle server Suivelle did not add), "waiting" (connected,
    /// not used yet: the app needs a restart), "connected", "paused", "out_of_date", "edited",
    /// "removed" or "unreadable".
    pub status: String,
    pub detail: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub connected_at: Option<String>,
    /// How the connection was made: "file", "cli" or "manual".
    pub connected_by: Option<String>,
    pub credential: bool,
    pub restart: String,
    /// The user-level instructions file the session-start lines go in (or went in).
    pub instructions_path: Option<String>,
    /// For apps without such a file: where to paste the lines instead.
    pub instructions_place: Option<String>,
    /// Whether the lines are in that file now.
    pub instructions_added: bool,
    /// The /suivelle_… commands as typed in this app; empty when it only has MCP prompts.
    pub commands: Vec<String>,
    /// Whether Suivelle's command files are in place.
    pub commands_added: bool,
    /// The session-start lines, for pasting by hand.
    pub start_lines: String,
    /// Connected before Suivelle offered start lines and commands; Repair adds them.
    pub extras_pending: bool,
}

fn status_of(conn: &Connection, env: &Env, c: &Client) -> AppResult<ClientStatus> {
    let mut found: Vec<String> = c.detect.exe.iter().filter(|e| env.find_exe(e).is_some()).map(|e| format!("{e} on PATH")).collect();
    found.extend(env.paths(&c.detect.paths).into_iter().filter(|p| p.exists()).map(|p| p.display().to_string()));
    let files = existing(env, c);
    let installed = !found.is_empty() || !files.is_empty();
    let rec = record(conn, &c.id)?;
    let agent = match &rec {
        Some(r) => super::get(conn, &r.agent_id).ok(),
        None => None,
    };
    let method = match &c.cli {
        Some(cli) if env.cli && env.find_exe(&cli.exe).is_some() => "cli",
        _ => "file",
    };
    let unreadable = files.iter().find_map(|(_, e)| e.as_ref().err().cloned());
    let entry = files.iter().find_map(|(_, e)| e.as_ref().ok().cloned().flatten());
    let (status, detail) = match (&rec, &agent, &entry) {
        _ if unreadable.is_some() => ("unreadable", unreadable),
        (None, _, None) => ("not_connected", None),
        (None, _, Some(_)) => ("foreign", Some("A server named “suivelle” is already set up there, but not by this copy of Suivelle.".to_string())),
        (Some(r), _, None) if r.method == "manual" => ("removed", Some("The entry has not been added to the config yet.".to_string())),
        (Some(_), _, None) => ("removed", Some("The suivelle entry was removed from the config outside Suivelle.".to_string())),
        (Some(_), None, Some(_)) => ("out_of_date", Some("Its agent no longer exists.".to_string())),
        (Some(r), Some(a), Some(e)) => {
            let token = match e.credential() {
                Some(id) if id == a.id => if env.credentials { secret::read(id) } else { None },
                Some(_) => None,
                None => e.token().map(str::to_string),
            };
            if r.fingerprint.as_deref() != Some(&e.fingerprint()) {
                ("edited", Some("The suivelle entry was changed outside Suivelle. Repair writes it again.".to_string()))
            } else if !Path::new(&e.command).is_file() {
                ("out_of_date", Some("The connector it points at is missing.".to_string()))
            } else if !token.is_some_and(|t| super::token_matches(conn, &a.id, &t)) {
                ("out_of_date", Some("Its token was replaced or revoked.".to_string()))
            } else if let Some(p) = {
                let (i, cmds) = r.extras();
                extras::problem(i.as_deref(), &cmds)
            } {
                ("edited", Some(p))
            } else if a.status == "paused" {
                ("paused", Some("Its agent is paused.".to_string()))
            } else if a.last_seen_at.as_deref().is_none_or(|seen| seen < r.connected_at.as_str()) {
                ("waiting", Some(c.restart.clone()))
            } else {
                ("connected", None)
            }
        }
    };
    let config_paths = match &rec {
        Some(r) if !r.config_paths.is_empty() => r.config_paths.clone(),
        _ => targets(env, c).iter().map(|p| p.display().to_string()).collect(),
    };
    let (instructions_path, instructions_place) = match (rec.as_ref().and_then(|r| r.instructions_path.clone()), extras::instructions_of(env, c)) {
        (Some(p), _) => (Some(p), None),
        (None, Some(Instructions::File(p))) => (Some(p.display().to_string()), None),
        (None, Some(Instructions::Place(place))) => (None, Some(place)),
        (None, None) => (None, None),
    };
    let instructions_added = instructions_path
        .as_ref()
        .is_some_and(|p| read_file(Path::new(p)).is_ok_and(|f| matches!(extras::block_state(&f.text), extras::BlockState::Current | extras::BlockState::Unmarked)));
    Ok(ClientStatus {
        id: c.id.clone(),
        name: c.name.clone(),
        installed,
        found,
        config_paths,
        method: method.into(),
        status: status.into(),
        detail,
        agent_id: agent.as_ref().map(|a| a.id.clone()),
        agent_name: agent.as_ref().map(|a| a.name.clone()),
        connected_at: rec.as_ref().map(|r| r.connected_at.clone()),
        connected_by: rec.as_ref().map(|r| r.method.clone()),
        credential: rec.as_ref().map_or(env.credentials, |r| r.credential),
        restart: c.restart.clone(),
        instructions_path,
        instructions_place,
        instructions_added,
        commands: extras::typed_names(c),
        commands_added: rec.as_ref().is_some_and(|r| !r.commands.is_empty() && extras::problem(None, &r.extras().1).is_none()),
        start_lines: extras::block("\n"),
        extras_pending: rec.as_ref().is_some_and(|r| r.want_instructions.is_none() && r.method != "manual")
            && (c.instructions.is_some() || c.commands.is_some()),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    /// Installed apps and apps connected earlier.
    pub clients: Vec<ClientStatus>,
    /// Every app Suivelle knows, for "not found" hints.
    pub known: Vec<String>,
    /// The connector this build ships, if any.
    pub bundled: Option<String>,
    pub dev_build: bool,
    /// Whether tokens go to the system credential store.
    pub credentials: bool,
}

/// Looks for agent apps. Reads files and PATH only.
pub fn scan(conn: &Connection, env: &Env) -> AppResult<Scan> {
    let mut clients = Vec::new();
    for c in &catalogue().clients {
        let s = status_of(conn, env, c)?;
        if s.installed || s.connected_at.is_some() {
            clients.push(s);
        }
    }
    Ok(Scan {
        clients,
        known: catalogue().clients.iter().map(|c| c.name.clone()).collect(),
        bundled: env.bundled.as_ref().map(|p| p.display().to_string()),
        dev_build: cfg!(debug_assertions),
        credentials: env.credentials,
    })
}

// ---------------------------------------------------------------------------------------------
// connect, repair, disconnect
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInput {
    /// Connect through this existing agent instead of creating one.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// The new agent (name, workspaces, mode, tools). The name defaults to the app's.
    #[serde(default)]
    pub agent: Option<AgentInput>,
    /// Replace a suivelle server that Suivelle did not add.
    #[serde(default)]
    pub replace: bool,
    /// Return the entry to paste instead of editing the file.
    #[serde(default)]
    pub manual: bool,
    /// Add the session-start lines to the app's user-level instructions file.
    #[serde(default = "yes")]
    pub instructions: bool,
    /// Add the /suivelle_… command files.
    #[serde(default = "yes")]
    pub commands: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub client: ClientStatus,
    /// "file", "cli" or "manual".
    pub method: String,
    pub changed: Vec<String>,
    pub backups: Vec<String>,
    /// For "manual": the entry to paste, shown once (it may hold the token).
    pub snippet: Option<String>,
    pub notes: Vec<String>,
}

fn unique_name(conn: &Connection, base: &str) -> AppResult<String> {
    let taken = |n: &str| -> AppResult<bool> {
        Ok(conn
            .query_row("SELECT 1 FROM agent WHERE name = ?1 COLLATE NOCASE", [n], |_| Ok(()))
            .optional()?
            .is_some())
    };
    if !taken(base)? {
        return Ok(base.to_string());
    }
    for i in 2..100 {
        let n = format!("{base} {i}");
        if !taken(&n)? {
            return Ok(n);
        }
    }
    Err(AppError::Validation("Choose a different agent name.".into()))
}

/// Connects an app (or repairs its connection): its agent, a fresh token, the connector, and the
/// suivelle entry in its config.
pub fn connect(conn: &mut Connection, env: &Env, client_id: &str, input: ConnectInput) -> AppResult<ConnectResult> {
    let c = client(client_id)?;
    let rec = record(conn, client_id)?;
    if rec.is_none() && !input.replace && !input.manual {
        if let Some(p) = existing(env, c).into_iter().find(|(_, e)| matches!(e, Ok(Some(_)))) {
            return Err(AppError::Validation(format!(
                "{} already has a server named “suivelle” ({}). Confirm to replace it.",
                c.name,
                p.0.display()
            )));
        }
    }
    let (agent, created) = match (&rec, &input.agent_id) {
        (Some(r), _) if super::get(conn, &r.agent_id).is_ok() => (super::get(conn, &r.agent_id)?, false),
        (_, Some(id)) => {
            validate_id(id, "agent")?;
            let a = super::get(conn, id)?;
            if client_of(conn, id)?.is_some_and(|other| other != client_id) {
                return Err(AppError::Validation(format!("{} is already connected to another app.", a.name)));
            }
            (a, false)
        }
        _ => {
            let mut a = input.agent.clone().unwrap_or_default();
            if a.name.trim().is_empty() {
                a.name = c.name.clone();
            }
            a.name = unique_name(conn, a.name.trim())?;
            if a.role.trim().is_empty() {
                a.role = format!("{} on this computer", c.name);
            }
            (super::create(conn, a)?, true)
        }
    };
    let result = connect_agent(conn, env, c, &agent, rec.as_ref(), &input);
    if result.is_err() && created {
        let _ = super::delete(conn, &agent.id);
        if env.credentials {
            secret::delete(&agent.id);
        }
    }
    result
}

fn connect_agent(conn: &mut Connection, env: &Env, c: &Client, agent: &Agent, rec: Option<&Record>, input: &ConnectInput) -> AppResult<ConnectResult> {
    let manual = input.manual;
    let source = env.bundled.as_ref().ok_or_else(|| {
        AppError::Validation("The suivelle-mcp connector is missing from this copy of Suivelle. Reinstall Suivelle, or build it with `cargo build -p suivelle-mcp`.".into())
    })?;
    let command = bridge::install(source, &env.bin_dir, env.app.as_deref())?;
    let token = super::rotate_token(conn, &agent.id)?;
    let entry = if env.credentials {
        secret::store(&agent.id, &token)?;
        Entry { command: command.display().to_string(), args: vec!["--credential".into(), agent.id.clone()], env: BTreeMap::new() }
    } else {
        Entry {
            command: command.display().to_string(),
            args: Vec::new(),
            env: BTreeMap::from([("SUIVELLE_AGENT_TOKEN".to_string(), token)]),
        }
    };
    let paths = targets(env, c);
    let mut notes = Vec::new();
    let mut backups = Vec::new();
    let mut created_container = false;
    let mut method = if manual { "manual" } else { "file" };

    if !manual {
        if let (Some(cli), true) = (&c.cli, env.cli) {
            if let Some(exe) = env.find_exe(&cli.exe) {
                let _ = run(&exe, &cli_args(c, &cli.remove, &entry));
                match run(&exe, &cli_args(c, &cli.add, &entry)) {
                    Ok(()) if existing(env, c).iter().any(|(_, e)| matches!(e, Ok(Some(x)) if *x == entry)) => method = "cli",
                    Ok(()) => notes.push(format!("{}'s own command did not add the entry, so Suivelle edited the file instead.", c.name)),
                    Err(e) => notes.push(format!("{}'s own command failed ({e}), so Suivelle edited the file instead.", c.name)),
                }
            }
        }
    }
    if method == "file" {
        for path in &paths {
            let old = read_file(path)?;
            let (text, created) = write_entry(c, &old.text, &entry).map_err(|e| AppError::Validation(format!("{}: {e}", path.display())))?;
            created_container |= created;
            if text != old.text {
                if let Some(b) = write_file(path, &old, &text)? {
                    backups.push(b.display().to_string());
                }
            }
            let back = read_file(path)?;
            if read_entry(c, &back.text).ok().flatten().as_ref() != Some(&entry) {
                return Err(AppError::Internal(format!("{} did not read back as written. Its backup is beside it.", path.display())));
            }
        }
    }
    // The session-start lines and command files; not for entries pasted by hand.
    let extra = if manual { extras::Added::default() } else { extras::add(env, c, input.instructions, input.commands) };
    backups.extend(extra.backups.iter().cloned());
    notes.extend(extra.notes.iter().cloned());
    if let Some(old) = rec {
        // Take out what was added before and is no longer wanted.
        let (was_instr, was_cmds) = old.extras();
        let stale: Vec<PathBuf> = was_cmds.into_iter().filter(|p| !extra.commands.contains(p)).collect();
        let drop_instr = was_instr.filter(|p| extra.instructions.as_ref() != Some(p));
        let keep = drop_instr.as_deref().is_some_and(|p| shared_instructions(conn, &c.id, p));
        notes.extend(extras::remove(drop_instr.as_deref(), &stale, keep));
    }
    let changed: Vec<String> = match method {
        "cli" => existing(env, c).into_iter().filter(|(_, e)| matches!(e, Ok(Some(_)))).map(|(p, _)| p.display().to_string()).collect(),
        _ => paths.iter().map(|p| p.display().to_string()).collect(),
    };
    save_record(
        conn,
        &Record {
            client_id: c.id.clone(),
            agent_id: agent.id.clone(),
            method: method.into(),
            config_paths: changed.clone(),
            fingerprint: Some(entry.fingerprint()),
            created_container: created_container || rec.is_some_and(|r| r.created_container),
            credential: env.credentials,
            bridge_path: entry.command.clone(),
            connected_at: now(),
            want_instructions: Some(input.instructions),
            want_commands: Some(input.commands),
            instructions_path: extra.instructions.as_ref().map(|p| p.display().to_string()),
            commands: extra.commands.iter().map(|p| p.display().to_string()).collect(),
        },
    )?;
    Ok(ConnectResult {
        client: status_of(conn, env, c)?,
        method: method.into(),
        changed: if manual { Vec::new() } else { changed },
        backups,
        snippet: manual.then(|| snippet(c, &entry)),
        notes,
    })
}

/// Rewrites a connection that is out of date or was edited: fresh token, current connector.
pub fn repair(conn: &mut Connection, env: &Env, client_id: &str) -> AppResult<ConnectResult> {
    let rec = record(conn, client_id)?.ok_or_else(|| AppError::NotFound("connection".into()))?;
    connect(
        conn,
        env,
        client_id,
        ConnectInput {
            replace: true,
            manual: rec.method == "manual",
            instructions: rec.want_instructions.unwrap_or(true),
            commands: rec.want_commands.unwrap_or(true),
            ..Default::default()
        },
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub client: ClientStatus,
    pub notes: Vec<String>,
}

/// Removes the suivelle entry and revokes the agent's token. The agent and its history stay.
pub fn disconnect(conn: &mut Connection, env: &Env, client_id: &str) -> AppResult<DisconnectResult> {
    let c = client(client_id)?;
    let rec = record(conn, client_id)?.ok_or_else(|| AppError::NotFound("connection".into()))?;
    let mut notes = Vec::new();
    let mut done = false;
    if rec.method == "cli" {
        if let (Some(cli), true) = (&c.cli, env.cli) {
            if let Some(exe) = env.find_exe(&cli.exe) {
                done = run(&exe, &cli_args(c, &cli.remove, &Entry::default())).is_ok()
                    && !existing(env, c).iter().any(|(_, e)| matches!(e, Ok(Some(_))));
            }
        }
    }
    if !done {
        let mut paths: Vec<PathBuf> = rec.config_paths.iter().map(PathBuf::from).collect();
        for (p, _) in existing(env, c) {
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
        for path in paths {
            let step = || -> AppResult<()> {
                let old = read_file(&path)?;
                if !old.existed || read_entry(c, &old.text).map_err(AppError::Validation)?.is_none() {
                    return Ok(());
                }
                let text = remove_entry(c, &old.text, rec.created_container).map_err(AppError::Validation)?;
                write_file(&path, &old, &text)?;
                Ok(())
            };
            if let Err(e) = step() {
                notes.push(format!("Could not edit {} ({e}). The entry stays there but no longer works.", path.display()));
            }
        }
    }
    let (instructions, commands) = rec.extras();
    let keep = instructions.as_deref().is_some_and(|p| shared_instructions(conn, &rec.client_id, p));
    notes.extend(extras::remove(instructions.as_deref(), &commands, keep));
    if super::get(conn, &rec.agent_id).is_ok() {
        super::revoke_token(conn, &rec.agent_id)?;
    }
    if rec.credential {
        secret::delete(&rec.agent_id);
    }
    conn.execute("DELETE FROM agent_client WHERE client_id = ?1", [&rec.client_id])?;
    Ok(DisconnectResult { client: status_of(conn, env, c)?, notes })
}
