/**
 * The Google sign-in round trip for Connect Gmail. Between leaving for Google
 * and coming back, what we need to finish (PKCE verifier, the options chosen,
 * who started it) rides in a short-lived cookie signed with THREAD_SECRET;
 * `state` ties Google's answer to that cookie.
 */
import type { AstroCookies } from "astro";

export const CONNECT_COOKIE = "busta_connect";
const TEN_MINUTES = 600;

export interface ConnectTicket {
  state: string;
  verifier: string;
  userId: string;
  orgId: string;
  days: number;
  copyFolders: boolean;
  exp: number;
}

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`connect:${data}`))));
}

export async function setTicket(cookies: AstroCookies, secret: string, t: Omit<ConnectTicket, "exp">, secure: boolean) {
  const body = b64url(enc.encode(JSON.stringify({ ...t, exp: Date.now() + TEN_MINUTES * 1000 })));
  cookies.set(CONNECT_COOKIE, `${body}.${await hmac(secret, body)}`, {
    path: "/oauth/google", httpOnly: true, secure, sameSite: "lax", maxAge: TEN_MINUTES,
  });
}

export async function takeTicket(cookies: AstroCookies, secret: string): Promise<ConnectTicket | null> {
  const raw = cookies.get(CONNECT_COOKIE)?.value;
  cookies.delete(CONNECT_COOKIE, { path: "/oauth/google" });
  if (!raw) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig || sig !== (await hmac(secret, body))) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as ConnectTicket;
    return t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}

/** Where Google sends the user back: this origin, so local and production each use their own. */
export const redirectUri = (url: URL) => `${url.origin}/oauth/google/callback`;
