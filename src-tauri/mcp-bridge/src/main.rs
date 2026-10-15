//! suivelle-mcp: the stdio side of Suivelle's agent API.
//!
//! An MCP client starts this program and talks to it over stdin/stdout. It finds the running
//! Suivelle (from `agent-api.json` in the local app-data folder), signs in with the agent's
//! token, and then passes messages through in both directions. When Suivelle is not running it
//! starts it in the background (in the tray) and waits for it. It never starts an agent.
//!
//! Token: `SUIVELLE_AGENT_TOKEN`, `--token <token>`, or `--credential <agent id>` to read it from
//! the Windows Credential Manager (where Settings > Agents > Connect apps keeps it).
//! Overrides: `SUIVELLE_AGENT_ENDPOINT=127.0.0.1:<port>`, `SUIVELLE_APP=<path to Suivelle>`.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn fail(msg: &str) -> ! {
    eprintln!("suivelle-mcp: {msg}");
    std::process::exit(1);
}

fn arg(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == name {
            return args.next();
        }
        if let Some(v) = a.strip_prefix(&format!("{name}=")) {
            return Some(v.to_string());
        }
    }
    None
}

fn endpoint_file() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    }?;
    Some(base.join("Suivelle").join("agent-api.json"))
}

/// The port from `{"port": 12345, ...}`, without a JSON library.
fn port_from(json: &str) -> Option<u16> {
    let at = json.find("\"port\"")?;
    let rest = json[at + 6..].trim_start().strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn endpoint() -> Option<String> {
    if let Some(e) = arg("--endpoint").or_else(|| std::env::var("SUIVELLE_AGENT_ENDPOINT").ok()) {
        return Some(e);
    }
    let text = std::fs::read_to_string(endpoint_file()?).ok()?;
    port_from(&text).map(|p| format!("127.0.0.1:{p}"))
}

fn connect() -> Option<TcpStream> {
    let addr = endpoint()?;
    if !(addr.starts_with("127.") || addr.starts_with("localhost:") || addr.starts_with("[::1]")) {
        fail("the agent endpoint must be on this computer (127.0.0.1)");
    }
    TcpStream::connect(addr).ok()
}

fn app_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SUIVELLE_APP") {
        return Some(PathBuf::from(p));
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) { "Suivelle.exe" } else { "Suivelle" };
    // The copy apps run (in the local app-data folder) names the program beside it.
    let recorded = std::fs::read_to_string(dir.join("app-path")).ok().map(|p| PathBuf::from(p.trim()));
    [Some(dir.join(name)), dir.parent().map(|d| d.join(name)), recorded]
        .into_iter()
        .flatten()
        .find(|p| p.exists())
}

/// The token saved for an agent in the Windows Credential Manager.
#[cfg(windows)]
fn credential(agent_id: &str) -> Option<String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        blob_size: u32,
        blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, credential: *mut *mut Credential) -> i32;
        fn CredFree(buffer: *mut c_void);
    }
    let name: Vec<u16> = format!("Suivelle agent {agent_id}").encode_utf16().chain(std::iter::once(0)).collect();
    let mut out: *mut Credential = std::ptr::null_mut();
    // SAFETY: `name` is NUL-terminated; on success `out` is freed with CredFree.
    unsafe {
        if CredReadW(name.as_ptr(), 1, 0, &mut out) == 0 || out.is_null() {
            return None;
        }
        let c = &*out;
        let bytes = std::slice::from_raw_parts(c.blob, c.blob_size as usize).to_vec();
        CredFree(out.cast());
        String::from_utf8(bytes).ok()
    }
}

#[cfg(not(windows))]
fn credential(_agent_id: &str) -> Option<String> {
    None
}

/// Starts Suivelle in the tray and waits for its agent API.
fn launch_and_connect() -> TcpStream {
    let Some(app) = app_path() else {
        fail("Suivelle is not running, and its program was not found next to suivelle-mcp. Open Suivelle (or set SUIVELLE_APP).");
    };
    if std::process::Command::new(&app).arg("--autostart").spawn().is_err() {
        fail(&format!("could not start {}", app.display()));
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(45) {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(s) = connect() {
            return s;
        }
    }
    fail("Suivelle started but its agent API did not answer. Check that it is turned on in Settings > Agents.");
}

fn main() {
    if std::env::args().any(|a| a == "--help" || a == "-h") {
        println!("suivelle-mcp: connect an MCP client to Suivelle.\n\nSet SUIVELLE_AGENT_TOKEN (from Settings > Agents in Suivelle), then add this program as a stdio MCP server, for example:\n  claude mcp add suivelle --env SUIVELLE_AGENT_TOKEN=sva_... -- \"<path>\\suivelle-mcp.exe\"");
        return;
    }
    let saved = arg("--credential").map(|id| {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            fail("--credential takes an agent id");
        }
        credential(&id).unwrap_or_else(|| fail("no saved token for this agent; open Suivelle > Settings > Agents and choose Repair"))
    });
    let token = saved
        .or_else(|| arg("--token"))
        .or_else(|| std::env::var("SUIVELLE_AGENT_TOKEN").ok())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| fail("set SUIVELLE_AGENT_TOKEN to the agent token from Suivelle (Settings > Agents)"));
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        fail("that does not look like a Suivelle agent token");
    }
    let stream = connect().unwrap_or_else(launch_and_connect);
    let _ = stream.set_nodelay(true);
    let mut to_app = stream.try_clone().unwrap_or_else(|e| fail(&e.to_string()));
    let mut from_app = BufReader::new(stream);

    // Sign in.
    if writeln!(to_app, "{{\"auth\":\"{token}\"}}").is_err() {
        fail("lost the connection to Suivelle");
    }
    let mut reply = String::new();
    if from_app.read_line(&mut reply).unwrap_or(0) == 0 {
        fail("Suivelle closed the connection");
    }
    if !reply.contains("\"ok\":true") {
        let msg = reply
            .split("\"error\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .unwrap_or("the agent token was refused");
        fail(msg);
    }

    // Messages from the client to Suivelle; when the client closes stdin, the session ends.
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if to_app.write_all(line.as_bytes()).and_then(|_| to_app.write_all(b"\n")).is_err() {
                break;
            }
        }
        let _ = to_app.shutdown(std::net::Shutdown::Both);
    });
    // Messages from Suivelle to the client, until either side hangs up.
    let stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        match from_app.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let mut out = stdout.lock();
                if out.write_all(line.as_bytes()).and_then(|_| out.flush()).is_err() {
                    break;
                }
            }
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_port() {
        assert_eq!(super::port_from(r#"{"port": 51234, "pid": 9}"#), Some(51234));
        assert_eq!(super::port_from(r#"{"pid":9,"port":80}"#), Some(80));
        assert_eq!(super::port_from("{}"), None);
    }
}
