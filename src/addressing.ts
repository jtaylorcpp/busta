/**
 * Address parsing and signed thread tokens.
 *
 * Inbound replies are pinned to a thread by a sub-address tag
 * (`sales+<threadId>.<sig>@domain`), not by `In-Reply-To`. RFC threading
 * headers are attacker-controlled: anyone who learns a Message-ID could
 * otherwise drop a message into an existing conversation. Cloudflare removed
 * their own header-based resolver for exactly this (IDOR via spoofed headers),
 * so the trusted path here is HMAC-signed and the RFC path is best-effort only.
 */

/**
 * Local-parts we accept when provisioning. Deliberately conservative.
 *
 * The trailing `(?!.*\.\.)` lookahead rejects consecutive dots. RFC 5321's
 * dot-atom is dot-*separated*, so `jesse..taylor@` is not a valid address at
 * all — without this it passed validation here and then failed later at
 * Cloudflare's routing API, turning a typo into a mailbox latched as `failed`.
 */
const LOCAL_PART = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * Addresses the system owns, created on demand when mail first arrives.
 *
 * These are the destinations published in DNS — the DMARC `rua=` and the
 * TLS-RPT `rua=`. They have to accept mail from the moment those records go
 * live, and nobody signs up to receive them, so they cannot depend on a user
 * claiming them: an unowned address is refused at ingest, which would have
 * silently bounced every aggregate report the domain ever asked for.
 */
export const SYSTEM_LOCAL_PARTS = new Set(["dmarc", "tls-reports"]);

const RESERVED_LOCAL_PARTS = new Set([
  "abuse",
  "admin",
  "administrator",
  "hostmaster",
  "postmaster",
  "root",
  "security",
  "webmaster",
  // Reserved so a user named `dmarc` cannot claim the address the domain's
  // own DMARC record points at.
  ...SYSTEM_LOCAL_PARTS,
]);

const THREAD_ID_BYTES = 8;
const SIGNATURE_HEX = 16;

/**
 * The one reserved sub-address namespace. A tag is system-owned only when its
 * first dot-separated segment is `t`; everything else is a user label.
 * `+tuesday` is a label, `+t.ab12.cd34` is a thread token — the dot is what
 * makes the difference, so the reservation costs users one string, not the
 * whole `+tag` space.
 *
 * Agents deliberately have no namespace here. The generalized email agent is
 * instantiated per mailbox address, so the address already names the instance;
 * an agent that needs to specialize reads the user label off the message.
 */
export const TAG_NAMESPACE = { thread: "t" } as const;

/** User labels may not start with a reserved namespace followed by a dot. */
const LABEL = /^[a-z0-9][a-z0-9._+=-]{0,62}$/;

export function normalizeAddress(raw: string): string {
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1]! : raw).trim().toLowerCase();
}

export function isValidLocalPart(local: string): boolean {
  return LOCAL_PART.test(local) && !RESERVED_LOCAL_PARTS.has(local);
}

export function isValidLabel(label: string): boolean {
  return LABEL.test(label);
}

/**
 * Turn a Clerk username into a mailbox local-part.
 *
 * The two namespaces do not agree. Clerk permits uppercase and underscores and
 * knows nothing about the reserved names here, so a username it accepted at
 * sign-up can still be an address this system must refuse. Normalising is
 * limited to case, which changes nothing about who the user is.
 *
 * Underscores are deliberately NOT rewritten to dots. Silently handing someone
 * `jane.doe@` when they chose `jane_doe` gives them an address they will get
 * wrong every time they say it out loud, and one that does not match the name
 * they see everywhere else. Returning null instead sends them to the claim
 * form, where they pick the address knowingly.
 *
 * `suggestion` is a best-effort starting point for that form, not a decision.
 */
export function localPartFromUsername(
  username: string,
): { ok: true; localPart: string } | { ok: false; reason: string; suggestion: string | null } {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return { ok: false, reason: "your account has no username", suggestion: null };

  if (isValidLocalPart(normalized)) return { ok: true, localPart: normalized };

  if (RESERVED_LOCAL_PARTS.has(normalized)) {
    return {
      ok: false,
      reason: `"${normalized}" is reserved for system mail`,
      suggestion: null,
    };
  }

  // Length is checked before character content so the message names the real
  // problem: "contains characters an address cannot use" is simply wrong for a
  // username that is perfectly well-formed and merely too long.
  const tooLong = normalized.length > 64;

  // Strip what an address cannot carry, then trim to the allowed edges.
  const cleaned = normalized
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 64)
    // Slicing can leave a trailing separator that was interior a moment ago.
    .replace(/[^a-z0-9]+$/, "");

  return {
    ok: false,
    reason: tooLong
      ? `"${username}" is too long for an email address (64 characters maximum)`
      : `"${username}" contains characters an email address cannot use`,
    suggestion: cleaned && isValidLocalPart(cleaned) ? cleaned : null,
  };
}

export type ParsedTag =
  | { kind: "thread"; threadId: string; signature: string }
  | { kind: "label"; label: string };

/**
 * Classify a sub-address tag.
 *
 * Returns null for a malformed system token — a broken `t.` tag must not
 * silently degrade into a user label, or the namespace boundary would be
 * decorative.
 */
export function parseTag(tag: string): ParsedTag | null {
  if (!tag) return null;

  const dot = tag.indexOf(".");
  if (dot > 0) {
    const namespace = tag.slice(0, dot);
    const rest = tag.slice(dot + 1);

    if (namespace === TAG_NAMESPACE.thread) {
      const split = rest.indexOf(".");
      if (split <= 0) return null;
      return {
        kind: "thread",
        threadId: rest.slice(0, split),
        signature: rest.slice(split + 1),
      };
    }

  }

  return isValidLabel(tag) ? { kind: "label", label: tag } : null;
}

/** `sales+newsletter@example.com` — a plain user label for filtering. */
export function labelAddress(mailbox: string, label: string): string {
  return replyToAddress(mailbox, label);
}

export interface ParsedRecipient {
  /** The mailbox address with any `+tag` removed — this is the DO key. */
  mailbox: string;
  localPart: string;
  domain: string;
  /** The raw sub-address tag, if present. */
  tag: string | null;
}

/** Splits `sales+abc.def@example.com` into mailbox `sales@example.com` + tag. */
export function parseRecipient(raw: string): ParsedRecipient {
  const address = normalizeAddress(raw);
  const at = address.lastIndexOf("@");
  if (at < 0) return { mailbox: address, localPart: address, domain: "", tag: null };

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const plus = local.indexOf("+");

  if (plus < 0) return { mailbox: address, localPart: local, domain, tag: null };

  const base = local.slice(0, plus);
  return {
    mailbox: `${base}@${domain}`,
    localPart: base,
    domain,
    tag: local.slice(plus + 1) || null,
  };
}

export function newThreadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(THREAD_ID_BYTES));
  return hex(bytes);
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
  return hex(new Uint8Array(signature)).slice(0, SIGNATURE_HEX);
}

/**
 * Build the reply tag for a thread. Bound to the mailbox as well as the thread
 * so a token minted for one mailbox cannot be replayed against another.
 */
export async function signThreadTag(
  secret: string,
  mailbox: string,
  threadId: string,
): Promise<string> {
  const signature = await hmacHex(secret, `${normalizeAddress(mailbox)}|${threadId}`);
  return `${TAG_NAMESPACE.thread}.${threadId}.${signature}`;
}

/** Returns the thread id only if the tag carries a valid signature. */
export async function verifyThreadTag(
  secret: string,
  mailbox: string,
  parsed: Extract<ParsedTag, { kind: "thread" }>,
): Promise<string | null> {
  const { threadId, signature } = parsed;
  if (!/^[0-9a-f]+$/.test(threadId) || !/^[0-9a-f]+$/.test(signature)) return null;

  const expected = await hmacHex(secret, `${normalizeAddress(mailbox)}|${threadId}`);
  return timingSafeEqual(signature, expected) ? threadId : null;
}

/** Compares without leaking match position through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Address to send replies from, so responses route back to this thread. */
export function replyToAddress(mailbox: string, tag: string): string {
  const { localPart, domain } = parseRecipient(mailbox);
  return `${localPart}+${tag}@${domain}`;
}

/**
 * Stable synthetic Message-ID for mail that arrives without one, so Email
 * Routing retries are deduplicated instead of delivered twice.
 */
export async function syntheticMessageId(raw: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return `<${hex(new Uint8Array(digest)).slice(0, 32)}@synthetic.local>`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
