import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getUser, migrateUser, upsertUser } from "./db.js";

/**
 * Portal gate.
 *
 * This portal can run arbitrary code on the host, so even on a Tailscale-only
 * network it should not be drivable by anything that happens to reach the port.
 *
 * Two ways in:
 *  - No username -> the legacy shared PORTAL_PASSWORD (the primary user).
 *  - A username  -> a portal account from the `users` table (e.g.
 *    naruzkurai / cc), stored as an scrypt hash. Seeded on boot.
 *
 * The cookie is an HMAC of an expiry stamp + username — no session store.
 */
const PASSWORD = process.env.PORTAL_PASSWORD || "";
const SECRET = process.env.PORTAL_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "pi_portal_auth";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const authEnabled = PASSWORD.length > 0;

if (!authEnabled) {
  console.warn(
    "\n  WARNING: PORTAL_PASSWORD is not set — the portal is open to anyone who\n" +
      "  can reach it, and it can run arbitrary commands on this machine.\n" +
      "  Set PORTAL_PASSWORD (and PORTAL_SECRET to keep logins across restarts).\n"
  );
}

// scrypt password hashing: scrypt$<saltHex>$<hashHex>
function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")): string {
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyHashed(password: string, stored: string): boolean {
  if (!stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = crypto.scryptSync(password, salt, 32);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Seed the second portal user (naruzkurai / cc) if not present. */
export function seedUsers(): void {
  if (!authEnabled) return;
  // Migrate a legacy mistyped account (narukurai -> naruzkurai) if it exists.
  migrateUser("narukurai", "naruzkurai");
  const pass = process.env.NARUZKURAI_PASSWORD || "cc";
  upsertUser("naruzkurai", hashPassword(pass), "naruzkurai");
}

function sign(expiry: number, username: string): string {
  const body = `${expiry}.${username}`;
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return `${body}.${mac}`;
}

function verify(token: string | undefined): { ok: boolean; username?: string } {
  if (!token) return { ok: false };
  const parts = token.split(".");
  if (parts.length >= 3) {
    // expiry.username.mac
    const expiry = Number(parts[0]);
    if (expiry < Date.now()) return { ok: false };
    const username = parts.slice(1, -1).join(".");
    const mac = parts[parts.length - 1];
    const expected = crypto.createHmac("sha256", SECRET).update(`${expiry}.${username}`).digest("hex");
    const a = Buffer.from(mac ?? "");
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return ok ? { ok, username } : { ok: false };
  }
  // Legacy expiry.mac — primary user.
  const [expiryStr, mac] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return { ok: false };
  const expected = crypto.createHmac("sha256", SECRET).update(expiryStr).digest("hex");
  const a = Buffer.from(mac ?? "");
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok, username: "primary" } : { ok: false };
}

export function issueCookie(res: Response, username = "primary"): void {
  res.cookie(COOKIE, sign(Date.now() + MAX_AGE_MS, username), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
  });
}

export function checkPassword(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !authEnabled) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify a login. username absent -> the legacy PORTAL_PASSWORD; a username
 * -> that account in the users table.
 */
export function verifyUser(username: unknown, password: unknown): boolean {
  if (!authEnabled || typeof password !== "string") return false;
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!name) return checkPassword(password);
  const user = getUser(name);
  if (!user || !user.password) return false;
  return verifyHashed(password, user.password);
}

/** The username behind a valid cookie, or undefined. */
export function authedUser(req: Request): string | undefined {
  return verify(req.cookies?.[COOKIE]).username;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled) return next();
  if (verify(req.cookies?.[COOKIE]).ok) return next();
  res.status(401).json({ error: "Unauthorized" });
}

export function isAuthed(req: Request): boolean {
  return !authEnabled || verify(req.cookies?.[COOKIE]).ok;
}
