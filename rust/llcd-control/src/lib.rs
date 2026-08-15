//! Shared helpers for the llcd control system (pure std, no external deps).
//!
//! Everything here is deliberately framework-free so it builds standalone with
//! only the Rust standard library — no crates, no network fetch, no dependency
//! on the 4B fleet, the portal, or the model servers. It talks to the OS via
//! `std::process::Command` and serves plain HTTP over a `TcpListener`.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;

/// Run a command, capture combined output; return (exit_ok, output).
/// Never panics — always returns something printable.
pub fn run(cmd: &str, args: &[&str]) -> (bool, String) {
    let out = Command::new(cmd)
        .args(args)
        .output();
    match out {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            if !o.stderr.is_empty() {
                s.push_str(&String::from_utf8_lossy(&o.stderr));
            }
            (o.status.success(), s.trim().to_string())
        }
        Err(e) => (false, format!("{cmd} error: {e}")),
    }
}

/// Run a shell line (with a fallback to plain exec when /bin/sh semantics matter).
pub fn run_sh(line: &str) -> (bool, String) {
    run("/bin/sh", &["-lc", line])
}

/// Is a TCP port answering HTTP /health?
pub fn health(host: &str, port: u16) -> bool {
    match TcpStream::connect((host, port)) {
        Ok(mut s) => {
            let _ = s.write_all(b"GET /health HTTP/1.0\r\n\r\n");
            let mut buf = [0u8; 8];
            let ok = s.read(&mut buf).is_ok();
            let _ = s.set_read_timeout(None);
            ok
        }
        Err(_) => false,
    }
}

// ---- tiny HTTP helpers ------------------------------------------------------

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: String,
}

/// Read one HTTP request (head + up to a small body). Best-effort for the
/// simple endpoints here; not a full HTTP/1.1 parser.
pub fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    // Heuristic: try to also read a Content-Length body (small).
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let mut body_len: usize = 0;
                    for l in head.lines() {
                        let low = l.to_ascii_lowercase();
                        if low.starts_with("content-length:") {
                            if let Some(v) = low.split(':').nth(1).and_then(|s| s.trim().parse::<usize>().ok()) {
                                body_len = v;
                            }
                        }
                    }
                    while buf.len() < head.len() + body_len + 4 && body_len > 0 {
                        match stream.read(&mut tmp) {
                            Ok(0) => break,
                            Ok(k) => buf.extend_from_slice(&tmp[..k]),
                            Err(_) => break,
                        }
                    }
                    break;
                }
                if buf.len() > 64 * 1024 { break; }
            }
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines = text.lines();
    let head = lines.next()?; // e.g. "GET /logs?lines=40 HTTP/1.1"
    let mut parts = head.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Some(Request { method, path, query, body })
}

pub fn respond(stream: &mut TcpStream, code: u16, body: &str) {
    let reason = match code {
        200 => "OK", 400 => "Bad Request", 404 => "Not Found", 500 => "Internal Server Error",
        _ => "OK",
    };
    let payload = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

/// Serve `handler` per connection until the listener is dropped.
pub fn serve(listener: TcpListener, handler: impl Fn(&mut TcpStream) + Send + Sync + 'static) {
    for stream in listener.incoming() {
        if let Ok(mut s) = stream {
            let h = &handler;
            h(&mut s);
        }
    }
}
