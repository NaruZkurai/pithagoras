import { mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { createSession, findChannelSession, type SessionRow } from "./db.js";

/**
 * The agent's fixed working directory, separate from the per-task workspaces.
 *
 * Kept out of the workspace root deliberately: it is not a project you would
 * start a session against, and listing it as one would be misleading.
 */
export function agentHome(): string {
  const dir = path.resolve(process.env.AGENT_HOME || "/data/agent-home");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Keys come from outside, so they are bounded before touching the database. */
const MAX_KEY = 200;

/**
 * The key a package supplies is namespaced by its channel before storage.
 *
 * The unique index already scopes it, so this is belt and braces — but two
 * channels both picking the obvious key ("general", "default") is likely
 * enough that the stored key is worth making self-describing rather than
 * relying on a constraint nobody reading the table would see.
 */
export const scopeKey = (channelId: string, key: string) => `${channelId}:${key}`;

/** The channel's own key, with the prefix taken back off. */
export const unscopeKey = (channelId: string, stored: string) =>
  stored.startsWith(`${channelId}:`) ? stored.slice(channelId.length + 1) : stored;

/**
 * Find or create the session for one conversation on one channel.
 *
 * The channel package decides what counts as a conversation — a Telegram chat
 * id, a Slack channel, a Discord channel — and the portal turns that key into
 * an isolated session. A group chat and a DM produce different keys, so they
 * get different sessions and never share a memory.
 *
 * The key is scoped to the channel by the unique index, so two channels using
 * the same obvious key ("general") stay separate without either knowing.
 */
export function resolveChannelSession(opts: {
  channelId: string;
  key: string;
  /** Human label for the first time this conversation is seen. */
  title?: string;
  executor: string;
}): { session: SessionRow; created: boolean } {
  const key = String(opts.key ?? "").trim().slice(0, MAX_KEY);
  if (!key) throw new Error("A channel must supply a session key for each conversation");

  const scoped = scopeKey(opts.channelId, key);

  const existing = findChannelSession(opts.channelId, scoped);
  if (existing) return { session: existing, created: false };

  const id = nanoid(12);
  createSession({
    id,
    title: (opts.title ?? "").trim().slice(0, 120) || key,
    workspace: agentHome(),
    executor: opts.executor,
    kind: "agent",
    channel_id: opts.channelId,
    channel_key: scoped,
  });

  // Re-read rather than construct: the row carries defaults this does not set.
  const session = findChannelSession(opts.channelId, scoped);
  if (!session) throw new Error("Failed to create the session for this conversation");
  return { session, created: true };
}
