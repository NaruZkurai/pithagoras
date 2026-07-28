import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { agentHome } from "../agent.js";
import {
  channelsDir,
  installChannelPackage,
  loadChannels,
  removeChannelPackage,
  type ChannelField,
  type LoadedChannel,
} from "../channels/loader.js";

/**
 * A channel is a two-way link into the agent: messages arrive through it and
 * the agent's replies go back out the same way. Every channel points at the
 * same agent session, so they are different doors into one conversation.
 *
 * The kinds on offer are whatever channel packages are loaded — the builtins in
 * the repo and anything installed from GitHub or npm. Nothing is hardcoded
 * here, so a third-party package is a first-class citizen.
 */

const kindById = async (id: string) =>
  (await loadChannels()).channels.find((k) => k.id === id);

/** Only what the browser needs: the package's own code stays server-side. */
const kindToApi = (k: LoadedChannel) => ({
  id: k.id,
  label: k.label,
  blurb: k.blurb ?? "",
  fields: k.fields,
  packageName: k.packageName,
  version: k.version,
  builtin: k.builtin,
  runnable: Boolean(k.start),
});

interface ChannelRow {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

const parseConfig = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Strip secrets before anything leaves the process. The browser is told which
 * secrets are set — enough to render "configured" without handing back a token
 * that anyone with the page open could read.
 */
function toApi(row: ChannelRow, kind?: LoadedChannel) {
  const config = parseConfig(row.config);
  const visible: Record<string, unknown> = {};
  const secretsSet: string[] = [];

  for (const field of kind?.fields ?? []) {
    if (field.secret) {
      if (config[field.key]) secretsSet.push(field.key);
    } else {
      visible[field.key] = config[field.key] ?? "";
    }
  }

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: Boolean(row.enabled),
    config: visible,
    secretsSet,
    /** No transport is running yet — say so rather than implying it is live. */
    status: "not connected" as const,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const missingRequired = (kind: LoadedChannel, config: Record<string, unknown>) =>
  kind.fields.filter((f) => f.required && !config[f.key]).map((f) => f.label);

export function channelsRouter(): Router {
  const router = express.Router();

  const rowById = (id: string) =>
    getDb().prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;

  router.get("/channels", async (_req, res) => {
    try {
      const { channels: kinds, broken } = await loadChannels();
      const byId = new Map(kinds.map((k) => [k.id, k]));
      const rows = getDb()
        .prepare("SELECT * FROM channels ORDER BY created_at ASC")
        .all() as ChannelRow[];

      res.json({
        channels: rows.map((r) => toApi(r, byId.get(r.kind))),
        kinds: kinds.map(kindToApi),
        broken,
        agentHome: agentHome(),
        channelsDir: channelsDir(),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/channels", async (req, res) => {
    const { kind: kindId, name, config } = req.body ?? {};
    const kind = typeof kindId === "string" ? await kindById(kindId) : undefined;
    if (!kind) return res.status(400).json({ error: "Unknown channel type" });

    const clean = sanitise(kind, config, {});
    const missing = missingRequired(kind, clean);
    if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });

    const id = nanoid(10);
    getDb()
      .prepare("INSERT INTO channels (id, kind, name, config) VALUES (?, ?, ?, ?)")
      .run(id, kind.id, (typeof name === "string" && name.trim()) || kind.label, JSON.stringify(clean));
    res.json(toApi(rowById(id)!, kind));
  });

  router.patch("/channels/:id", async (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const kind = await kindById(row.kind);
    if (!kind) {
      return res.status(400).json({
        error: `No package provides "${row.kind}" — it may have been uninstalled`,
      });
    }

    const { name, enabled, config } = req.body ?? {};
    const sets: string[] = [];
    const values: unknown[] = [];

    if (typeof name === "string" && name.trim()) {
      sets.push("name = ?");
      values.push(name.trim());
    }
    if (typeof enabled === "boolean") {
      sets.push("enabled = ?");
      values.push(enabled ? 1 : 0);
    }
    if (config && typeof config === "object") {
      const merged = sanitise(kind, config, parseConfig(row.config));
      const missing = missingRequired(kind, merged);
      if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });
      sets.push("config = ?");
      values.push(JSON.stringify(merged));
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      getDb().prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...values, row.id);
    }
    res.json(toApi(rowById(row.id)!, kind));
  });

  router.delete("/channels/:id", (req, res) => {
    getDb().prepare("DELETE FROM channels WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  // --- packages ---

  router.post("/channel-packages", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !spec.trim()) {
      return res.status(400).json({ error: "spec required" });
    }
    try {
      const output = await installChannelPackage(spec.trim());
      const { channels, broken } = await loadChannels(true);
      res.json({ ok: true, output, kinds: channels.map(kindToApi), broken });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/channel-packages/:name", async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const kind = (await loadChannels()).channels.find((k) => k.packageName === name);
    if (kind?.builtin) {
      return res.status(400).json({ error: "Builtin channels ship with the portal" });
    }
    // Configured channels of this kind are left in place deliberately: removing
    // the package should not silently discard credentials. They report the
    // missing package until it is reinstalled or the channel is deleted.
    try {
      await removeChannelPackage(name);
      const { channels, broken } = await loadChannels(true);
      res.json({ ok: true, kinds: channels.map(kindToApi), broken });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}

/**
 * Keep only fields the kind declares, and treat a blank secret as "unchanged" —
 * the browser never receives the stored token, so it cannot send it back, and
 * saving an unrelated field would otherwise wipe it.
 */
function sanitise(
  kind: LoadedChannel,
  incoming: unknown,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const input = (incoming && typeof incoming === "object" ? incoming : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};

  for (const field of kind.fields) {
    const value = input[field.key];
    if (field.secret) {
      if (typeof value === "string" && value.trim()) out[field.key] = value.trim();
      else if (value === null) continue; // explicit clear
      else if (existing[field.key]) out[field.key] = existing[field.key];
    } else if (typeof value === "string") {
      if (value.trim()) out[field.key] = value.trim();
    } else if (existing[field.key] !== undefined) {
      out[field.key] = existing[field.key];
    }
  }
  return out;
}
