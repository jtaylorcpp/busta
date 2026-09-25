/**
 * Secrets for connected accounts (Gmail). Declared here rather than generated
 * by `wrangler types`: they are set with `wrangler secret put` and may not
 * exist yet, so the code checks them and says what is missing. The Pub/Sub
 * topic and push account are plain vars in wrangler.jsonc.
 */
interface GoogleSourceEnv {
  /** OAuth client (Google Cloud → Clients). Secret. */
  GOOGLE_CLIENT_ID?: string;
  /** Secret. */
  GOOGLE_CLIENT_SECRET?: string;
  /** 32 random bytes, base64. Seals refresh tokens at rest. Secret. */
  SOURCE_TOKEN_KEY?: string;
}
interface Env extends GoogleSourceEnv {}
declare namespace Cloudflare {
  interface Env extends GoogleSourceEnv {}
}
