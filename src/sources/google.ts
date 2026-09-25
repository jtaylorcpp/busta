/**
 * Google sign-in for connected Gmail accounts, and the check on Gmail's
 * Pub/Sub push requests. Plain fetch + WebCrypto; no Google SDK.
 *
 * Scopes: gmail.modify (read, label, trash, send; it cannot delete
 * permanently) and the user's email address, which becomes the mailbox
 * address and is how Busta knows the account is theirs.
 */
export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** What is missing before Gmail can be connected; empty when ready. */
export function googleMissing(env: Env): string[] {
  return (["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_PUBSUB_TOPIC"] as const).filter((k) => !env[k]);
}

export class GoogleAuthError extends Error {
  /** invalid_grant: the refresh token was revoked or expired; the user must reconnect. */
  constructor(message: string, readonly code: string) { super(message); }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function authUrl(env: Env, input: { redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    // offline + consent: always return a refresh token, even on reconnect.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  if (input.loginHint) q.set("login_hint", input.loginHint);
  return `${AUTH_URL}?${q}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function tokenCall(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new GoogleAuthError(data.error_description ?? data.error ?? `Google token call failed (${res.status})`, data.error ?? String(res.status));
  return data;
}

/** Trade the sign-in code for tokens, and read who signed in. */
export async function exchangeCode(env: Env, input: { code: string; verifier: string; redirectUri: string }) {
  const t = await tokenCall(new URLSearchParams({
    code: input.code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  }));
  if (!t.refresh_token) throw new GoogleAuthError("Google didn't return a refresh token. Remove Busta at myaccount.google.com/permissions and connect again.", "no_refresh_token");
  if (!t.scope?.split(" ").includes("https://www.googleapis.com/auth/gmail.modify")) {
    throw new GoogleAuthError("Busta needs permission to read and organize your mail. Connect again and leave that box checked.", "scope_denied");
  }
  // The ID token came straight from Google's token endpoint over TLS, so its
  // claims can be read without re-verifying the signature.
  const claims = t.id_token ? (JSON.parse(new TextDecoder().decode(unb64url(t.id_token.split(".")[1]!))) as { email?: string; email_verified?: boolean }) : {};
  if (!claims.email || claims.email_verified === false) throw new GoogleAuthError("Google didn't confirm the account's email address.", "no_email");
  return { email: claims.email.toLowerCase(), refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

export async function refreshAccess(env: Env, refreshToken: string) {
  const t = await tokenCall(new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }));
  return { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

/** Tell Google to drop Busta's access. Best effort: the token is deleted here either way. */
export async function revoke(token: string): Promise<boolean> {
  const res = await fetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  return res.ok;
}

// --- Pub/Sub push authentication -------------------------------------------

interface Jwk { kid: string; n: string; e: string; kty: string; alg?: string }
let certs: { at: number; keys: Jwk[] } | null = null;

async function googleKeys(): Promise<Jwk[]> {
  if (certs && Date.now() - certs.at < 3_600_000) return certs.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Couldn't fetch Google's signing keys (${res.status})`);
  certs = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  return certs.keys;
}

/**
 * Check a push request's `Authorization: Bearer <jwt>`: signed by Google,
 * for our endpoint (aud), from our push service account (email), unexpired.
 */
export async function verifyPushJwt(env: Env, authorization: string | null, audience: string): Promise<boolean> {
  const jwt = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!jwt || !env.PUBSUB_PUSH_SA) return false;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(unb64url(h))) as { alg: string; kid: string };
    const claims = JSON.parse(new TextDecoder().decode(unb64url(p))) as { iss: string; aud: string; email: string; email_verified: boolean; exp: number };
    if (header.alg !== "RS256") return false;
    const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(s), new TextEncoder().encode(`${h}.${p}`));
    return ok
      && (claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com")
      && claims.aud === audience
      && claims.email === env.PUBSUB_PUSH_SA
      && claims.email_verified === true
      && claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
