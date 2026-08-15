import {
  getFleetAgent,
  listFleetAgents,
  listModelServers,
  updateFleetAgentStatus,
  upsertFleetAgent,
  type FleetAgentRow,
} from "./db.js";

/**
 * Fleet monitor — track the base-model agents on the LAN.
 *
 * The box at 192.168.2.64 runs the 27B main (bonsai-api:6464) plus the 4B
 * fleet (bonsai-4b-f1..f5:6465-6469). Any of them can be used by any agent as
 * a base for subagent / small tasks. This module keeps a liveness/busy picture
 * in the `fleet_agents` table:
 *   - seed() copies the model_servers into fleet_agents (so the registry
 *     exists without manual step).
 *   - refresh() probes each agent's /health and /slots, marking it up / busy
 *     (any slot processing) / down, and stamps last_checked.
 * status meanings:
 *   up      = reachable and not currently processing
 *   busy    = reachable and a slot is processing (don't route new work here)
 *   down    = /health failed
 *   unknown = never checked yet
 */

const HEALTH_TIMEOUT_MS = 4000;

async function probe(host: string, port: number): Promise<FleetAgentRow["status"]> {
  try {
    const health = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!health.ok) return "down";
    // A reachable server that isn't processing is ready for a task.
    try {
      const slots = await fetch(`http://${host}:${port}/slots`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const arr = (await slots.json()) as { is_processing?: boolean }[];
      const busy = arr.some((s) => s?.is_processing);
      return busy ? "busy" : "up";
    } catch {
      return "up"; // no /slots → treat reachable as up
    }
  } catch {
    return "down";
  }
}

/**
 * Copy model_servers into fleet_agents as a starting registry. Idempotent: only
 * inserts rows that do not exist yet, so manual edits survive.
 */
export function seedFleetFromModelServers(): void {
  for (const s of listModelServers()) {
    if (!s.host || s.host === "127.0.0.1" || s.host === "localhost") continue; // remote fleet only
    if (!getFleetAgent(s.name)) {
      upsertFleetAgent({
        id: s.name,
        name: s.name,
        host: s.host,
        port: s.port,
        model: s.model || "unknown",
        role: s.port === 6464 ? "main" : "subagent",
      });
    }
  }
}

/** Probe every registered fleet agent and update its status. Returns the list. */
export async function refreshFleet(): Promise<FleetAgentRow[]> {
  const agents = listFleetAgents();
  await Promise.all(
    agents.map(async (a) => {
      const status = await probe(a.host, a.port);
      updateFleetAgentStatus(a.id, { status, lastHealth: new Date().toISOString() });
    })
  );
  return listFleetAgents();
}

/** Agents currently usable for a task: reachable and not busy, or all if none ready. */
export function readyFleetAgents(): FleetAgentRow[] {
  return listFleetAgents().filter((a) => a.status === "up" || a.status === "busy");
}

/** The next subagent (a, b, c, d, e fashion) that is currently usable. */
export function nextReadySubagent(): FleetAgentRow | undefined {
  return listFleetAgents()
    .sort((a, b) => a.port - b.port)
    .find((a) => a.role === "subagent" && (a.status === "up" || a.status === "busy"));
}
