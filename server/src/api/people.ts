import express, { type Router } from "express";
import { forgetPerson, getPerson, listPeople, setRole, type Role } from "../people.js";
import { getDb } from "../db.js";

/**
 * The roster.
 *
 * Everyone who has ever spoken to the agent, including the ones it turned away
 * — that is the point. A stranger's id is recorded so you can promote them from
 * a list, rather than having to go and find their id on the platform.
 */

const ROLES: Role[] = ["primary", "colleague", "guest", "unknown"];

export function peopleRouter(): Router {
  const router = express.Router();

  router.get("/people", (_req, res) => {
    res.json({ people: listPeople() });
  });

  router.patch("/people/:key", (req, res) => {
    const key = req.params.key;
    if (!getPerson(key)) return res.status(404).json({ error: "Not found" });

    const { role, name, notes } = req.body ?? {};
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}` });
    }
    // One primary. Promoting somebody demotes whoever held it, rather than
    // leaving two people the agent treats as its owner.
    if (role === "primary") {
      getDb().prepare("UPDATE people SET role = 'colleague' WHERE role = 'primary' AND key != ?").run(key);
    }
    if (typeof notes === "string") {
      getDb().prepare("UPDATE people SET notes = ? WHERE key = ?").run(notes.trim(), key);
    }
    if (role) setRole(key, role, typeof name === "string" ? name : undefined);
    else if (typeof name === "string" && name.trim()) {
      getDb().prepare("UPDATE people SET name = ? WHERE key = ?").run(name.trim(), key);
    }
    res.json({ person: getPerson(key) });
  });

  /**
   * Forgetting somebody is not the same as blocking them: the next message
   * makes them unknown again, which is refused and announced. Blocking is what
   * "unknown" already does.
   */
  router.delete("/people/:key", (req, res) => {
    forgetPerson(req.params.key);
    res.json({ ok: true });
  });

  return router;
}
