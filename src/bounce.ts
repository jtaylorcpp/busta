import type { Email } from "postal-mime";

/**
 * Bounce (DSN) recognition for inbound mail.
 *
 * A message accepted by the binding can still fail later, and the only notice
 * is a delivery status notification mailed back to us. Without this, a bounced
 * message sits in the thread looking delivered forever.
 *
 * DSNs are standardised by RFC 3464, but plenty of servers emit approximations,
 * so recognition is deliberately layered: the formal report first, then the
 * conventions almost everyone follows.
 */

export interface BounceReport {
  /** Whether this inbound message is a bounce at all. */
  isBounce: boolean;
  /** 5.x.x is permanent, 4.x.x is temporary. */
  permanent: boolean;
  /** RFC 3463 status, e.g. "5.1.1". */
  status: string | null;
  /** The address that failed, not the address that told us. */
  failedRecipient: string | null;
  /** Message-ID of the original outbound message, when the DSN includes it. */
  originalMessageId: string | null;
  diagnostic: string | null;
}

const NOT_A_BOUNCE: BounceReport = {
  isBounce: false,
  permanent: false,
  status: null,
  failedRecipient: null,
  originalMessageId: null,
  diagnostic: null,
};

function header(email: Email, key: string): string | null {
  return email.headers.find((h) => h.key === key)?.value ?? null;
}

/** Addresses that, by long convention, only ever send delivery reports. */
function fromMailerDaemon(address: string): boolean {
  const local = address.toLowerCase().split("@")[0] ?? "";
  return local === "mailer-daemon" || local === "postmaster" || local === "double-bounce";
}

/**
 * Read the `message/delivery-status` part.
 *
 * postal-mime surfaces it as an attachment rather than a body part, so the
 * fields are parsed out of its raw text here.
 */
function parseDeliveryStatus(text: string): Partial<BounceReport> {
  const field = (name: string) =>
    text.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;

  const action = field("Action")?.toLowerCase() ?? null;
  const status = field("Status");
  const finalRecipient = field("Final-Recipient") ?? field("Original-Recipient");

  return {
    status,
    // "failed" is the only action that means the message is not coming back.
    permanent: action === "failed" && (status?.startsWith("5") ?? false),
    failedRecipient: finalRecipient
      ? (finalRecipient.split(";").pop() ?? finalRecipient).trim().toLowerCase()
      : null,
    diagnostic: field("Diagnostic-Code"),
  };
}

function decodeAttachment(content: string | ArrayBuffer | Uint8Array): string {
  if (typeof content === "string") return content;
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return new TextDecoder().decode(bytes);
}

export function detectBounce(email: Email, envelopeFrom: string): BounceReport {
  const contentType = (header(email, "content-type") ?? "").toLowerCase();
  const isReport = contentType.includes("multipart/report") && contentType.includes("delivery-status");

  // An empty Return-Path is the standard marker for a notification that must
  // never itself be bounced — a strong signal even without a formal report.
  const returnPath = (email.returnPath ?? header(email, "return-path") ?? "").trim();
  const nullReturnPath = returnPath === "<>" || returnPath === "";
  const daemon = fromMailerDaemon(email.from?.address ?? envelopeFrom);

  if (!isReport && !(daemon && nullReturnPath)) return NOT_A_BOUNCE;

  let parsed: Partial<BounceReport> = {};
  let originalMessageId: string | null = null;

  for (const attachment of email.attachments) {
    const mime = (attachment.mimeType ?? "").toLowerCase();
    const text = decodeAttachment(attachment.content);

    if (mime.includes("delivery-status")) {
      parsed = parseDeliveryStatus(text);
      continue;
    }

    // The returned copy of the original — usually message/rfc822, sometimes
    // text/rfc822-headers when the server only sends headers back.
    if (mime.includes("rfc822")) {
      originalMessageId = text.match(/^Message-ID\s*:\s*(<[^>]+>)/im)?.[1] ?? null;
    }
  }

  // Some servers put the reference directly in the DSN's own headers.
  originalMessageId ??= header(email, "original-message-id") ?? header(email, "in-reply-to");

  const status = parsed.status ?? null;

  return {
    isBounce: true,
    // Without a parsable status, assume temporary: wrongly suppressing a real
    // address is worse than retrying one that will fail again.
    permanent: parsed.permanent ?? false,
    status,
    failedRecipient: parsed.failedRecipient ?? null,
    originalMessageId,
    diagnostic: parsed.diagnostic ?? null,
  };
}

/** Human-readable summary for the message view. */
export function describeBounce(report: BounceReport): string {
  const parts: string[] = [];
  if (report.failedRecipient) parts.push(`Delivery to ${report.failedRecipient} failed`);
  else parts.push("Delivery failed");
  if (report.status) parts.push(`(${report.status})`);
  if (report.diagnostic) parts.push(`— ${report.diagnostic.slice(0, 200)}`);
  return parts.join(" ");
}
