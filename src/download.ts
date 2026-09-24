/**
 * Signed, expiring download links for attachments too large to send inline.
 *
 * Cloudflare caps a message at 5 MiB after MIME encoding, and receiving mail
 * servers cap lower still — Gmail at 25 MB, Outlook at 20 MB, many corporate
 * gateways at 10 MB. Streaming does not help: the limit is on the size of the
 * message, not on how the Worker holds the bytes. So anything large is stored
 * in R2 and the mail carries a link instead, which is what Gmail and Outlook
 * do above their own caps.
 *
 * The token is self-contained — key plus expiry, HMAC'd — so verification
 * needs no lookup and no state. Recipients are external mail users who cannot
 * authenticate to us, so the signature is the only protection: it must be
 * unguessable, scoped to one object, and time-limited.
 */

const SIGNATURE_HEX = 32;

interface DownloadClaim {
  /** R2 key of the object. */
  k: string;
  /** Expiry, epoch ms. */
  e: number;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, SIGNATURE_HEX);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signDownloadToken(
  secret: string,
  r2Key: string,
  expiresAt: number,
): Promise<string> {
  const claim: DownloadClaim = { k: r2Key, e: expiresAt };
  const payload = base64UrlEncode(JSON.stringify(claim));
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export type DownloadVerdict =
  | { ok: true; key: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "invalid" | "expired" };

export async function verifyDownloadToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<DownloadVerdict> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Verify before parsing: the payload is attacker-supplied until the HMAC
  // says otherwise, so nothing inside it is trusted first.
  const expected = await hmacHex(secret, payload);
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: "invalid" };

  const json = base64UrlDecode(payload);
  if (json === null) return { ok: false, reason: "malformed" };

  let claim: DownloadClaim;
  try {
    claim = JSON.parse(json) as DownloadClaim;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof claim.k !== "string" || typeof claim.e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claim.e <= now) return { ok: false, reason: "expired" };

  return { ok: true, key: claim.k, expiresAt: claim.e };
}

export function downloadUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/d/${token}`;
}
