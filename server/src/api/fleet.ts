import express, { type Router } from "express";
import {
  deleteFleetAgent,
  getFleetAgent,
  listFleetAgents,
  upsertFleetAgent,
  type FleetAgentRow,
} from "../db.js";
import { refreshFleet, readyFleetAgents, nextReadySubagent } from "../fleet.js";

const api = (a: FleetAgentRow) => ({
  id: a.id,
  name: a.name,
  host: a.host,
  port: a.port,
  model: a.model,
  role: a.role,
  status: a.status,
  currentTask: a.current_task,
  lastChecked: a.last_checked,
});

/** Base-model fleet registry: the active agents any session can route to. */
export function fleetRouter(): Router {
  const router = express.Router();

  /** List the fleet, optionally refreshed first. */
  router.get("/fleet", (_req, res) => {
    res.json({ agents: listFleetAgents().map(api) });
  });

  /** Probe every agent and return the refreshed picture. */
  router.post("/fleet/refresh", async (_req, res) => {
    const agents = await refreshFleet();
    res.json({ agents: agents.map(api) });
  });

  /** Agents currently usable for a task, and the next ready subagent. */
  router.get("/fleet/ready", (_req, res) => {
    res.json({
      agents: readyFleetAgents().map(api),
      next: nextReadySubagent() ? api(nextReadySubagent()!) : null,
    });
  });

  /** Manually upsert an agent (or mark current_task on an existing one). */
  router.post("/fleet/agents", (req, res) => {
    const b = req.body ?? {};
    const id = String(b.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    upsertFleetAgent({
      id,
      name: String(b.name ?? id).trim(),
      host: String(b.host ?? "").trim() || "192.168.2.64",
      port: Math.max(1, Math.min(65535, Number(b.port) || 6465)),
      model: String(b.model ?? "").trim(),
      role: b.role === "main" ? "main" : "subagent",
    });
    res.json({ agent: api(getFleetAgent(id)!) });
  });

  router.delete("/fleet/agents/:id", (req, res) => {
    deleteFleetAgent(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
