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
}
interface Env extends GoogleSourceEnv {}
declare namespace Cloudflare {
  interface Env extends GoogleSourceEnv {}
}

/** Texting (src/sms). The account SID and auth token are secrets; TWILIO_FROM is Busta's number. */
interface TwilioEnv {
  TWILIO_ACCOUNT_SID?: string;
  /** Also signs incoming webhooks. Secret. */
  TWILIO_AUTH_TOKEN?: string;
  /** Optional scoped API key for sending and Verify. Secret. */
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  /** Twilio Verify Service SID. Secret. */
  TWILIO_VERIFY_SID?: string;
  /** Busta's texting number, E.164. */
  TWILIO_FROM?: string;
}
interface Env extends TwilioEnv {}
declare namespace Cloudflare {
  interface Env extends TwilioEnv {}
}
