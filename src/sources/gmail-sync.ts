/**
 * Keeping a connected Gmail account and its Busta mailbox in step
 * (designs/2026-09-24-connect-gmail, "How it works").
 *
 * All of it runs from the mailbox's Durable Object alarm, one step at a time,
 * so nothing here races itself: Gmail's push only asks for the alarm sooner.
 *
 *   backfill   list the last N days (not spam, not drafts), then bring them in
 *              oldest first, a batch per alarm. Oldest first keeps the index's
 *              arrival order (seq) in time order, which the list relies on.
 *   live       after backfill, follow Gmail's history from where it started:
 *              new mail (INBOX or SENT), read/unread, star, trash.
 *   outbox     Busta-side read/star/trash changes, sent to Gmail with retries.
 *   renew      Gmail's watch lasts up to 7 days; renew it daily.
 *
 * Each Gmail message id is linked to its Busta message (ext table), so a
 * doubled alert or our own sent mail coming back is recognised and skipped.
 */
import { ingest } from "../mail";
import { fileMessage } from "../folders";
import * as gmail from "./gmail";
import { GmailError } from "./gmail";

export interface GmailState {
  account: string;
  sealedRefresh: string;
  status: "backfill" | "live" | "needs_reconnect";
  /** Days of mail to bring in on connect. */
  days: number;
  connectedAt: number;
  /** History position to follow from; set at connect, advanced by each sync. */
  historyId: string | null;
  watchRenewAt: number;
  watchExpires: number | null;
  backfill: { listed: boolean; pageToken: string | null; total: number; done: number; skipped: number };
  lastSyncAt: number | null;
  lastMailAt: number | null;
  lastError: string | null;
  /** Gmail said something changed; sync on the next alarm. */
  pending: boolean;
}

/** What the Durable Object gives the sync: its state, its tables, and a token. */
export interface GmailHost {
  env: Env;
  address: string;
  token: gmail.TokenSource;
  state(): GmailState | null;
  update(patch: Partial<GmailState>): void;
  /** Queue of Gmail ids to bring in, oldest first. */
  queuePush(ids: { id: string; order: number }[]): void;
  queueTake(n: number): string[];
  queueDrop(id: string): void;
  queueSize(): number;
  /** Busta message for a Gmail id. */
  local(gmailId: string): { id: string; read: number; starred: number; deleted_at: number | null } | null;
  link(gmailId: string, messageId: string, gmailThreadId: string): void;
  /** Apply a change that came from Gmail, without echoing it back. */
  applyRemote(messageId: string, change: { read?: boolean; starred?: boolean; trashed?: boolean }): void;
  outboxTake(n: number): { seq: number; gmail_id: string; op: string; attempts: number }[];
  outboxDone(seq: number): void;
  outboxRetry(seq: number, attempts: number, error: string): void;
}

const BATCH = 20;
const DAY = 86_400_000;
/** Poll anyway this often, in case a push was lost. */
const POLL_MS = 15 * 60_000;

/** One alarm's worth of work. Returns when it wants to run next, or null. */
export async function gmailTick(host: GmailHost): Promise<number | null> {
  const st = host.state();
  if (!st || st.status === "needs_reconnect") return null;
  const now = Date.now();
  try {
    if (now >= st.watchRenewAt) await renewWatch(host);
    await drainOutbox(host);
    if (st.status === "backfill") {
      const more = await backfillStep(host);
      if (more) return now + 500;
      host.update({ status: "live", pending: true });
    }
    const cur = host.state()!;
    if (cur.pending || !cur.lastSyncAt || now - cur.lastSyncAt >= POLL_MS) await syncHistory(host);
    const after = host.state()!;
    return Math.min(after.watchRenewAt, Date.now() + POLL_MS, ...(host.outboxTake(1).length ? [Date.now() + 30_000] : []));
  } catch (e) {
    return handleError(host, e);
  }
}

function handleError(host: GmailHost, e: unknown): number | null {
  const message = e instanceof Error ? e.message : String(e);
  const auth = (e as { code?: string }).code === "invalid_grant" || (e instanceof GmailError && e.status === 401);
  if (auth) {
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

/** List (first) then bring in a batch, oldest first. True while there is more. */
async function backfillStep(host: GmailHost): Promise<boolean> {
  const st = host.state()!;
  if (!st.backfill.listed) {
    let pageToken = st.backfill.pageToken ?? undefined;
    let total = st.backfill.total;
    for (let pages = 0; pages < 4; pages++) {
      const page = await gmail.listMessages(host.token, `newer_than:${st.days}d -in:spam -in:drafts -in:chats`, pageToken);
      const ids = page.messages ?? [];
      // Gmail lists newest first; order counts down so the oldest is taken first.
      host.queuePush(ids.map((m, i) => ({ id: m.id, order: -(total + i) })));
      total += ids.length;
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    host.update({ backfill: { ...st.backfill, total, pageToken: pageToken ?? null, listed: !pageToken } });
    return true;
  }

  const ids = host.queueTake(BATCH);
  if (ids.length === 0) return false;
  let done = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      (await bringIn(host, id)) ? done++ : skipped++;
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) { skipped++; host.queueDrop(id); continue; }
      throw e;
    }
    host.queueDrop(id);
  }
  const b = host.state()!.backfill;
  host.update({ backfill: { ...b, done: b.done + done, skipped: b.skipped + skipped } });
  return host.queueSize() > 0;
}

/**
 * Fetch one Gmail message and store it: received (INBOX) or sent (SENT only).
 * Drafts, spam and chats are skipped. Read, star and trash come along.
 */
async function bringIn(host: GmailHost, gmailId: string): Promise<boolean> {
  if (host.local(gmailId)) return false;
  const m = await gmail.getRaw(host.token, gmailId);
  const labels = new Set(m.labelIds ?? []);
  if (labels.has("DRAFT") || labels.has("SPAM") || labels.has("CHAT")) return false;
  const outbound = labels.has("SENT") && !labels.has("INBOX");
  const raw = gmail.fromB64url(m.raw);
  const result = await ingest(
    host.env,
    { from: "", to: host.address, rawSize: raw.byteLength },
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    { direction: outbound ? "out" : "in", receivedAt: Number(m.internalDate) || undefined, trustThread: true },
  );
  const messageId = result.messageId;
  const threadId = result.threadId;
  if (!messageId) return false;
  host.link(gmailId, messageId, m.threadId);
  host.applyRemote(messageId, { read: !labels.has("UNREAD"), starred: labels.has("STARRED"), trashed: labels.has("TRASH") });
  if (result.status === "stored" && !outbound && threadId) {
    await fileMessage(host.env, host.address, { id: messageId, threadId, label: null });
  }
  host.update({ lastMailAt: Date.now() });
  return result.status === "stored";
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
      for (const m of [...(recent.messages ?? [])].reverse()) await bringIn(host, m.id);
      host.update({ historyId: p.historyId, lastSyncAt: Date.now(), lastError: null });
      return;
    }
    throw e;
  }
  host.update({ historyId: latest, lastSyncAt: Date.now(), lastError: null });
}

async function applyHistory(host: GmailHost, h: gmail.HistoryRecord) {
  for (const a of h.messagesAdded ?? []) {
    const labels = a.message.labelIds ?? [];
    if (labels.includes("INBOX") || labels.includes("SENT")) {
      try { await bringIn(host, a.message.id); } catch (e) { if (!(e instanceof GmailError && e.status === 404)) throw e; }
    }
  }
  const change = (id: string, labels: string[], added: boolean) => {
    const local = host.local(id);
    if (!local) return;
    const c: { read?: boolean; starred?: boolean; trashed?: boolean } = {};
    if (labels.includes("UNREAD")) c.read = !added;
    if (labels.includes("STARRED")) c.starred = added;
    if (labels.includes("TRASH")) c.trashed = added;
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
