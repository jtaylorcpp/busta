/**
 * Data for the Astro mailbox and thread pages, read straight from the same
 * Durable Objects the original router uses. Nothing here writes, except
 * marking a thread read on view (as the old page did). Every mutation still
 * posts to the original handlers in ../../../src/index.ts.
 */
import { authorizeMailbox } from "../../../src/index";
import {
  attachmentBudget, FLAG, inlineThreshold, linkLifetimeMs, mailboxStub, normalizeAddress,
  SYSTEM_LOCAL_PARTS, SYSTEM_ORG_ID, tenantStub, threadStub,
} from "../../../src/mail";
import type { TenantMailbox } from "../../../src/tenant-do";
import type { AgentConfig, IndexedMessage, MailboxDO } from "../../../src/mailbox-do";
import type { BodySource, ThreadAttachment, ThreadMessage } from "../../../src/thread-do";
import type { Envelope } from "./audience";

export const INBOX_PAGE_SIZE = 50;

export type MailboxStub = DurableObjectStub<MailboxDO>;

export type View = "inbox" | "starred" | "trash";

export interface Session {
  userId: string;
  orgId: string | null;
}

export const base = (address: string) => `/mb/${encodeURIComponent(address)}`;

/** Same gate as the old router: the mailbox must belong to the active org. */
export async function openMailbox(env: Env, session: Session, rawAddress: string) {
  return authorizeMailbox(env, session, rawAddress);
}

export async function loadInbox(stub: MailboxStub, params: URLSearchParams) {
  if (await stub.backfillPending()) await stub.backfill();
  const label = params.get("tag");
  const rawView = params.get("view");
  const view: View = rawView === "trash" ? "trash" : rawView === "starred" ? "starred" : "inbox";
  const beforeParam = params.get("before");
  const before = beforeParam ? Number(beforeParam) : undefined;

  // One extra row tells us whether another page exists without a count.
  const [rows, stats, labels, agent] = await Promise.all([
    stub.list(INBOX_PAGE_SIZE + 1, 0, {
      label: label ?? undefined,
      before,
      trash: view === "trash",
      starred: view === "starred",
    }),
    stub.stats(),
    stub.labels(),
    stub.agentConfig(),
  ]);
  const messages = rows.slice(0, INBOX_PAGE_SIZE) as IndexedMessage[];
  const nextBefore = rows.length > INBOX_PAGE_SIZE ? messages[messages.length - 1]!.seq : null;
  return { messages, stats, labels, agent: agent as AgentConfig, label, view, nextBefore };
}

/** Recipient lists are stored as plain strings (sent) or postal-mime objects (received). */
type RawAddress = string | { address?: string; name?: string; group?: RawAddress[] };

function flatten(list: unknown): { address: string; name: string | null }[] {
  if (!Array.isArray(list)) return [];
  const out: { address: string; name: string | null }[] = [];
  for (const item of list as RawAddress[]) {
    if (typeof item === "string") out.push({ address: item.toLowerCase(), name: null });
    else if (item?.group) out.push(...flatten(item.group));
    else if (item?.address) out.push({ address: item.address.toLowerCase(), name: item.name || null });
  }
  return out;
}

/**
 * Our own sub-addresses (sales+newsletter@, the signed reply tag
 * sales+t.<thread>.<sig>@) are us, not extra participants.
 */
function canonical(addr: string, self: string): string {
  const a = addr.toLowerCase();
  const [local, domain] = a.split("@");
  const [selfLocal, selfDomain] = self.split("@");
  if (domain === selfDomain && local?.split("+")[0] === selfLocal) return self;
  return a;
}

export interface ThreadEntry {
  row: IndexedMessage;
  message: ThreadMessage;
  attachments: ThreadAttachment[];
  bodySource: BodySource;
  envelope: Envelope;
}

/**
 * The whole conversation containing `messageId`, oldest first, with bodies
 * (hydrated from R2 when archived), attachments and parsed recipients.
 */
export async function loadThread(
  env: Env,
  stub: MailboxStub,
  address: string,
  messageId: string,
) {
  const found = (await stub.lookup(messageId)) as IndexedMessage | null;
  if (!found) return null;

  const index = ((await stub.threadIndex(found.thread_id)) as IndexedMessage[])
    .filter((r) => r.deleted_at === null || r.id === messageId)
    .sort((a, b) => a.received_at - b.received_at);
  const thread = threadStub(env, address, found.thread_id);
  const views = await Promise.all(index.map((r) => thread.get(r.id)));

  const self = address.toLowerCase();
  const canon = (list: { address: string }[]) => [...new Set(list.map((p) => canonical(p.address, self)))];
  const names: Record<string, string> = {};
  const entries: ThreadEntry[] = [];
  index.forEach((r, i) => {
    const view = views[i];
    if (!view) return;
    const env = view.message.envelope_json ? (JSON.parse(view.message.envelope_json) as Record<string, unknown>) : {};
    const to = flatten(env.to);
    const cc = flatten(env.cc);
    const bcc = flatten(env.bcc);
    for (const p of [...to, ...cc]) if (p.name && !names[p.address]) names[p.address] = p.name;
    const sender = canonical(view.message.sender, self);
    if (r.from_name && r.direction === "in") names[sender] = r.from_name;
    entries.push({
      row: r,
      message: view.message as ThreadMessage,
      attachments: view.attachments as ThreadAttachment[],
      bodySource: view.bodySource,
      envelope: {
        from: sender,
        // Old rows predate envelope capture; fall back to the index recipient.
        to: to.length ? canon(to) : [canonical(view.message.recipient, self)],
        cc: canon(cc),
        bcc: canon(bcc),
        outbound: r.direction === "out",
        unverified: r.grafted === 1,
      },
    });
  });

  // Viewing the conversation reads all of it.
  await Promise.all(entries.filter((e) => !e.row.read).map((e) => stub.markRead(e.row.id)));

  return { threadId: found.thread_id, focus: found, entries, names };
}

/**
 * Split a plain-text body into what was written and the quoted history below
 * it ("On … wrote:" and ">"-prefixed lines), so the bubble shows only the new
 * part and the rest folds behind "Show quoted text".
 */
export function splitQuoted(text: string): { fresh: string; quoted: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? "";
    if (/^On .+wrote:\s*$/.test(line) || (/^On .+/.test(line) && /wrote:\s*$/.test(next))) { cut = i; break; }
    if (/^>/.test(line) && lines.slice(i).every((l) => l.startsWith(">") || l.trim() === "")) { cut = i; break; }
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) { cut = i; break; }
  }
  return { fresh: lines.slice(0, cut).join("\n").trim(), quoted: lines.slice(cut).join("\n").trim() };
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}

export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Mailbox-list date: time today, otherwise "Sep 22". Matches the old page (UTC). */
export function formatListDate(ms: number): string {
  const d = new Date(ms);
  if (new Date().toDateString() === d.toDateString()) return formatTime(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function deliveryStatus(m: IndexedMessage): { tone: "delivered" | "queued" | "bounced"; label: string; title?: string } | undefined {
  if (m.direction !== "out") return undefined;
  const title = [m.delivery_code, (m as IndexedMessage & { delivery_detail?: string | null }).delivery_detail].filter(Boolean).join(" — ") || undefined;
  switch (m.delivery_status) {
    case null:
    case undefined:
    case "sent":
      return { tone: "delivered", label: "Sent" };
    case "queued":
      return { tone: "queued", label: "Queued", title };
    case "bounced":
      return { tone: "bounced", label: "Bounced", title };
    case "failed":
      return { tone: "bounced", label: "Failed", title };
    default:
      return { tone: "queued", label: m.delivery_status, title };
  }
}

// --- search ---------------------------------------------------------------

export const SEARCH_PAGE_SIZE = 25;

export interface SearchFilters {
  unreadOnly: boolean;
  sender: string;
  label: string;
  hasAttachments: boolean;
  hideBulk: boolean;
  hideAuto: boolean;
}

export function searchFilters(params: URLSearchParams): SearchFilters {
  return {
    unreadOnly: params.get("unread") === "1",
    sender: normalizeAddress(params.get("from") ?? ""),
    label: params.get("tag") ?? "",
    hasAttachments: params.get("attach") === "1",
    hideBulk: params.get("nobulk") === "1",
    hideAuto: params.get("noauto") === "1",
  };
}

/** Query string for a search, optionally resuming at `cursor`. */
export function searchQuery(q: string, f: SearchFilters, cursor: number | null = null): string {
  const s = new URLSearchParams({ q });
  if (f.unreadOnly) s.set("unread", "1");
  if (f.sender) s.set("from", f.sender);
  if (f.label) s.set("tag", f.label);
  if (f.hasAttachments) s.set("attach", "1");
  if (f.hideBulk) s.set("nobulk", "1");
  if (f.hideAuto) s.set("noauto", "1");
  if (cursor !== null) s.set("cursor", String(cursor));
  return s.toString();
}

/**
 * One slice of a search, newest to oldest. The index scans a bounded window
 * per call, so a slice can be empty yet not exhausted: `nextCursor` says where
 * to resume, `exhausted` says the whole mailbox has been walked.
 */
export async function runSearch(stub: MailboxStub, params: URLSearchParams) {
  const q = (params.get("q") ?? "").trim();
  const filters = searchFilters(params);
  const cursorParam = params.get("cursor");
  // Flag filters are bitmask work on the index, so they compose with the text
  // query in one pass rather than post-filtering results.
  const flagsAll = filters.hasAttachments ? FLAG.hasAttachments : 0;
  const flagsNone = (filters.hideBulk ? FLAG.bulk : 0) | (filters.hideAuto ? FLAG.autoSubmitted : 0);
  const page = q
    ? await stub.searchText({
        q,
        cursor: cursorParam ? Number(cursorParam) : null,
        limit: SEARCH_PAGE_SIZE,
        unreadOnly: filters.unreadOnly,
        sender: filters.sender || undefined,
        label: filters.label || undefined,
        flagsAll: flagsAll || undefined,
        flagsNone: flagsNone || undefined,
      })
    : { results: [], nextCursor: null, examined: 0, exhausted: true };
  return {
    q,
    filters,
    results: page.results as IndexedMessage[],
    nextCursor: page.nextCursor as number | null,
    examined: page.examined as number,
    exhausted: page.exhausted as boolean,
  };
}

// --- compose / drafts -----------------------------------------------------

export function composeLimits(env: Env) {
  return {
    inlineBytes: inlineThreshold(env),
    inline: formatSize(inlineThreshold(env)),
    total: formatSize(attachmentBudget(env)),
    linkDays: Math.round(linkLifetimeMs(env) / 86_400_000),
  };
}

/** Prefill for forwarding `messageId`, as the old compose page built it. */
export async function forwardPrefill(env: Env, stub: MailboxStub, address: string, messageId: string) {
  const row = (await stub.lookup(messageId)) as IndexedMessage | null;
  if (!row) return null;
  const found = await threadStub(env, address, row.thread_id).get(messageId);
  if (!found) return null;
  const m = found.message as ThreadMessage;
  return {
    subject: /^fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    body: [
      "",
      "---------- Forwarded message ----------",
      `From: ${m.sender}`,
      `Date: ${new Date(m.received_at).toUTCString()}`,
      `Subject: ${m.subject}`,
      `To: ${m.recipient}`,
      "",
      m.body_text ?? "(no plain-text body)",
    ].join("\n"),
    attachments: found.attachments as ThreadAttachment[],
  };
}

// --- account menu / home ----------------------------------------------------

/** Remembers the last mailbox opened, so / can take you back to it. */
export const LAST_MAILBOX_COOKIE = "busta_mb";

export interface AccountMailbox {
  address: string;
  label: string | null;
  /** provisioning | ready | failed */
  status: string;
  failure: string | null;
  unread: number;
}

/** Everything the sidebar account menu shows. Unread counts only for ready mailboxes. */
export async function loadAccount(env: Env, session: { userId: string; orgId: string }) {
  const mailboxes = (await tenantStub(env, session.orgId).listMailboxes()) as TenantMailbox[];
  const withCounts: AccountMailbox[] = await Promise.all(
    mailboxes.map(async (m) => ({
      address: m.address,
      label: m.label,
      status: m.status,
      failure: m.failure,
      unread: m.status === "ready" ? ((await mailboxStub(env, m.address).stats()) as { unread: number }).unread : 0,
    })),
  );
  const admins = String(env.ADMIN_USER_IDS ?? "").split(",").map((i) => i.trim()).filter(Boolean);
  let adoptable: string[] = [];
  if (admins.includes(session.userId)) {
    // Offer only what is genuinely still system-held, so the menu never
    // advertises a transfer that would be refused.
    const candidates = [...SYSTEM_LOCAL_PARTS].map((l) => `${l}@${env.MAIL_DOMAIN}`);
    const owners = await Promise.all(candidates.map((a) => mailboxStub(env, a).ownerOrgId()));
    adoptable = candidates.filter((_, i) => owners[i] === SYSTEM_ORG_ID);
  }
  return { mailboxes: withCounts, adoptable };
}
