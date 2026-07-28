import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { agentHome } from "../agent.js";

/**
 * A channel is a two-way link into the agent: messages arrive through it and
 * the agent's replies go back out the same way. Every channel points at the
 * same agent session, so they are different doors into one conversation rather
 * than separate agents.
 */
export interface ChannelField {
  key: string;
  label: string;
  hint?: string;
  /** Never sent back to the browser once stored. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ChannelKind {
  id: string;
  label: string;
  blurb: string;
  fields: ChannelField[];
}

export const CHANNEL_KINDS: ChannelKind[] = [
  {
    id: "telegram",
    label: "Telegram",
    blurb: "Message a bot; its replies come back in the same chat.",
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        secret: true,
        required: true,
        hint: "From @BotFather",
        placeholder: "123456:ABC-DEF…",
      },
      {
        key: "allowedChatIds",
        label: "Allowed chat IDs",
        hint: "Comma separated. Leave empty and anyone who finds the bot can drive your agent.",
        placeholder: "12345678, -100987654321",
      },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    blurb: "Mention the app in a channel or DM it.",
    fields: [
      { key: "botToken", label: "Bot token", secret: true, required: true, placeholder: "xoxb-…" },
      {
        key: "appToken",
        label: "App token",
        secret: true,
        required: true,
        hint: "Socket Mode token",
        placeholder: "xapp-…",
      },
      { key: "channelId", label: "Channel ID", hint: "Empty means any channel it is invited to" },
    ],
  },
  {
    id: "webhook",
    label: "Webhook",
    blurb: "POST a message in, get the reply in the response body.",
    fields: [
      {
        key: "secret",
        label: "Shared secret",
        secret: true,
        required: true,
        hint: "Sent as the X-Portal-Secret header",
      },
    ],
  },
];

const kindById = (id: string) => CHANNEL_KINDS.find((k) => k.id === id);

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
function toApi(row: ChannelRow) {
  const config = parseConfig(row.config);
  const kind = kindById(row.kind);
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

const missingRequired = (kind: ChannelKind, config: Record<string, unknown>) =>
  kind.fields.filter((f) => f.required && !config[f.key]).map((f) => f.label);

export function channelsRouter(): Router {
  const router = express.Router();

  router.get("/channels", (_req, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM channels ORDER BY created_at ASC")
      .all() as ChannelRow[];
    res.json({ channels: rows.map(toApi), kinds: CHANNEL_KINDS, agentHome: agentHome() });
  });

  router.post("/channels", (req, res) => {
    const { kind: kindId, name, config } = req.body ?? {};
    const kind = typeof kindId === "string" ? kindById(kindId) : undefined;
    if (!kind) return res.status(400).json({ error: "Unknown channel type" });

    const clean = sanitise(kind, config, {});
    const missing = missingRequired(kind, clean);
    if (missing.length) {
      return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });
    }

    const id = nanoid(10);
    getDb()
      .prepare("INSERT INTO channels (id, kind, name, config) VALUES (?, ?, ?, ?)")
      .run(
        id,
        kind.id,
        (typeof name === "string" && name.trim()) || kind.label,
        JSON.stringify(clean)
      );
    res.json(toApi(getDb().prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow));
  });

  router.patch("/channels/:id", (req, res) => {
    const row = getDb().prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id) as
      | ChannelRow
      | undefined;
    if (!row) return res.status(404).json({ error: "Not found" });
    const kind = kindById(row.kind);
    if (!kind) return res.status(400).json({ error: `Unknown channel type "${row.kind}"` });

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
      getDb()
        .prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values, row.id);
    }
    res.json(
      toApi(getDb().prepare("SELECT * FROM channels WHERE id = ?").get(row.id) as ChannelRow)
    );
  });

  router.delete("/channels/:id", (req, res) => {
    getDb().prepare("DELETE FROM channels WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

/**
 * Keep only fields the kind declares, and treat a blank secret as "unchanged" —
 * the browser never receives the stored token, so it cannot send it back, and
 * saving an unrelated field would otherwise wipe it.
 */
function sanitise(
  kind: ChannelKind,
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
