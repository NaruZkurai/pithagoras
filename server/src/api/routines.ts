import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { getDb, listRoutineSessions } from "../db.js";
import { isValidSlug, slugify } from "../slug.js";
import { isValidCron, nextRun, parseCron } from "../routines/cron.js";
import { routineSupervisor, type RoutineRow } from "../routines/supervisor.js";

/**
 * Scheduled work: a standing instruction, a cron expression, and a record of
 * how the last run went.
 */

const toApi = (row: RoutineRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  enabled: Boolean(row.enabled),
  schedule: row.schedule,
  instructions: row.instructions,
  freshSession: Boolean(row.fresh_session),
  lastRun: row.last_run,
  lastStatus: routineSupervisor.isRunning(row.slug) ? "running" : row.last_status,
  lastOutput: row.last_output,
  lastMs: row.last_ms,
  nextRun: row.next_run,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Slugs own the sessions, so two routines must never share one. */
function freeSlug(desired: string, exceptId?: string): string {
  const base = slugify(desired) || "routine";
  const taken = new Set(
    (getDb().prepare("SELECT id, slug FROM routines").all() as { id: string; slug: string }[])
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`Could not find a free slug for "${desired}"`);
}

export function routinesRouter(): Router {
  const router = express.Router();

  const rowById = (id: string) =>
    getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | undefined;

  router.get("/routines", (_req, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM routines ORDER BY created_at ASC")
      .all() as RoutineRow[];
    res.json({ routines: rows.map(toApi) });
  });

  router.post("/routines", (req, res) => {
    const { name, schedule, instructions, freshSession } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }
    if (typeof schedule !== "string" || !schedule.trim()) {
      return res.status(400).json({ error: "schedule required" });
    }
    const bad = isValidCron(schedule);
    if (bad) return res.status(400).json({ error: bad });

    const id = nanoid(10);
    const slug = freeSlug(typeof req.body?.slug === "string" && req.body.slug ? req.body.slug : name);
    getDb()
      .prepare(
        `INSERT INTO routines (id, slug, name, schedule, instructions, fresh_session, next_run)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        slug,
        name.trim(),
        schedule.trim(),
        typeof instructions === "string" ? instructions.trim() : "",
        freshSession ? 1 : 0,
        nextRun(parseCron(schedule))?.toISOString() ?? null
      );
    res.json(toApi(rowById(id)!));
  });

  router.patch("/routines/:id", (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });

    const { name, slug, schedule, instructions, enabled, freshSession } = req.body ?? {};
    const sets: string[] = [];
    const values: unknown[] = [];

    if (typeof slug === "string" && slug.trim() && slug.trim() !== row.slug) {
      const next = slugify(slug);
      if (!isValidSlug(next)) return res.status(400).json({ error: `"${slug}" is not a usable slug` });
      const clash = getDb()
        .prepare("SELECT id FROM routines WHERE slug = ? AND id != ?")
        .get(next, row.id);
      if (clash) return res.status(409).json({ error: `Another routine already uses "${next}"` });
      sets.push("slug = ?");
      values.push(next);
    }
    if (typeof name === "string" && name.trim()) {
      sets.push("name = ?");
      values.push(name.trim());
    }
    if (typeof schedule === "string" && schedule.trim()) {
      const bad = isValidCron(schedule);
      if (bad) return res.status(400).json({ error: bad });
      sets.push("schedule = ?");
      values.push(schedule.trim());
    }
    if (typeof instructions === "string") {
      sets.push("instructions = ?");
      values.push(instructions.trim());
    }
    if (typeof enabled === "boolean") {
      sets.push("enabled = ?");
      values.push(enabled ? 1 : 0);
    }
    if (typeof freshSession === "boolean") {
      sets.push("fresh_session = ?");
      values.push(freshSession ? 1 : 0);
    }

    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      getDb().prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`).run(...values, row.id);
      routineSupervisor.refreshSchedules();
    }
    res.json(toApi(rowById(row.id)!));
  });

  router.delete("/routines/:id", (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.json({ ok: true });
    // Its sessions are left alone: they are the record of what it did, and
    // deleting the schedule is not the same as wanting that gone.
    getDb().prepare("DELETE FROM routines WHERE id = ?").run(row.id);
    res.json({ ok: true, keptSessions: listRoutineSessions(row.slug).length });
  });

  /** Run it now. Returns once the run finishes, which can be a while. */
  router.post("/routines/:id/run", async (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    try {
      res.json(toApi(await routineSupervisor.run(row, "manual")));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** What a schedule would do next, without saving it. */
  router.post("/routines/preview", (req, res) => {
    const schedule = req.body?.schedule;
    if (typeof schedule !== "string") return res.status(400).json({ error: "schedule required" });
    const bad = isValidCron(schedule);
    if (bad) return res.status(400).json({ error: bad });

    const cron = parseCron(schedule);
    const runs: string[] = [];
    let at = new Date();
    for (let i = 0; i < 5; i++) {
      const next = nextRun(cron, at);
      if (!next) break;
      runs.push(next.toISOString());
      at = next;
    }
    res.json({ expression: cron.expression, runs });
  });

  router.get("/routines/:id/sessions", (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ sessions: listRoutineSessions(row.slug) });
  });

  return router;
}
