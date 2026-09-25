/**
 * Keeping a connected Gmail account and its Busta mailbox in step
 * (designs/2026-09-24-connect-gmail, "How it works").
 *
 * Live sync runs from the mailbox's Durable Object alarm, one step at a time,
 * so nothing here races itself: Gmail's push only asks for the alarm sooner.
 *
 *   live     follow Gmail's history: new mail, read/unread, star, archive
 *            (the Inbox label), trash.
 *   outbox   Busta-side read/star/archive/trash changes, sent to Gmail with retries.
 *   renew    Gmail's watch lasts up to 7 days; renew it daily.
 *
 * Bringing in past mail is the import queue's job (src/import-do.ts); both
 * store a message through importGmailMessage below. The list is in time
 * order, so the two can run side by side. Each Gmail id is linked to its
 * Busta message, so a doubled alert or our own sent mail coming back is
 * recognised and skipped.
 */
import { ingest, mailboxStub } from "../mail";
import { fileMessage } from "../folders";
import * as gmail from "./gmail";
import { GmailError } from "./gmail";

export interface GmailState {
  account: string;
  sealedRefresh: string;
  status: "live" | "needs_reconnect";
  connectedAt: number;
  /** History position to follow from; set by the first watch, advanced by each sync. */
  historyId: string | null;
  watchRenewAt: number;
  watchExpires: number | null;
  lastSyncAt: number | null;
  lastMailAt: number | null;
  lastError: string | null;
  /** Gmail said something changed; sync on the next alarm. */
  pending: boolean;
}

/** What the Durable Object gives live sync: its state, its tables, and a token. */
export interface GmailHost {
  env: Env;
  address: string;
  token: gmail.TokenSource;
  state(): GmailState | null;
  update(patch: Partial<GmailState>): void;
  /** Busta message for a Gmail id. */
  local(gmailId: string): { id: string } | null;
  /** Apply a change that came from Gmail, without echoing it back. */
  applyRemote(messageId: string, change: GmailChange): void;
  outboxTake(n: number): { seq: number; gmail_id: string; op: string; attempts: number }[];
  outboxDone(seq: number): void;
  outboxRetry(seq: number, attempts: number, error: string): void;
}

export interface GmailChange { read?: boolean; starred?: boolean; trashed?: boolean; archived?: boolean }

const DAY = 86_400_000;
/** Poll anyway this often, in case a push was lost. */
const POLL_MS = 15 * 60_000;

/** Gmail labels → Busta state. Received mail outside the Inbox is archived. */
export function labelState(labels: string[]): GmailChange {
  const l = new Set(labels);
  const outbound = l.has("SENT") && !l.has("INBOX");
  return { read: !l.has("UNREAD"), starred: l.has("STARRED"), trashed: l.has("TRASH"), archived: !outbound && !l.has("INBOX") };
}

export type ImportOutcome = "stored" | "known" | "duplicate" | "skipped";

/**
 * Fetch one Gmail message and store it in the account's mailbox: received, or
 * sent (Sent only). Drafts, spam and chats are skipped. Read, star, archive and
 * trash come along; received mail is sorted by your rules when `sort` is set.
 */
export async function importGmailMessage(
  env: Env,
  address: string,
  token: gmail.TokenSource,
  gmailId: string,
  opts: { sort: boolean },
): Promise<ImportOutcome> {
  const mailbox = mailboxStub(env, address);
  if (await mailbox.gmailKnown(gmailId)) return "known";
  const m = await gmail.getRaw(token, gmailId);
  const labels = m.labelIds ?? [];
  if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("CHAT")) return "skipped";
  const outbound = labels.includes("SENT") && !labels.includes("INBOX");
  const raw = gmail.fromB64url(m.raw);
  const result = await ingest(
    env,
    { from: "", to: address, rawSize: raw.byteLength },
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    { direction: outbound ? "out" : "in", receivedAt: Number(m.internalDate) || undefined, trustThread: true },
  );
  if (!result.messageId) return "skipped";
  await mailbox.linkGmail(gmailId, result.messageId, m.threadId);
  await mailbox.applyGmailLabels(result.messageId, labels);
  if (result.status === "stored" && !outbound && opts.sort && result.threadId) {
    await fileMessage(env, address, { id: result.messageId, threadId: result.threadId, label: null });
  }
  return result.status === "stored" ? "stored" : "duplicate";
}

/** One alarm's worth of live sync. Returns when it wants to run next, or null. */
export async function gmailTick(host: GmailHost): Promise<number | null> {
  const st = host.state();
  if (!st || st.status === "needs_reconnect") return null;
  const now = Date.now();
  try {
    if (now >= st.watchRenewAt) await renewWatch(host);
    await drainOutbox(host);
    const cur = host.state()!;
    if (cur.pending || !cur.lastSyncAt || now - cur.lastSyncAt >= POLL_MS) await syncHistory(host);
    const after = host.state()!;
    return Math.min(after.watchRenewAt, Date.now() + POLL_MS, ...(host.outboxTake(1).length ? [Date.now() + 30_000] : []));
  } catch (e) {
    return handleError(host, e);
  }
}

export function isAuthFailure(e: unknown): boolean {
  return (e as { code?: string }).code === "invalid_grant" || (e instanceof GmailError && e.status === 401);
}

function handleError(host: GmailHost, e: unknown): number | null {
  const message = e instanceof Error ? e.message : String(e);
  if (isAuthFailure(e)) {
    host.update({ status: "needs_reconnect", lastError: "Google no longer accepts Busta's access." });
    return null;
  }
  console.error("gmail tick failed", host.address, message);
  host.update({ lastError: message.slice(0, 300) });
  return Date.now() + (e instanceof GmailError && e.transient ? 60_000 : 5 * 60_000);
}

async function renewWatch(host: GmailHost) {
  const topic = host.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) return;
  const w = await gmail.watch(host.token, topic);
  const st = host.state()!;
  host.update({
    watchRenewAt: Date.now() + DAY,
    watchExpires: Number(w.expiration) || null,
    // The first watch fixes where history starts.
    historyId: st.historyId ?? w.historyId,
  });
}

/** Follow Gmail's history since the last position. */
async function syncHistory(host: GmailHost) {
  const st = host.state()!;
  host.update({ pending: false });
  if (!st.historyId) {
    const p = await gmail.profile(host.token);
    host.update({ historyId: p.historyId, lastSyncAt: Date.now() });
    return;
  }
  let pageToken: string | undefined;
  let latest = st.historyId;
  try {
    do {
      const page = await gmail.listHistory(host.token, st.historyId, pageToken);
      for (const h of page.history ?? []) await applyHistory(host, h);
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof GmailError && e.status === 404) {
      // Too far behind for history: catch up on the last week instead.
      const p = await gmail.profile(host.token);
      const recent = await gmail.listMessages(host.token, "newer_than:7d -in:spam -in:drafts -in:chats");
      for (const m of recent.messages ?? []) await bringIn(host, m.id);
      host.update({ historyId: p.historyId, lastSyncAt: Date.now(), lastError: null });
      return;
    }
    throw e;
  }
  host.update({ historyId: latest, lastSyncAt: Date.now(), lastError: null });
}

async function bringIn(host: GmailHost, gmailId: string) {
  try {
    if ((await importGmailMessage(host.env, host.address, host.token, gmailId, { sort: true })) === "stored") {
      host.update({ lastMailAt: Date.now() });
    }
  } catch (e) {
    if (!(e instanceof GmailError && e.status === 404)) throw e; // gone again already
  }
}

async function applyHistory(host: GmailHost, h: gmail.HistoryRecord) {
  for (const a of h.messagesAdded ?? []) await bringIn(host, a.message.id);
  const change = (id: string, labels: string[], added: boolean) => {
    const local = host.local(id);
    if (!local) return;
    const c: GmailChange = {};
    if (labels.includes("UNREAD")) c.read = !added;
    if (labels.includes("STARRED")) c.starred = added;
    if (labels.includes("TRASH")) c.trashed = added;
    if (labels.includes("INBOX")) c.archived = !added;
    if (Object.keys(c).length) host.applyRemote(local.id, c);
  };
  for (const l of h.labelsAdded ?? []) change(l.message.id, l.labelIds, true);
  for (const l of h.labelsRemoved ?? []) change(l.message.id, l.labelIds, false);
  for (const d of h.messagesDeleted ?? []) {
    const local = host.local(d.message.id);
    if (local) host.applyRemote(local.id, { trashed: true });
  }
}

/** Send Busta-side changes to Gmail. */
async function drainOutbox(host: GmailHost) {
  for (const item of host.outboxTake(25)) {
    try {
      switch (item.op) {
        case "read": await gmail.modify(host.token, item.gmail_id, [], ["UNREAD"]); break;
        case "unread": await gmail.modify(host.token, item.gmail_id, ["UNREAD"], []); break;
        case "star": await gmail.modify(host.token, item.gmail_id, ["STARRED"], []); break;
        case "unstar": await gmail.modify(host.token, item.gmail_id, [], ["STARRED"]); break;
        case "archive": await gmail.modify(host.token, item.gmail_id, [], ["INBOX"]); break;
        case "unarchive": await gmail.modify(host.token, item.gmail_id, ["INBOX"], []); break;
        case "trash": await gmail.trash(host.token, item.gmail_id); break;
        case "untrash": await gmail.untrash(host.token, item.gmail_id); break;
      }
      host.outboxDone(item.seq);
    } catch (e) {
      if (e instanceof GmailError && (e.transient || e.status === 401) && item.attempts < 8) {
        host.outboxRetry(item.seq, item.attempts + 1, e.message);
        if (e.status === 401) throw e;
      } else {
        // Gone in Gmail, or refused for good: nothing to retry.
        console.error("gmail change dropped", host.address, item.op, String(e));
        host.outboxDone(item.seq);
      }
    }
  }
}
