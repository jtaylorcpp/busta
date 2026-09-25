import type { Email } from "postal-mime";

/**
 * Filterable metadata extracted at ingest.
 *
 * Everything here is derivable from the raw MIME, which R2 keeps forever — so
 * a field missed today can be backfilled by re-parsing rather than lost. The
 * reason to capture it now is cost: re-parsing millions of archived messages
 * is far more expensive than reading headers once on the way in.
 *
 * These columns live on the mailbox index, which is the scarce resource (one
 * row per message, ~10 GB ceiling). Bulky header data goes to ThreadDO, which
 * holds one object per conversation instead.
 */

/** Bit flags. Packed into one integer so a dozen booleans cost 8 bytes. */
export const FLAG = {
  /** RFC 3834 Auto-Submitted, or Precedence: auto_reply — a bot, not a person. */
  autoSubmitted: 1 << 0,
  isReply: 1 << 1,
  isForward: 1 << 2,
  hasAttachments: 1 << 3,
  hasHtml: 1 << 4,
  multiRecipient: 1 << 5,
  /** Precedence: bulk/list, or a List-Id — newsletters and mailing lists. */
  bulk: 1 << 6,
  hasCalendar: 1 << 7,
  highImportance: 1 << 8,
} as const;

/** Two bits per mechanism: 0 absent, 1 pass, 2 fail, 3 other. */
export const AUTH = { none: 0, pass: 1, fail: 2, other: 3 } as const;

export interface MessageMetadata {
  fromName: string | null;
  toCount: number;
  ccCount: number;
  /** List-Id / List-Post identifier, the single best newsletter filter. */
  listId: string | null;
  /** Subject with Re:/Fwd: stripped — groups conversations across threads. */
  subjectKey: string;
  flags: number;
  /** spf | dkim << 2 | dmarc << 4 */
  auth: number;
  bodyChars: number;
}

function header(email: Email, key: string): string | null {
  const found = email.headers.find((h) => h.key === key);
  return found ? found.value : null;
}

/**
 * The server whose authentication verdict we believe, by how the mail reached
 * us: Cloudflare Email Routing for mail to busta.app, Google for mail imported
 * from Gmail. Anyone can put an Authentication-Results header in a message
 * they send, so a verdict counts only from the one server that received it
 * for us; trusting both everywhere would let a sender forge Google's.
 */
export const AUTHSERV = { routing: ["mx.cloudflare.net"], gmail: ["mx.google.com"] } as const;

/**
 * The verdict line from a trusted server: Authentication-Results, or the
 * ARC-Authentication-Results a forwarder adds ("i=1; mx.cloudflare.net; …").
 * The first trusted one wins; the topmost header was added last, closest to us.
 */
export function trustedAuthResults(email: Email, trusted: readonly string[]): string {
  for (const key of ["authentication-results", "arc-authentication-results"]) {
    for (const h of email.headers.filter((x) => x.key === key)) {
      const value = h.value.replace(/^\s*i=\d+\s*;\s*/i, "");
      const authserv = value.split(";")[0]?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (trusted.includes(authserv)) return value;
    }
  }
  return "";
}

function authResult(results: string, mechanism: string): number {
  const match = results.match(new RegExp(`\\b${mechanism}=(\\w+)`, "i"));
  if (!match) return AUTH.none;
  const verdict = match[1]!.toLowerCase();
  if (verdict === "pass") return AUTH.pass;
  if (verdict === "fail" || verdict === "softfail" || verdict === "permerror") return AUTH.fail;
  return AUTH.other;
}

const PREFIX = /^\s*(re|fw|fwd|aw|sv|vs|res|antw)\s*(\[\d+\])?\s*:\s*/i;

/**
 * Strip the whole stack of reply/forward prefixes and report which were seen.
 *
 * `Re: Fwd: Quote` is both a reply and a forward, so the prefixes have to be
 * peeled in a loop — checking only the first one misclassifies every nested
 * subject, which is most of them in a real thread.
 */
export function parseSubject(subject: string): {
  key: string;
  isReply: boolean;
  isForward: boolean;
} {
  let value = subject.trim();
  let isReply = false;
  let isForward = false;

  for (;;) {
    const match = value.match(PREFIX);
    if (!match) break;
    const kind = match[1]!.toLowerCase();
    if (kind === "fw" || kind === "fwd") isForward = true;
    else isReply = true;
    value = value.slice(match[0].length);
  }

  return {
    key: value.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120),
    isReply,
    isForward,
  };
}

export function normalizeSubject(subject: string): string {
  return parseSubject(subject).key;
}

export function extractMetadata(email: Email, attachmentCount: number, trusted: readonly string[] = AUTHSERV.routing): MessageMetadata {
  const subject = email.subject ?? "";
  const parsedSubject = parseSubject(subject);
  const listId = header(email, "list-id") ?? header(email, "list-post");
  const precedence = (header(email, "precedence") ?? "").toLowerCase();
  const autoSubmitted = (header(email, "auto-submitted") ?? "").toLowerCase();
  const importance = (header(email, "importance") ?? header(email, "x-priority") ?? "").toLowerCase();

  const toCount = email.to?.length ?? 0;
  const ccCount = email.cc?.length ?? 0;

  let flags = 0;
  if (
    (autoSubmitted && autoSubmitted !== "no") ||
    precedence === "auto_reply" ||
    header(email, "x-auto-response-suppress") !== null
  ) {
    flags |= FLAG.autoSubmitted;
  }
  if (email.inReplyTo || parsedSubject.isReply) flags |= FLAG.isReply;
  if (parsedSubject.isForward) flags |= FLAG.isForward;
  if (attachmentCount > 0) flags |= FLAG.hasAttachments;
  if (email.html) flags |= FLAG.hasHtml;
  if (toCount + ccCount > 1) flags |= FLAG.multiRecipient;
  if (listId || precedence === "bulk" || precedence === "list") flags |= FLAG.bulk;
  if (email.attachments.some((a) => a.mimeType?.includes("calendar"))) flags |= FLAG.hasCalendar;
  if (importance === "high" || importance === "1" || importance === "2") flags |= FLAG.highImportance;

  const results = trustedAuthResults(email, trusted);
  const auth =
    authResult(results, "spf") |
    (authResult(results, "dkim") << 2) |
    (authResult(results, "dmarc") << 4);

  return {
    fromName: email.from?.name?.trim() || null,
    toCount,
    ccCount,
    // List-Ids are bracketed and often long; the bare identifier is enough.
    listId: listId ? (listId.match(/<([^>]+)>/)?.[1] ?? listId).slice(0, 120) : null,
    subjectKey: parsedSubject.key,
    flags,
    auth,
    bodyChars: (email.text ?? email.html ?? "").length,
  };
}

export function decodeFlags(flags: number): string[] {
  return Object.entries(FLAG)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name);
}

export function decodeAuth(auth: number): { spf: string; dkim: string; dmarc: string } {
  const name = (value: number) =>
    (["none", "pass", "fail", "other"] as const)[value & 0b11] ?? "none";
  return { spf: name(auth), dkim: name(auth >> 2), dmarc: name(auth >> 4) };
}
