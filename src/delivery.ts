/**
 * Delivery outcome classification.
 *
 * A send can fail in two very different ways, and conflating them loses mail:
 *
 *   - **Synchronously**, as a thrown error from the binding. Some of these are
 *     the operator's fault and will never succeed (unverified domain, bad
 *     header); others are the world being busy and will succeed on retry.
 *   - **Asynchronously**, as a bounce (DSN) delivered back to us minutes or
 *     hours later. The binding already returned a messageId by then, so the
 *     message looks sent until the bounce arrives.
 *
 * Cloudflare already retries soft bounces and maintains its own suppression
 * list. This layer exists for what it cannot do for us: keep the message,
 * surface why it failed, and retry the transient cases that never reached
 * Cloudflare at all.
 */

import { buildMime, GmailError } from "./sources/gmail";
import { gmailFor } from "./sources/vault";

/** Codes that will never succeed on retry. Retrying them wastes quota. */
const PERMANENT_CODES = new Set([
  "E_GMAIL_AUTH",
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

/** Codes worth retrying with backoff. */
const TRANSIENT_CODES = new Set([
  "E_DELIVERY_FAILED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
]);

export type DeliveryStatus = "sent" | "queued" | "failed" | "bounced";

export interface DeliveryVerdict {
  status: "failed" | "queued";
  code: string;
  message: string;
  /** What the operator should actually do about it. */
  remedy: string;
}

const REMEDIES: Record<string, string> = {
  E_GMAIL_AUTH: "Google no longer accepts Busta's access to this Gmail. Reconnect it in Accounts.",
  E_SENDER_NOT_VERIFIED: "Run `wrangler email sending enable <domain>` and try again.",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "MAIL_DOMAIN is not onboarded to Email Service.",
  E_RECIPIENT_SUPPRESSED: "This address hard-bounced or complained. Remove it from the list.",
  E_RECIPIENT_NOT_ALLOWED:
    "Before a sending domain is onboarded you may only send to verified destinations.",
  E_CONTENT_TOO_LARGE: "Reduce attachments — large files should be sent as download links.",
  E_TOO_MANY_RECIPIENTS: "Cloudflare allows 50 recipients per message across to, cc and bcc.",
  E_TOO_MANY_ATTACHMENTS: "Cloudflare allows 32 attachments per message.",
  E_RATE_LIMIT_EXCEEDED: "Sending too fast. Queued for retry.",
  E_DAILY_LIMIT_EXCEEDED: "Daily quota reached. Queued until it resets.",
  E_INTERNAL_SERVER_ERROR: "Email Service is temporarily unavailable. Queued for retry.",
  E_DELIVERY_FAILED: "The recipient's server rejected the message. Queued for retry.",
};

/** Pull the code off whatever the binding threw. */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  // Some failures arrive as a plain Error whose message embeds the code.
  const text = error instanceof Error ? error.message : String(error);
  return text.match(/\bE_[A-Z_]+\b/)?.[0] ?? "E_UNKNOWN";
}

/**
 * Decide what to do with a failed send.
 *
 * Unknown codes are treated as transient. A retry of something permanent
 * costs a little quota; dropping something transient loses the user's mail,
 * so the asymmetry favours retrying.
 */
export function classify(error: unknown): DeliveryVerdict {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const permanent = PERMANENT_CODES.has(code);

  return {
    status: permanent ? "failed" : "queued",
    code,
    message,
    remedy:
      REMEDIES[code] ??
      (permanent
        ? "This will not succeed on retry — fix the message and send again."
        : TRANSIENT_CODES.has(code)
          ? "Queued for retry."
          : "Unrecognised error, treated as temporary and queued for retry."),
  };
}

export function isPermanent(code: string): boolean {
  return PERMANENT_CODES.has(code);
}

/**
 * Backoff schedule, in milliseconds. Deliberately finite: a message that has
 * not gone out in roughly a day is not going to, and leaving it queued
 * forever hides the failure from the person who could fix it.
 */
const BACKOFF_MS = [
  60_000, // 1 min
  300_000, // 5 min
  900_000, // 15 min
  3_600_000, // 1 hour
  14_400_000, // 4 hours
  43_200_000, // 12 hours
];

export const MAX_ATTEMPTS = BACKOFF_MS.length;

export function nextAttemptDelay(attempts: number): number | null {
  return attempts < BACKOFF_MS.length ? BACKOFF_MS[attempts]! : null;
}

/**
 * Everything needed to attempt a send, and nothing that needs a Durable Object
 * stub. Attachments are referenced by R2 key rather than carried inline, so a
 * queued message costs a row rather than a copy of its own payload — and a
 * retry hours later reads the same bytes that were archived at compose time.
 */
export interface OutboundPayload {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: { filename: string; contentType: string; r2Key: string }[];
  /** Send through the mailbox's connected Gmail instead of Email Sending. */
  via?: "gmail";
  /** Gmail thread to reply in. */
  gmailThread?: string | null;
}

export interface Delivered {
  messageId: string;
  /** Set when sent through Gmail: its id and thread, to link the sent copy. */
  gmail?: { id: string; threadId: string };
}

/**
 * Perform one send attempt. Deliberately storage-free: callers decide what a
 * success or failure means, which is what lets the same function serve both
 * the interactive path and the retry alarm.
 */
export async function deliver(env: Env, payload: OutboundPayload): Promise<Delivered> {
  // Development-only fault injection. Every rejection path — permanent,
  // transient, retry-until-exhausted — has to be exercisable before a real
  // domain exists, because that is exactly when it is cheap to get wrong.
  if (env.ENVIRONMENT === "development" && env.FAULT_CODE) {
    throw Object.assign(new Error(`Injected fault: ${env.FAULT_CODE}`), {
      code: env.FAULT_CODE,
    });
  }

  if (payload.via === "gmail") return deliverViaGmail(env, payload);

  const attachments = [];
  for (const attachment of payload.attachments) {
    const object = await env.MAIL_ARCHIVE.get(attachment.r2Key);
    // A missing archived file must not silently send a message without it.
    if (!object) throw new Error(`Archived attachment missing: ${attachment.r2Key}`);
    attachments.push({
      filename: attachment.filename,
      content: await object.arrayBuffer(),
      type: attachment.contentType || "application/octet-stream",
      disposition: "attachment" as const,
    });
  }

  return env.EMAIL.send({
    to: payload.to,
    ...(payload.cc.length > 0 ? { cc: payload.cc } : {}),
    ...(payload.bcc.length > 0 ? { bcc: payload.bcc } : {}),
    from: payload.from,
    replyTo: payload.replyTo,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    ...(Object.keys(payload.headers).length > 0 ? { headers: payload.headers } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

/**
 * Send as the connected Gmail account: Google delivers it and keeps it in
 * Gmail's Sent. Errors are mapped onto the same codes as Email Sending, so
 * the retry and "failed" handling above apply unchanged.
 */
async function deliverViaGmail(env: Env, payload: OutboundPayload): Promise<Delivered> {
  const gmail = gmailFor(env, payload.from);
  const attachments = [];
  for (const a of payload.attachments) {
    const object = await env.MAIL_ARCHIVE.get(a.r2Key);
    if (!object) throw new Error(`Archived attachment missing: ${a.r2Key}`);
    attachments.push({ filename: a.filename, contentType: a.contentType, content: await object.arrayBuffer() });
  }
  const mime = buildMime({ ...payload, attachments });
  try {
    const sent = await gmail.sendRaw(mime, payload.gmailThread);
    const meta = await gmail.getHeaders(sent.id, ["Message-ID"]).catch(() => null);
    const messageId = meta?.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value ?? `<gmail-${sent.id}@mail.gmail.com>`;
    return { messageId, gmail: { id: sent.id, threadId: sent.threadId } };
  } catch (e) {
    const code = e instanceof GmailError
      ? e.status === 401 || e.status === 403 ? "E_GMAIL_AUTH" : e.status === 429 ? "E_RATE_LIMIT_EXCEEDED" : e.status >= 500 ? "E_INTERNAL_SERVER_ERROR" : "E_VALIDATION_ERROR"
      : "E_INTERNAL_SERVER_ERROR";
    throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code });
  }
}
