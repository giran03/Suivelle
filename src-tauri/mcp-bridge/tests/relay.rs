//! Runs the real bridge against a stand-in agent API: sign-in, then lines both ways.
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

fn fake_api(accept: bool) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut out = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut auth = String::new();
        reader.read_line(&mut auth).unwrap();
        assert!(auth.contains("sva_test_token"), "{auth}");
        if !accept {
            writeln!(out, r#"{{"ok":false,"error":"Unknown or revoked agent token."}}"#).unwrap();
            return;
        }
        writeln!(out, r#"{{"ok":true,"agent":"Tester"}}"#).unwrap();
        // Echo each request back as a reply carrying its id.
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            writeln!(out, r#"{{"jsonrpc":"2.0","echo":{}}}"#, line.trim()).unwrap();
            line.clear();
        }
    });
    port
}

fn bridge(port: u16) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_suivelle-mcp"))
        .env("SUIVELLE_AGENT_TOKEN", "sva_test_token")
        .env("SUIVELLE_AGENT_ENDPOINT", format!("127.0.0.1:{port}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn relays_lines_after_signing_in() {
    let mut child = bridge(fake_api(true));
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"ping"}}"#).unwrap();
    let mut reply = String::new();
    stdout.read_line(&mut reply).unwrap();
    assert!(reply.contains(r#""id":1"#) && reply.contains("ping"), "{reply}");
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn reports_a_refused_token() {
    let child = bridge(fake_api(false));
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Unknown or revoked agent token"));
}
