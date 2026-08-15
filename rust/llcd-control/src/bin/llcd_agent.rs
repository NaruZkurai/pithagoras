//! llcd-agent — runs ON the llama-cpp-direct box (192.168.2.64).
//!
//! A standalone (Rust, no deps, no fleet/portal/model dependency) HTTP control
//! server that lets a controller elsewhere:
//!   - see the box's status + per-model-port health,
//!   - read the model services' logs,
//!   - mark a model inaccessible (signal),
//!   - reboot the box,
//!   - rebuild llama-server from source + restart the service,
//!   - apply a build report from the controller's local fix-agent.
//!
//! Run on the box:   cargo run --bin llcd-agent --release
//! It listens on 0.0.0.0:CTRL_PORT (default 6470).

use llcd_control::{health, read_request, respond, run, run_sh, Request};
use std::collections::VecDeque;
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::Mutex;

const MODEL_PORTS: [u16; 6] = [6464, 6465, 6466, 6467, 6468, 6469];
const DEFAULT_SRC: &str = "/nzk/git/llama.cpp";
const DEFAULT_BIN: &str = "/nzk/git/llama.cpp/build-cuda/bin/llama-server";
const UNITS: [&str; 2] = ["bonsai-api", "bonsai-4b-fleet"];

static SIGNALS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn port() -> u16 {
    std::env::var("CTRL_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(6470)
}

fn model_ports_json() -> String {
    let mut m = String::from("{");
    for p in MODEL_PORTS {
        let h = health("127.0.0.1", p);
        m.push_str(&format!("\"{p}\":\"{}\",", if h { "up" } else { "down" }));
    }
    m.pop(); // trailing comma
    m.push('}');
    m
}

fn unit_logs(lines: usize) -> String {
    let mut out = String::from("{");
    for u in UNITS {
        let (_, log) = run("journalctl", &["-u", u, "--no-pager", "-n", &lines.to_string()]);
        out.push_str(&format!("\"{u}\":{}", serde_escape(&trunc(&log, 3000))));
        out.push(',');
    }
    out.pop();
    out.push('}');
    out
}

fn serde_escape(s: &str) -> String {
    let mut esc = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => esc.push_str("\\\""),
            '\\' => esc.push_str("\\\\"),
            '\n' => esc.push_str("\\n"),
            '\r' => esc.push('\r'),
            c => esc.push(c),
        }
    }
    format!("\"{esc}\"")
}

fn trunc(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…(truncated)", &s[s.len() - n..]) }
}

fn record_signal(kind: &str, detail: &str) {
    let mut q = SIGNALS.lock().unwrap();
    q.push_back(format!(
        "{{\"time\":\"{}\",\"type\":\"{}\",\"detail\":{}}}",
        now_iso(),
        kind,
        serde_escape(detail)
    ));
    while q.len() > 20 { q.pop_front(); }
}

fn now_iso() -> String {
    // Simple ISO-ish timestamp without external deps.
    run_sh("date -u +%Y-%m-%dT%H:%M:%SZ").1
}

fn overview() -> String {
    let up = run_sh("cat /proc/uptime").1;
    let cpu = run_sh("grep 'cpu ' /proc/stat").1;
    format!(
        "{{\"host\":{},\"time\":{},\"uptime\":{},\"cpu\":{},\"modelPorts\":{},\"llamaBin\":{},\"signals\":[{}]}}",
        serde_escape(&run_sh("hostname").1),
        serde_escape(&now_iso()),
        serde_escape(&up),
        serde_escape(&cpu),
        model_ports_json(),
        serde_escape(&std::env::var("LLAMA_BIN").unwrap_or_default()),
        SIGNALS.lock().unwrap().iter().cloned().collect::<Vec<_>>().join(",")
    )
}

fn rebuild() -> Result<String, String> {
    let src = std::env::var("LLAMA_SRC").unwrap_or_else(|_| DEFAULT_SRC.to_string());
    let bin = std::env::var("LLAMA_BIN").unwrap_or_else(|_| DEFAULT_BIN.to_string());
    let (ok, cfg) = run("cmake", &["-S", &src, "-B", &format!("{src}/build-cuda"), "-DGGML_CUDA=ON", "-DCMAKE_BUILD_TYPE=Release", "-DGGML_NATIVE=OFF"]);
    if !ok { return Err(trunc(&cfg, 1500)); }
    let (ok2, build) = run("cmake", &["--build", &format!("{src}/build-cuda"), "--target", "llama-server", "-j", "16"]);
    if !std::path::Path::new(&bin).exists() || !ok2 { return Err(trunc(&build, 1500)); }
    Ok(trunc(&format!("{cfg}\n{build}\nbuilt={bin}"), 3000))
}

fn restart(unit: &str) -> Result<String, String> {
    let s = Command::new("systemctl").args(["restart", unit]).status();
    match s {
        Ok(st) if st.success() => Ok(format!("restarted {unit}")),
        Ok(st) => Err(format!("systemctl restart {unit} failed: {st}")),
        Err(e) => Err(format!("systemctl error: {e}")),
    }
}

fn handle(req: &Request, stream: &mut TcpStream) {
    // CORS preflight is irrelevant; keep it simple.
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/status") => respond(stream, 200, &overview()),
        ("GET", "/health") => respond(stream, 200, "{\"ok\":true}"),
        ("GET", "/logs") => {
            let n = parse_query_num(&req.query, "lines", 60);
            respond(stream, 200, &format!("{{\"time\":{},\"logs\":{}}}", serde_escape(&now_iso()), unit_logs(n)));
        }
        ("POST", "/signal") => {
            let model = extract_field(&req.body, "model").unwrap_or_else(|| "unknown".to_string());
            record_signal("signal", &model);
            println!("signal: model {model} reported inaccessible");
            respond(stream, 200, &format!("{{\"ok\":true,\"status\":{}}}", overview()));
        }
        ("POST", "/reboot") => {
            record_signal("reboot", "requested");
            println!("reboot requested — rebooting in 2s");
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = Command::new("sudo").args(["reboot"]).status();
            });
            respond(stream, 200, "{\"ok\":true,\"message\":\"rebooting\"}");
        }
        ("POST", "/rebuild") => {
            let service = extract_field(&req.body, "service").unwrap_or_else(|| "bonsai-api".to_string());
            record_signal("rebuild", &service);
            println!("rebuild requested for {service}…");
            match rebuild() {
                Ok(build_out) => match restart(&service) {
                    Ok(rstr) => respond(stream, 200, &format!("{{\"ok\":true,\"build\":true,\"restart\":true,\"output\":{},\"logs\":{}}}", serde_escape(&format!("{build_out}\n{rstr}")), unit_logs(60))),
                    Err(e) => respond(stream, 500, &format!("{{\"ok\":false,\"build\":true,\"restart\":false,\"output\":{},\"logs\":{}}}", serde_escape(&e), unit_logs(60))),
                },
                Err(e) => {
                    record_signal("rebuild_failed", &e);
                    respond(stream, 500, &format!("{{\"ok\":false,\"build\":false,\"error\":{},\"logs\":{}}}", serde_escape(&e), unit_logs(60)));
                }
            }
        }
        ("POST", "/report") => {
            let ok = extract_field(&req.body, "ok").map(|s| s == "true").unwrap_or(false);
            let reason = extract_field(&req.body, "reason").unwrap_or_default();
            let service = extract_field(&req.body, "service").unwrap_or_else(|| "bonsai-api".to_string());
            record_signal("report", &format!("ok={ok} reason={reason}"));
            println!("report ok={ok} reason={}", &reason[..reason.len().min(120)]);
            if !ok {
                // Controller's local agent "fixed" it; rebuild + restart.
                match rebuild() { Ok(o) => match restart(&service) { Ok(r) => respond(stream, 200, &format!("{{\"ok\":true,\"output\":{},\"logs\":{}}}", serde_escape(&format!("{o}\n{r}")), unit_logs(60))), Err(e) => respond(stream, 500, &format!("{{\"ok\":false,\"error\":{}}}", serde_escape(&e))) }, Err(e) => respond(stream, 500, &format!("{{\"ok\":false,\"error\":{}}}", serde_escape(&e))) }
            } else {
                respond(stream, 200, "{\"ok\":true}");
            }
        }
        _ => respond(stream, 404, "{\"error\":\"not found\"}"),
    }
}

fn parse_query_num(q: &str, key: &str, default: usize) -> usize {
    q.split('&').find_map(|kv| kv.strip_prefix(&format!("{key}="))).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn extract_field(body: &str, key: &str) -> Option<String> {
    // tiny JSON field extractor (no external dep)
    let bytes = body.as_bytes();
    let bkey = format!("\"{key}\"");
    let start = bytes.windows(bkey.len()).position(|w| w == bkey.as_bytes())? + bkey.len();
    let rest = &body[start..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    if rest.starts_with('"') {
        let inner = rest.trim_start_matches('"');
        let end = inner.find('"')?;
        Some(inner[..end].to_string())
    } else {
        let end = rest.find([',', '}', '\n']).unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

fn main() {
    let p = port();
    let ln = TcpListener::bind(("0.0.0.0", p)).expect("bind llcd-agent");
    println!("llcd-agent: http://0.0.0.0:{p} (standalone, no fleet/portal deps)");
    for stream in ln.incoming() {
        if let Ok(mut s) = stream {
            if let Some(req) = read_request(&mut s) {
                handle(&req, &mut s);
            }
        }
    }
}
