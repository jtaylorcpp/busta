/**
 * Twilio, as much as texting needs (designs/2026-09-25-text-busta): send a
 * text from Busta's number, verify a phone with Twilio Verify, check a SIM or
 * carrier change with Lookup, and check that an incoming webhook really came
 * from Twilio. REST over fetch; no SDK.
 *
 * Local development without a Twilio account runs a fake: the Verify code is
 * always 123456 and texts are written to the console instead of sent.
 */

/** What is missing before texting can work; empty when ready. */
export function twilioMissing(env: Env): string[] {
  return (["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SID", "TWILIO_FROM"] as const).filter((k) => !env[k]);
}

/** Local development with no Twilio configured: fake codes and console texts. */
export function twilioFake(env: Env): boolean {
  return env.ENVIRONMENT === "development" && twilioMissing(env).length > 0;
}

export const FAKE_CODE = "123456";

export class TwilioError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null) { super(message); }
}

function basic(env: Env): string {
  // A scoped API key when set (send + verify only); the account's auth token otherwise.
  const user = env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID!;
  const pass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN!;
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

async function post<T>(env: Env, url: string, form: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: basic(env), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; code?: number };
  if (!res.ok) throw new TwilioError(data.message ?? `Twilio ${res.status}`, res.status, data.code ?? null);
  return data;
}

/**
 * A US/Canada number in E.164 (+1XXXXXXXXXX), or null. Busta texts only these:
 * it keeps Verify away from premium international numbers (SMS pumping).
 */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10 || /^[01]/.test(ten)) return null;
  return `+1${ten}`;
}

/** "(916) •••-••42" */
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return `(${d.slice(0, 3)}) •••-••${d.slice(-2)}`;
}

export function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// --- Verify ---------------------------------------------------------------

/** Text a verification code to `phone`. */
export async function startVerify(env: Env, phone: string): Promise<void> {
  if (twilioFake(env)) { console.log(`[fake twilio] verify code for ${phone}: ${FAKE_CODE}`); return; }
  await post(env, `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SID}/Verifications`, { To: phone, Channel: "sms" });
}

/** True when `code` is the one Verify sent to `phone`. */
export async function checkVerify(env: Env, phone: string, code: string): Promise<boolean> {
  if (twilioFake(env)) return code === FAKE_CODE;
  try {
    const r = await post<{ status: string }>(env, `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SID}/VerificationCheck`, { To: phone, Code: code });
    return r.status === "approved";
  } catch (e) {
    // 404: no pending verification (expired, or too many tries).
    if (e instanceof TwilioError && e.status === 404) return false;
    throw e;
  }
}

// --- Messages -------------------------------------------------------------

/** Send one text from Busta's number. */
export async function sendSms(env: Env, to: string, body: string): Promise<{ sid: string }> {
  if (twilioFake(env)) { console.log(`[fake twilio] text to ${to}:\n${body}`); return { sid: `fake-${crypto.randomUUID()}` }; }
  const r = await post<{ sid: string }>(env, `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    From: env.TWILIO_FROM!,
    To: to,
    Body: body,
  });
  return { sid: r.sid };
}

// --- Lookup -----------------------------------------------------------------

export interface LineCheck {
  /** Carrier name, for spotting a port-out since verification. */
  carrier: string | null;
  /** When the SIM was last swapped, if the carrier shares it (needs carrier approval). */
  simSwappedAt: number | null;
  /** The carrier says the SIM changed within its reporting window. */
  simSwappedRecently: boolean | null;
}

/**
 * Carrier and SIM swap for `phone` (Lookup v2). SIM swap data needs carrier
 * approval; until then it comes back empty and the carrier check does the work.
 */
export async function lookupLine(env: Env, phone: string): Promise<LineCheck> {
  if (twilioFake(env)) return { carrier: "Fake Mobile", simSwappedAt: null, simSwappedRecently: null };
  const res = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence,sim_swap`, {
    headers: { authorization: basic(env) },
  });
  const data = (await res.json().catch(() => ({}))) as {
    line_type_intelligence?: { carrier_name?: string | null } | null;
    sim_swap?: { last_sim_swap?: { last_sim_swapped_date?: string | null; swapped_in_period?: boolean | null } | null } | null;
  };
  if (!res.ok) throw new TwilioError(`Lookup ${res.status}`, res.status, null);
  const swap = data.sim_swap?.last_sim_swap ?? null;
  return {
    carrier: data.line_type_intelligence?.carrier_name ?? null,
    simSwappedAt: swap?.last_sim_swapped_date ? Date.parse(swap.last_sim_swapped_date) || null : null,
    simSwappedRecently: swap?.swapped_in_period ?? null,
  };
}

// --- Webhooks ---------------------------------------------------------------

/**
 * Twilio's X-Twilio-Signature: base64 HMAC-SHA1, keyed with the auth token,
 * over the exact public URL followed by each POST parameter's name and value
 * in name order.
 */
export async function validSignature(env: Env, url: string, params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TWILIO_AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Busta's texting number, formatted for display, or null when not set. */
export function bustaNumber(env: Env): string | null {
  return env.TWILIO_FROM ? formatPhone(env.TWILIO_FROM) : null;
}
