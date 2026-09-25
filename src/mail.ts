import PostalMime, { type Attachment as ParsedAttachment } from "postal-mime";
import {
  normalizeAddress,
  parseRecipient,
  parseTag,
  replyToAddress,
  signThreadTag,
  SYSTEM_LOCAL_PARTS,
  syntheticMessageId,
  verifyThreadTag,
} from "./addressing";
import {
  classify,
  deliver,
  nextAttemptDelay,
  type OutboundPayload,
  type Delivered,
} from "./delivery";
import { downloadUrl, signDownloadToken } from "./download";
import { describeBounce, detectBounce } from "./bounce";
import { extractMetadata, type MessageMetadata } from "./metadata";
import type { ThreadAttachment, ThreadMessage } from "./thread-do";

export { decodeAuth, decodeFlags, extractMetadata, FLAG } from "./metadata";
export {
  isValidLabel,
  isValidLocalPart,
  SYSTEM_LOCAL_PARTS,
  labelAddress,
  normalizeAddress,
  parseRecipient,
  parseTag,
} from "./addressing";

const SNIPPET_LENGTH = 140;

/**
 * Raw attachment budget for one outbound message.
 *
 * Cloudflare caps a message at 5 MiB, but that is the *encoded* size and MIME
 * base64 inflates bytes by 4/3. Budgeting raw bytes against the raw cap would
 * produce sends that fail at the binding with no useful explanation, so the
 * default leaves room for the encoding and the headers.
 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 3_500_000;
/** Any single file above this is always linked rather than attached. */
const DEFAULT_INLINE_ATTACHMENT_BYTES = 2_000_000;
const DEFAULT_DOWNLOAD_LINK_DAYS = 30;
const MAX_ATTACHMENT_COUNT = 10;
/** Cloudflare's hard message ceiling, for the error message only. */
export const PROVIDER_MESSAGE_LIMIT = 5 * 1024 * 1024;

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
}

export class AttachmentError extends Error {}

/** Strip path separators and control characters from a user-supplied name. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "attachment";
  const cleaned = base.replace(/[\u0000-\u001f"]/g, "").trim();
  return (cleaned || "attachment").slice(0, 200);
}

export function attachmentBudget(env: Env): number {
  const configured = Number(env.MAX_ATTACHMENT_BYTES ?? DEFAULT_MAX_ATTACHMENT_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_ATTACHMENT_BYTES;
}

export function inlineThreshold(env: Env): number {
  const configured = Number(env.INLINE_ATTACHMENT_BYTES ?? DEFAULT_INLINE_ATTACHMENT_BYTES);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_INLINE_ATTACHMENT_BYTES;
}

export function linkLifetimeMs(env: Env): number {
  const days = Number(env.DOWNLOAD_LINK_DAYS ?? DEFAULT_DOWNLOAD_LINK_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_DOWNLOAD_LINK_DAYS) * 86_400_000;
}

/** Rejects before hitting the binding, so the operator gets a real reason. */
export function validateAttachments(env: Env, attachments: OutboundAttachment[]): void {
  if (attachments.length === 0) return;

  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentError(
      `Too many attachments (${attachments.length}). The limit is ${MAX_ATTACHMENT_COUNT}.`,
    );
  }
}

/**
 * Split attachments into what rides along in the MIME and what becomes a
 * link. Oversize files are no longer an error — they are stored in R2 and
 * linked, because a 5 MiB message cap cannot be argued with.
 */
export function partitionAttachments(
  env: Env,
  attachments: OutboundAttachment[],
): { inline: OutboundAttachment[]; linked: OutboundAttachment[] } {
  const perFile = inlineThreshold(env);
  const budget = attachmentBudget(env);

  const inline: OutboundAttachment[] = [];
  const linked: OutboundAttachment[] = [];
  let used = 0;

  for (const att of attachments) {
    const size = att.content.byteLength;
    if (size > perFile || used + size > budget) {
      linked.push(att);
      continue;
    }
    inline.push(att);
    used += size;
  }

  return { inline, linked };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const DEFAULT_SEARCH_BODY_CHARS = 2000;

/**
 * How much of a body goes into the full-text index.
 *
 * This is the single biggest lever on mailbox capacity. Measured, FTS5 costs
 * roughly 2.4x the indexed text, so every 1000 characters indexed costs about
 * 2.4 KB per message. Set `SEARCH_BODY_CHARS` to 0 to index only subject,
 * sender and snippet.
 */
function searchBodyOf(env: Env, text: string | null, html: string | null): string {
  const configured = Number(env.SEARCH_BODY_CHARS ?? DEFAULT_SEARCH_BODY_CHARS);
  const budget = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SEARCH_BODY_CHARS;
  if (budget === 0) return "";
  return (text ?? stripHtml(html ?? "")).replace(/\s+/g, " ").trim().slice(0, budget);
}

export function mailboxStub(env: Env, address: string) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(normalizeAddress(address)));
}

export function threadStub(env: Env, mailbox: string, threadId: string) {
  // Scoped by mailbox so the same thread id in two mailboxes never collides.
  return env.THREAD.get(env.THREAD.idFromName(`${normalizeAddress(mailbox)}|${threadId}`));
}

export function tenantStub(env: Env, orgId: string) {
  return env.TENANT.get(env.TENANT.idFromName(orgId));
}

function r2Prefix(address: string): string {
  return `mail/${encodeURIComponent(normalizeAddress(address))}`;
}

function snippetOf(text: string | null, html: string | null): string {
  const source = text ?? stripHtml(html ?? "");
  return source.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function toArrayBuffer(content: ParsedAttachment["content"]): ArrayBuffer {
  if (typeof content === "string") return new TextEncoder().encode(content).buffer as ArrayBuffer;
  if (content instanceof Uint8Array) {
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
  }
  return content;
}

// ---- inbound ------------------------------------------------------------

export interface IngestResult {
  status: "stored" | "duplicate" | "rejected" | "bounce";
  reason?: string;
  messageId?: string;
  threadId?: string;
  /** Whether the thread was chosen by a signed tag rather than RFC headers. */
  trustedThread?: boolean;
  /** How the `+tag` on the recipient address was classified, if any. */
  tag?: { kind: string; value: string } | null;
  /** Whether this mailbox's agent is configured to act on this message. */
  agentHandles?: boolean;
  metadata?: MessageMetadata;
  bounce?: {
    permanent: boolean;
    status: string | null;
    failedRecipient: string | null;
    matched: boolean;
    suppressed: boolean;
  };
}

/**
 * Parse an inbound message, back it up to R2, then write it to its ThreadDO
 * and the mailbox index.
 *
 * Mail addressed to an unprovisioned mailbox is rejected rather than stored:
 * accepting it would mean holding mail no tenant can ever read.
 */
/**
 * The organization that owns system mailboxes until a human takes them.
 *
 * Deliberately not a Clerk organization id. Clerk ids are all `org_`-prefixed,
 * so this cannot collide with a real tenant, and no signed-in session can ever
 * carry it — which means the ownership check that gates every mailbox route
 * refuses these addresses to everybody by default, rather than handing them to
 * whoever asks first.
 */
export const SYSTEM_ORG_ID = "system:reports";

/** Is this one of the addresses the domain's own DNS records point at? */
export function isSystemAddress(address: string, domain: string): boolean {
  const at = address.indexOf("@");
  if (at < 0) return false;
  return (
    address.slice(at + 1).toLowerCase() === domain.toLowerCase() &&
    SYSTEM_LOCAL_PARTS.has(address.slice(0, at).toLowerCase())
  );
}

/**
 * How a connected account's mail differs from mail delivered here: it can be
 * mail you sent (from Gmail's Sent), its time is the provider's, and its
 * threading headers are the provider's to vouch for.
 */
export interface IngestOptions {
  direction?: "in" | "out";
  /** The provider's received time (Gmail internalDate), ms. */
  receivedAt?: number;
  /** Don't mark header-threaded messages as unverified. */
  trustThread?: boolean;
}

export async function ingest(
  env: Env,
  envelope: { from: string; to: string; rawSize: number },
  raw: ArrayBuffer,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const outbound = options.direction === "out";
  const recipient = parseRecipient(envelope.to);
  const address = recipient.mailbox;
  const mailbox = mailboxStub(env, address);

  let owner = await mailbox.ownerOrgId();
  if (!owner && isSystemAddress(address, env.MAIL_DOMAIN)) {
    // Create it on first use rather than at deploy time. The DNS records that
    // point here are applied by a separate script, so there is no moment when
    // "the system is set up" is reliably true — but the first report arriving
    // is exactly that moment, and it carries the proof.
    const claim = await mailbox.claim(SYSTEM_ORG_ID, address);
    owner = claim.ownerOrgId;
    await tenantStub(env, SYSTEM_ORG_ID).addMailbox(
      address,
      address.slice(0, address.indexOf("@")),
      env.MAIL_DOMAIN,
      "System reports",
    );
  }
  if (!owner) {
    return { status: "rejected", reason: `No mailbox provisioned for ${address}` };
  }
  if (await mailbox.backfillPending()) await mailbox.backfill();

  const parsed = await PostalMime.parse(raw);

  // A delivery report is about a message we sent, not a new conversation.
  // Recognise it before threading, or it lands as a stray reply from
  // MAILER-DAEMON and the original still looks delivered.
  const bounce = outbound ? { isBounce: false as const } : detectBounce(parsed, envelope.from);
  if (bounce.isBounce) {
    const description = describeBounce(bounce);
    const applied = await mailbox.applyBounce({
      originalMessageId: bounce.originalMessageId,
      failedRecipient: bounce.failedRecipient,
      permanent: bounce.permanent,
      status: bounce.status,
      description,
    });
    return {
      status: "bounce",
      reason: description,
      messageId: applied.matchedId ?? undefined,
      bounce: {
        permanent: bounce.permanent,
        status: bounce.status,
        failedRecipient: bounce.failedRecipient,
        matched: applied.matchedId !== null,
        suppressed: applied.suppressed,
      },
    };
  }

  // Without a Message-ID a redelivery would look like a new message, so
  // derive a stable one from the bytes.
  const rfcMessageId = parsed.messageId ?? (await syntheticMessageId(raw));

  const existing = await mailbox.findByMessageId(rfcMessageId);
  if (existing) {
    return {
      status: "duplicate",
      messageId: existing.id,
      threadId: existing.thread_id,
    };
  }

  // Classify the sub-address. Only the reserved `t.` namespace can pin a
  // thread, and only with a valid signature; everything else is a user label
  // or an agent route, both of which are recorded but never affect threading.
  const tag = recipient.tag ? parseTag(recipient.tag) : null;

  const verifiedThreadId =
    tag?.kind === "thread" ? await verifyThreadTag(env.THREAD_SECRET, address, tag) : null;

  const label = tag?.kind === "label" ? tag.label : null;

  const resolution = await mailbox.resolveThread({
    verifiedThreadId,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
  });

  const uid = crypto.randomUUID();
  const prefix = `${r2Prefix(address)}/${uid}`;
  const rawKey = `${prefix}/raw.eml`;

  await env.MAIL_ARCHIVE.put(rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      mailbox: address,
      sender: normalizeAddress(envelope.from),
      threadId: resolution.threadId,
      subject: (parsed.subject ?? "").slice(0, 512),
    },
  });

  const stored: Omit<ThreadAttachment, "message_id">[] = [];
  for (const [index, att] of parsed.attachments.entries()) {
    const filename = att.filename ?? `attachment-${index + 1}`;
    const body = toArrayBuffer(att.content);
    const key = `${prefix}/att/${index}-${encodeURIComponent(filename)}`;
    await env.MAIL_ARCHIVE.put(key, body, {
      httpMetadata: { contentType: att.mimeType || "application/octet-stream" },
      customMetadata: { filename, mailbox: address },
    });
    stored.push({
      id: crypto.randomUUID(),
      filename,
      mime_type: att.mimeType || null,
      size: body.byteLength,
      r2_key: key,
      // Inline images reference this from the HTML body as cid:<id>.
      content_id: att.contentId ? att.contentId.replace(/^<|>$/g, "") : null,
    });
  }

  const id = crypto.randomUUID();
  const subject = parsed.subject || "(no subject)";
  const snippet = snippetOf(parsed.text ?? null, parsed.html ?? null);
  const sender = parsed.from?.address
    ? normalizeAddress(parsed.from.address)
    : normalizeAddress(envelope.from);
  const receivedAt = options.receivedAt ?? (parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now());
  // Mail you sent from the provider: the other side is the first recipient.
  const firstTo = parsed.to?.find((a) => a.address)?.address;
  const counterpart = outbound && firstTo ? normalizeAddress(firstTo) : address;
  const toCount = (parsed.to?.length ?? 0) + (parsed.cc?.length ?? 0);
  const size = envelope.rawSize || raw.byteLength;
  const metadata = extractMetadata(parsed, stored.length);

  // Thread first: a crash before indexing leaves an unlisted message, which a
  // repair can recover. Indexing first would promise a body that is not there.
  await threadStub(env, address, resolution.threadId).append(
    { mailbox: address, threadId: resolution.threadId },
    {
      id,
      direction: outbound ? "out" : "in",
      sender,
      recipient: counterpart,
      subject,
      snippet,
      bodyText: parsed.text ?? null,
      bodyHtml: parsed.html ?? null,
      messageId: rfcMessageId,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      receivedAt,
      size,
      r2Prefix: prefix,
      r2RawKey: rawKey,
      // Bulky recipient lists and headers live with the conversation, not on
      // the index row, which is the capacity-constrained side.
      envelope: {
        to: parsed.to ?? [],
        cc: parsed.cc ?? [],
        bcc: parsed.bcc ?? [],
        replyTo: parsed.replyTo ?? [],
        returnPath: parsed.returnPath ?? null,
        deliveredTo: parsed.deliveredTo ?? null,
        headers: parsed.headers,
      },
      attachments: stored,
    },
  );

  await mailbox.index({
    id,
    threadId: resolution.threadId,
    direction: outbound ? "out" : "in",
    ...(outbound ? { delivery: { status: "sent" } } : {}),
    sender,
    recipient: outbound && toCount > 1 ? `${counterpart} +${toCount - 1}` : counterpart,
    subject,
    snippet,
    messageId: rfcMessageId,
    receivedAt,
    size,
    attachmentCount: stored.length,
    // Joined an existing conversation on headers the sender controls.
    grafted: !options.trustThread && !resolution.trusted && !resolution.isNewThread,
    label,
    metadata,
    searchBody: searchBodyOf(env, parsed.text ?? null, parsed.html ?? null),
  });
  await mailbox.checkPressure();

  return {
    status: "stored",
    messageId: id,
    threadId: resolution.threadId,
    trustedThread: resolution.trusted,
    tag: tag ? { kind: tag.kind, value: tag.kind === "label" ? tag.label : tag.threadId } : null,
    // The generalized agent for this address decides whether to act on it.
    agentHandles: await mailbox.agentHandles(label),
    metadata,
  };
}

// ---- outbound -----------------------------------------------------------

/** Cloudflare counts to + cc + bcc together against this. */
export const MAX_RECIPIENTS = 50;

export class RecipientError extends Error {}

/** Split a comma/semicolon separated field and normalise each address. */
export function parseRecipientList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,;]/)
        .map((part) => normalizeAddress(part))
        .filter((part) => part.length > 0),
    ),
  ];
}

export function validateRecipients(to: string[], cc: string[], bcc: string[]): void {
  const all = [...to, ...cc, ...bcc];
  if (all.length === 0) throw new RecipientError("Add at least one recipient.");

  const invalid = all.filter((a) => !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(a));
  if (invalid.length > 0) {
    throw new RecipientError(`Not a valid address: ${invalid.slice(0, 3).join(", ")}`);
  }

  if (all.length > MAX_RECIPIENTS) {
    throw new RecipientError(
      `${all.length} recipients, over Cloudflare's limit of ${MAX_RECIPIENTS} per message ` +
        `(to, cc and bcc counted together).`,
    );
  }
}

export interface SendInput {
  from: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** Thread to send into. Omit to start a new one. */
  threadId?: string | null;
  /** Label to keep on the sent copy, so a labelled conversation stays filtered. */
  label?: string | null;
  attachments?: OutboundAttachment[];
  /** Threading parent. Supplying it sets In-Reply-To and extends References. */
  inReplyTo?: ThreadMessage | null;
}

export interface SendResult {
  messageId: string;
  storedId: string;
  threadId: string;
  /** sent when it left, queued when it will be retried, failed when it will not. */
  status: "sent" | "queued" | "failed";
  code?: string;
  remedy?: string;
  attachments: number;
  /** Files delivered as expiring links rather than MIME parts. */
  linked: { filename: string; size: number; url: string; expiresAt: number }[];
  /** Recipients on this mailbox's suppression list (sent to anyway). */
  previouslyBounced: string[];
}

/**
 * Send via the native `send_email` binding and mirror the sent copy into the
 * thread, so the conversation shows both sides.
 *
 * Reply-To carries a signed sub-address tag; responses to it are pinned to
 * this thread without trusting anything the sender controls.
 */
export async function send(env: Env, input: SendInput): Promise<SendResult> {
  const from = normalizeAddress(input.from);
  const to = (Array.isArray(input.to) ? input.to : [input.to]).map(normalizeAddress).filter(Boolean);
  const cc = (input.cc ?? []).map(normalizeAddress).filter(Boolean);
  const bcc = (input.bcc ?? []).map(normalizeAddress).filter(Boolean);
  validateRecipients(to, cc, bcc);
  const mailbox = mailboxStub(env, from);

  // Addresses that previously hard-bounced or complained are a warning, not a
  // refusal: the sender decides. They are reported back so the UI can say so.
  // Cloudflare keeps its own suppression list, so a send to an address it has
  // suppressed can still fail there (E_RECIPIENT_SUPPRESSED) and is recorded
  // as a failed delivery like any other.
  const previouslyBounced = await mailbox.suppressed([...to, ...cc, ...bcc]);

  const resolution = input.threadId
    ? { threadId: input.threadId }
    : await mailbox.resolveThread({
        inReplyTo: input.inReplyTo?.message_id ?? null,
        references: input.inReplyTo?.refs ?? null,
      });
  const threadId = resolution.threadId;

  const headers: Record<string, string> = {};
  const parent = input.inReplyTo;
  if (parent?.message_id) {
    headers["In-Reply-To"] = parent.message_id;
    // References accumulates the whole ancestry, oldest first (RFC 2822 §3.6.4).
    headers["References"] = [parent.refs, parent.message_id].filter(Boolean).join(" ");
  }

  const attachments = input.attachments ?? [];
  validateAttachments(env, attachments);
  const { inline, linked } = partitionAttachments(env, attachments);

  // A connected Gmail account sends through Gmail, as itself: no signed
  // Reply-To (that is a busta.app sub-address), and in the parent's Gmail thread.
  const viaGmail = await mailbox.isGmail();
  const tag = await signThreadTag(env.THREAD_SECRET, from, threadId);
  const replyTo = viaGmail ? "" : replyToAddress(from, tag);
  const gmailThread = viaGmail && parent ? await mailbox.gmailThreadOf(parent.id) : null;
  const html = `<p>${escapeHtml(input.text).replace(/\n/g, "<br>")}</p>`;

  const sentAt = Date.now();
  const uid = crypto.randomUUID();
  const prefix = `${r2Prefix(from)}/${uid}`;
  const rawKey = `${prefix}/sent.eml`;

  // Archive to R2 before sending. A stored attachment with no mail sent is
  // recoverable; mail sent with no archived copy is not.
  const storedAttachments: Omit<ThreadAttachment, "message_id">[] = [];
  for (const [index, att] of attachments.entries()) {
    const filename = sanitizeFilename(att.filename);
    const key = `${prefix}/att/${index}-${encodeURIComponent(filename)}`;
    await env.MAIL_ARCHIVE.put(key, att.content, {
      httpMetadata: { contentType: att.contentType || "application/octet-stream" },
      // The download route names the file from here, so a signed link needs
      // no filename in the token.
      customMetadata: { filename, mailbox: from },
    });
    storedAttachments.push({
      id: crypto.randomUUID(),
      filename,
      mime_type: att.contentType || null,
      size: att.content.byteLength,
      r2_key: key,
      content_id: null,
    });
  }

  // Linked files are already in R2 above; mint their signed URLs and fold a
  // block into the body so the recipient can actually reach them.
  const expiresAt = sentAt + linkLifetimeMs(env);
  const links: SendResult["linked"] = [];
  for (const att of linked) {
    const stored = storedAttachments.find((s) => s.filename === sanitizeFilename(att.filename));
    if (!stored) continue;
    const token = await signDownloadToken(env.THREAD_SECRET, stored.r2_key, expiresAt);
    links.push({
      filename: stored.filename,
      size: stored.size,
      url: downloadUrl(env.PUBLIC_BASE_URL, token),
      expiresAt,
    });
  }

  const text = links.length > 0 ? `${input.text}\n\n${linkBlockText(links)}` : input.text;
  const htmlBody = links.length > 0 ? `${html}${linkBlockHtml(links)}` : html;

  // Bcc is passed to the binding and deliberately left out of the archived
  // copy's headers, the same way a real MTA drops it.
  const payload: OutboundPayload = {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject: input.subject,
    text,
    html: htmlBody,
    headers,
    ...(viaGmail ? { via: "gmail" as const, gmailThread } : {}),
    attachments: inline.map((att) => {
      const filename = sanitizeFilename(att.filename);
      const stored = storedAttachments.find((a) => a.filename === filename);
      return {
        filename,
        contentType: att.contentType || "application/octet-stream",
        r2Key: stored!.r2_key,
      };
    }),
  };

  let result: Delivered;
  let delivery: { status: "sent" | "queued" | "failed"; code?: string; remedy?: string } = {
    status: "sent",
  };

  try {
    result = await deliver(env, payload);
  } catch (error) {
    const verdict = classify(error);
    // The message is stored either way. Losing the user's draft because the
    // provider was rate limited is the failure mode this exists to prevent.
    result = { messageId: `<unsent-${uid}@${from.split("@")[1] ?? "local"}>` };
    delivery = { status: verdict.status, code: verdict.code, remedy: verdict.remedy };
  }

  await env.MAIL_ARCHIVE.put(
    rawKey,
    synthesizeRfc822({
      from,
      to,
      cc,
      replyTo,
      subject: input.subject,
      text,
      headers,
      messageId: result.messageId,
      date: sentAt,
      attachments: storedAttachments,
    }),
    {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { mailbox: from, recipient: to.join(","), threadId, direction: "out" },
    },
  );

  const id = crypto.randomUUID();
  const snippet = snippetOf(input.text, null);

  await threadStub(env, from, threadId).append(
    { mailbox: from, threadId },
    {
      id,
      direction: "out",
      sender: from,
      recipient: to[0]!,
      subject: input.subject,
      snippet,
      bodyText: text,
      bodyHtml: htmlBody,
      messageId: result.messageId,
      inReplyTo: headers["In-Reply-To"] ?? null,
      references: headers["References"] ?? null,
      receivedAt: sentAt,
      size: input.text.length,
      r2Prefix: prefix,
      r2RawKey: rawKey,
      envelope: { to, cc, bcc, replyTo },
      attachments: storedAttachments,
    },
  );

  await mailbox.index({
    id,
    threadId,
    direction: "out",
    delivery: {
      status: delivery.status,
      code: delivery.code ?? null,
      detail: delivery.remedy ?? null,
    },
    sender: from,
    recipient: to.length > 1 ? `${to[0]!} +${to.length - 1}` : to[0]!,
    subject: input.subject,
    snippet,
    messageId: result.messageId,
    receivedAt: sentAt,
    size: input.text.length,
    attachmentCount: storedAttachments.length,
    label: input.label ?? null,
    searchBody: searchBodyOf(env, input.text, null),
  });

  if (result.gmail) await mailbox.linkGmail(result.gmail.id, id, result.gmail.threadId);

  if (delivery.status === "queued") {
    await mailbox.enqueue(JSON.stringify({ payload, storedId: id }), id, nextAttemptDelay(0)!);
  }

  return {
    messageId: result.messageId,
    storedId: id,
    threadId,
    status: delivery.status,
    code: delivery.code,
    remedy: delivery.remedy,
    attachments: storedAttachments.length,
    linked: links,
    previouslyBounced,
  };
}

/**
 * The send binding builds the real MIME internally and doesn't hand it back,
 * so the archived copy of an outbound message is reconstructed here. It is a
 * faithful record of what we asked to send, not a byte-copy of what left.
 */
function synthesizeRfc822(m: {
  from: string;
  to: string[];
  cc: string[];
  replyTo: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  messageId: string;
  date: number;
  attachments: Omit<ThreadAttachment, "message_id">[];
}): string {
  return [
    `Message-ID: ${m.messageId}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length > 0 ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${m.subject}`,
    ...Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`),
    // Attachment bytes are archived once, under their own keys. Inlining them
    // here as base64 would double R2 usage for no gain, so the archived
    // message references them instead.
    ...m.attachments.map(
      (a) => `X-Archived-Attachment: ${a.filename}; size=${a.size}; key=${a.r2_key}`,
    ),
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    m.text,
  ].join("\r\n");
}

function linkBlockText(links: SendResult["linked"]): string {
  const expiry = new Date(links[0]!.expiresAt).toUTCString();
  return [
    "--",
    `Large file${links.length > 1 ? "s" : ""} available for download until ${expiry}:`,
    ...links.map((l) => `  ${l.filename} (${formatBytes(l.size)})\n  ${l.url}`),
  ].join("\n");
}

function linkBlockHtml(links: SendResult["linked"]): string {
  const expiry = new Date(links[0]!.expiresAt).toUTCString();
  return `<hr><p><b>Large file${links.length > 1 ? "s" : ""}</b> — available until ${escapeHtml(expiry)}:</p><ul>${links
    .map(
      (l) =>
        `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a> (${formatBytes(l.size)})</li>`,
    )
    .join("")}</ul>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
