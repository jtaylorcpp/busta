/**
 * Making and finding one-time links (src/link-do.ts). A token is 128 random
 * bits, base64url; only its SHA-256 names the LinkDO, so nothing stored can
 * be turned back into a working link.
 */
import { LINK_TTL_MS, type LinkRecord } from "../link-do";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function tokenHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function linkStub(env: Env, token: string) {
  return env.LINK.get(env.LINK.idFromName(await tokenHash(token)));
}

/** A well-formed token, before anything is looked up. */
export const validToken = (t: string) => /^[A-Za-z0-9_-]{22}$/.test(t);

/** Create a link; returns its public URL (busta.app/v/… or /a/…). */
export async function createLink(env: Env, record: Omit<LinkRecord, "createdAt" | "expiresAt">): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  await (await linkStub(env, token)).create({ ...record, createdAt: now, expiresAt: now + LINK_TTL_MS });
  const base = (env.PUBLIC_BASE_URL ?? "https://busta.app").replace(/\/$/, "");
  return `${base}/${record.kind === "email" ? "v" : "a"}/${token}`;
}

/** Cookie holding a link's session id, scoped to that link's own path. */
export const SESSION_COOKIE = "bl";
