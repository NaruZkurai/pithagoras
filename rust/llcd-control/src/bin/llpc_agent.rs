//! llpc-agent — runs on the CONTROLLER PC (this machine).
//!
//! Receives build-failure reports from the box (llcd-agent), dispatches the
//! failure to a LOCAL agent (the portal's pi) to fix the llama-cpp-direct source,
//! then signals the box to rebuild + restart. Standalone Rust, no fleet deps.
//!
//! Endpoints:
//!   GET  /status                       controller state (last reports, agent status)
//!   GET  /health                       ok
//!   POST /report-from-box              {"ok":false,"reason":"...","output":"...","service":"..."}
//!                                      records a build failure, then runs the local fix
//!                                      agent against the failure to produce a fix.
//!   POST /signal-success               mark that the box is reachable/fixed again
//!
//! The local "fix agent" here is the Pithagoras portal: we start a task session
//! (POST /api/sessions) and prompt it to fix the given build error in the
//! workspace, then report back. If the portal is down, we log the failure and
//! the reason stays non-empty so an operator can act.
//!
//! Run on the PC:  cargo run --bin llpc-agent --release
//! Env: PORT (default 6472), PORTAL (default http://localhost:4100), PASS (default deathlover)

use llcd_control::{read_request, respond, run, Request};
use std::collections::VecDeque;
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;

static REPORTS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static STATE: Mutex<&'static str> = Mutex::new("idle");

fn port() -> u16 { std::env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(6472) }
fn portal() -> String { std::env::var("PORTAL").unwrap_or_else(|_| "http://localhost:4100".into()) }
fn pass() -> String { std::env::var("PASS").unwrap_or_else(|_| "deathlover".into()) }

fn now() -> String { run("/bin/sh", &["-lc", "date -u +%Y-%m-%dT%H:%M:%SZ"]).1 }

fn esc(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), c => o.push(c) }
    }
    format!("\"{o}\"")
}

fn trunc(s: &str, n: usize) -> String { if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) } }

fn push_report(r: String) {
    let mut q = REPORTS.lock().unwrap();
    q.push_back(r);
    while q.len() > 30 { q.pop_front(); }
}

/// Call the local portal's pi agent to fix a build failure in the given workspace.
/// Returns (ok, summary). Best-effort over the portal HTTP API.
fn run_local_fix(workspace: &str, error: &str) -> (bool, String) {
    let portal = portal();
    // login
    let login = req_json(&format!("{portal}/api/auth/login"), "POST", &format!("{{\"username\":\"\",\"password\":{}}}", esc(&pass())));
    let cookie = login
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
        .map(|l| l.split(';').next().unwrap_or("").to_string())
        .unwrap_or_default();
    if cookie.is_empty() { return (false, "portal login failed".into()); }

    // create task session
    let body = format!("{{\"workspace\":{},\"title\":\"llcd-fix\"}}", esc(workspace));
    let sess = req_json(&format!("{portal}/api/sessions"), "POST", &body);
    let id = sess.split("\"id\":\"").nth(1).and_then(|s| s.split('"').next()).map(|s| s.to_string());
    let Some(id) = id else { return (false, "could not create portal session".into()); };

    // prompt the agent to fix the build error
    let task = format!(
        "You are fixing a build failure in the llama-cpp-direct source at this workspace. \
         BUILD ERROR:\n{}\n\nDiagnose the error, edit the source to fix it, and rebuild \
         locally (cmake + make). Report exactly what you changed and whether the build now passes.",
        trunc(error, 4000)
    );
    let _ = req_json(&format!("{portal}/api/sessions/{id}/prompt"), "POST", &esc(&task));
    // We don't wait synchronously for the full fix in this stub; hand the session id
    // back so a supervisor can poll it. (Full polling can be added.)
    (true, format!("dispatched portal session {id} to fix; task sent"))
}

fn req_json(url: &str, method: &str, body: &str) -> String {
    // curl-based HTTP for the controller's outbound calls (no external crate).
    // Returns the response body (or headers+body for login).
    run("/bin/sh", &["-lc", &format!("curl -s -X {} '{}' -H 'content-type: application/json' -d '{}'", method, url, body.replace('\'', "'\\''"))]).1
}

fn handle(req: &Request, stream: &mut TcpStream) {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/status") => {
            let reports = REPORTS.lock().unwrap().iter().cloned().collect::<Vec<_>>().join(",");
            respond(stream, 200, &format!("{{\"controller\":\"llpc-agent\",\"state\":{},\"reports\":[{}]}}", esc(*STATE.lock().unwrap()), reports));
        }
        ("GET", "/health") => respond(stream, 200, "{\"ok\":true}"),
        ("POST", "/report-from-box") => {
            // Body: {"ok":false,"reason":"...","output":"...","service":"...","workspace":"..."}
            let ok = extract(&req.body, "ok").map(|s| s == "true").unwrap_or(false);
            let reason = extract(&req.body, "reason").unwrap_or_else(|| "unknown".into());
            let output = extract(&req.body, "output").unwrap_or_default();
            let service = extract(&req.body, "service").unwrap_or_else(|| "bonsai-api".into());
            let workspace = extract(&req.body, "workspace").unwrap_or_default();

            push_report(format!("{{\"time\":{},\"ok\":{},\"reason\":{},\"service\":{}}}", esc(&now()), ok, esc(&reason), esc(&service)));

            if !ok && !workspace.is_empty() {
                *STATE.lock().unwrap() = "fixing";
                let (fixed, summary) = run_local_fix(&workspace, &format!("{reason}\n{output}"));
                *STATE.lock().unwrap() = if fixed { "fixed_reported" } else { "fix_failed" };
                push_report(format!("{{\"time\":{},\"type\":\"agent_fix\",\"ok\":{},\"summary\":{}}}", esc(&now()), fixed, esc(&summary)));
                respond(stream, fixed.then_some(200).unwrap_or(500), &format!("{{\"ok\":{fixed},\"summary\":{}}}", esc(&summary)));
            } else {
                respond(stream, 200, "{\"ok\":true,\"note\":\"recorded report; no workspace given to fix\"}");
            }
        }
        ("POST", "/signal-success") => {
            *STATE.lock().unwrap() = "idle";
            respond(stream, 200, "{\"ok\":true}");
        }
        _ => respond(stream, 404, "{\"error\":\"not found\"}"),
    }
}

fn extract(body: &str, key: &str) -> Option<String> {
    let bkey = format!("\"{key}\"");
    let bytes = body.as_bytes();
    let pos = bytes.windows(bkey.len()).position(|w| w == bkey.as_bytes())? + bkey.len();
    let rest = body[pos..].trim_start().strip_prefix(':')?.trim_start();
    if rest.starts_with('"') {
        let end = rest[1..].find('"')?;
        Some(rest[1..=end].to_string())
    } else {
        let end = rest.find([',', '}', '\n']).unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

fn main() {
    let p = port();
    let ln = TcpListener::bind(("0.0.0.0", p)).expect("bind llpc-agent");
    println!("llpc-agent (controller): http://0.0.0.0:{p}  portal={}", portal());
    for stream in ln.incoming() {
        if let Ok(mut s) = stream {
            if let Some(req) = read_request(&mut s) {
                handle(&req, &mut s);
            }
        }
    }
}
