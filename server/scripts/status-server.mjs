#!/usr/bin/env node
/**
 * status-server.mjs — a tiny independent status/log server on :6470.
 *
 * Purpose: when the model box (192.168.2.64) keeps dropping off the network,
 * it's hard to see why from another machine. This little server runs ON the box
 * and reports what's actually happening — the model servers' systemd logs, their
 * health, and the host's own uptime/state — on a stable port. Even if the portal
 * or llama.cpp dies, this keeps answering so you can tell "box down" from
 * "llama down".
 *
 * Endpoints:
 *   GET /            overview (host, uptime, model port health, cpu/mem)
 *   GET /health      "ok" (200) whenever this server itself is up
 *   GET /logs        tail of the model services' journald logs (n lines each)
 *   GET /logs?unit=bonsai-api   tail one unit specifically
 *
 * Run (on the box):
 *   node server/scripts/status-server.mjs
 * Env:
 *   STATUS_PORT     (default 6470)
 *   UNITS           space-separated systemd units to tail (default "bonsai-api bonsai-4b-fleet")
 *   LOG_LINES       lines per unit (default 40)
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import os from "node:os";

const PORT = Number(process.env.STATUS_PORT || 6470);
const UNITS = (process.env.UNITS || "bonsai-api bonsai-4b-fleet").split(/\s+/).filter(Boolean);
const LINES = Number(process.env.LOG_LINES || 40);
const HOST = process.env.MODEL_HOST || "127.0.0.1";
const MODEL_PORTS = [6464, 6465, 6466, 6467, 6468, 6469];

/** Run a command, capture stdout; return '' on error (never throw). */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return (e?.stdout || e?.message || "").toString().trim();
  }
}

function healthOf(port) {
  try {
    const out = execFileSync("curl", ["-sf", "-m", "3", `http://${HOST}:${port}/health`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return Boolean(out);
  } catch {
    return false;
  }
}

function unitLogs(unit, lines) {
  // journalctl -u <unit> --no-pager -n <lines>  (falls back to reading a log file if present)
  return run("journalctl", ["-u", unit, "--no-pager", "-n", String(lines)]) ||
    run("bash", ["-lc", `sudo -n journalctl -u ${unit} --no-pager -n ${lines} 2>/dev/null || cat /var/log/${unit}.log 2>/dev/null || true`]);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

const overview = () => {
  const cpus = os.cpus().length;
  const load = os.loadavg();
  const mem = os.totalmem() / 1024 ** 3;
  const memFree = os.freemem() / 1024 ** 3;
  const ports = {};
  for (const p of MODEL_PORTS) ports[p] = healthOf(p) ? "up" : "down";
  return {
    host: os.hostname(),
    ip: HOST,
    time: new Date().toISOString(),
    uptimeSec: Math.round(os.uptime()),
    cpuLoad: load,           // 1/5/15 min
    cpuCount: cpus,
    memGb: { total: +mem.toFixed(1), free: +memFree.toFixed(1) },
    modelPorts: ports,
    units: UNITS,
  };
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  res.setHeader("access-control-allow-origin", "*");

  if (url.pathname === "/health" || url.pathname === "/") {
    if (url.pathname === "/health") return json(res, 200, { ok: true, time: new Date().toISOString() });
    return json(res, 200, overview());
  }

  if (url.pathname === "/logs") {
    const unit = url.searchParams.get("unit");
    const logs = {};
    const list = unit ? [unit] : UNITS;
    for (const u of list) {
      logs[u] = unitLogs(u, LINES) || "(no logs found — unit may not exist or journald unavailable)";
    }
    return json(res, 200, { time: new Date().toISOString(), logs });
  }

  json(res, 404, { error: "not found", endpoints: ["/", "/health", "/logs?unit=bonsai-api"] });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`status-server: http://0.0.0.0:${PORT}  (reporting ${UNITS.join(", ")})`);
});
