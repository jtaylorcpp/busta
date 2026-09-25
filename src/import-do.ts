import { DurableObject } from "cloudflare:workers";
import { mailboxStub } from "./mail";
import { GmailError } from "./sources/gmail";
import { gmailFor } from "./sources/vault";
import { importGmailMessage, isAuthFailure } from "./sources/gmail-sync";

/**
 * One import queue per connected Gmail account: bringing in past mail
 * (designs/2026-09-24-connect-gmail, screens 9-10).
 *
 * First it captures the Gmail message ids for the window (Gmail lists them
 * newest first), then it imports them in that order, newest to oldest, a
 * batch per alarm. Live sync runs separately in the mailbox's own Durable
 * Object; the list is in time order, so they don't need to wait for each
 * other. "Bring in older mail" queues the next window back the same way.
 *
 * Only the first `sortBudget` received messages of a run are sorted by your
 * rules; the rest come in unsorted, which caps the model cost of a large import.
 */

export interface ImportState {
  address: string;
  /** listing: capturing ids; importing: bringing them in; done; paused: needs reconnect. */
  phase: "listing" | "importing" | "done" | "paused";
  /** Gmail search for this run's window. */
  query: string;
  /** Oldest point covered by all runs so far (epoch seconds), or 0 for "everything". */
  coveredAfter: number;
  pageToken: string | null;
  total: number;
  done: number;
  skipped: number;
  sorted: number;
  sortBudget: number;
  startedAt: number;
  finishedAt: number | null;
  lastError: string | null;
  /** The catch-up pass (re-list the window, queue anything not brought in) has run. */
  reconciled?: boolean;
}

const BATCH = 20;
const PARALLEL = 4;
/** Tries before one message is given up on (and counted as skipped). */
const MAX_ATTEMPTS = 3;

/**
 * Failures that are the platform's, not the message's: a deploy resetting an
 * object, a dropped connection. They're retried without counting against the
 * message, or one bad moment skips innocent mail.
 */
const PLATFORM_HICCUP = /code was updated|Network connection lost|no longer active|Connection closed|internal error|overloaded/i;
const PAGES_PER_RUN = 4;
const BASE_QUERY = "-in:spam -in:drafts -in:chats";

type Row<T> = T & Record<string, SqlStorageValue>;

export class ImportDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    // ord ascends in Gmail's list order, which is newest first.
    sql.exec(`CREATE TABLE IF NOT EXISTS queue (ord INTEGER PRIMARY KEY AUTOINCREMENT, gmail_id TEXT NOT NULL UNIQUE);`);
    // Failed tries per message: one bad message is skipped after a few, not retried forever.
    const hasAttempts = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pragma_table_info('queue') WHERE name = 'attempts'`).toArray()[0]?.n;
    if (!hasAttempts) sql.exec(`ALTER TABLE queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    // Messages given up on, and why; the catch-up pass at the end tries them again.
    sql.exec(`CREATE TABLE IF NOT EXISTS skipped (gmail_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);`);
  }

  #state(): ImportState | null {
    const raw = this.ctx.storage.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'state'`).toArray()[0]?.v;
    return raw ? (JSON.parse(raw) as ImportState) : null;
  }

  #save(st: ImportState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(st),
    );
  }

  #queued(): number {
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM queue`).toArray()[0]?.n ?? 0;
  }

  /**
   * Queue a window of past mail: `days` back from now (first import), or, with
   * `older`, from where the last run stopped back to `days` ago (0 = all of it).
   */
  async start(input: { address: string; days: number; older?: boolean; sortBudget: number }): Promise<ImportState> {
    const cur = this.#state();
    if (cur && (cur.phase === "listing" || cur.phase === "importing")) return cur;
    const now = Math.floor(Date.now() / 1000);
    const target = input.days > 0 ? now - input.days * 86_400 : 0;
    let query: string;
    if (input.older && cur) {
      if (cur.coveredAfter === 0 || (target !== 0 && target >= cur.coveredAfter)) return cur; // nothing older to get
      query = `${BASE_QUERY} before:${cur.coveredAfter}${target ? ` after:${target}` : ""}`;
    } else {
      query = `${BASE_QUERY}${target ? ` after:${target}` : ""}`;
    }
    const st: ImportState = {
      address: input.address,
      phase: "listing",
      query,
      coveredAfter: target,
      pageToken: null,
      total: 0,
      done: 0,
      skipped: 0,
      sorted: 0,
      sortBudget: input.sortBudget,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    };
    this.#save(st);
    await this.ctx.storage.setAlarm(Date.now());
    return st;
  }

  /** Pick up again after a reconnect. */
  async resume(): Promise<void> {
    const st = this.#state();
    if (st?.phase !== "paused") return;
    this.#save({ ...st, phase: st.pageToken !== null || st.total === 0 ? "listing" : "importing", lastError: null });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Stop and forget the queue (disconnect). */
  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.sql.exec(`DELETE FROM queue`);
    this.ctx.storage.sql.exec(`DELETE FROM meta`);
  }

  status(): (ImportState & { queued: number }) | null {
    const st = this.#state();
    return st ? { ...st, queued: this.#queued() } : null;
  }

  /** Queue every message in this run's window that the mailbox doesn't have yet. */
  async #reconcile(st: ImportState, api: ReturnType<typeof gmailFor>): Promise<number> {
    const mailbox = mailboxStub(this.env, st.address);
    let pageToken: string | undefined;
    let queued = 0;
    do {
      const page = await api.listMessages(st.query, pageToken);
      for (const m of page.messages ?? []) {
        if (await mailbox.gmailKnown(m.id)) continue;
        this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO queue (gmail_id) VALUES (?)`, m.id);
        queued++;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    this.ctx.storage.sql.exec(`DELETE FROM skipped`);
    if (queued) console.log("gmail import: catch-up queued", st.address, queued);
    return queued;
  }

  /** Run the catch-up pass for an import that finished before it existed. No-op otherwise. */
  async catchUp(): Promise<boolean> {
    const st = this.#state();
    if (!st || st.phase !== "done" || st.reconciled) return false;
    this.#save({ ...st, phase: "importing" });
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  /** Messages given up on, with why. */
  skippedList(): { gmail_id: string; reason: string; at: number }[] {
    return this.ctx.storage.sql
      .exec<Row<{ gmail_id: string; reason: string; at: number }>>(`SELECT gmail_id, reason, at FROM skipped ORDER BY at DESC LIMIT 50`)
      .toArray();
  }

  async alarm(): Promise<void> {
    const st = this.#state();
    if (!st || st.phase === "done" || st.phase === "paused") return;
    const api = gmailFor(this.env, st.address);

    try {
      if (st.phase === "listing") {
        let pageToken = st.pageToken ?? undefined;
        for (let i = 0; i < PAGES_PER_RUN; i++) {
          const page = await api.listMessages(st.query, pageToken);
          for (const m of page.messages ?? []) {
            this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO queue (gmail_id) VALUES (?)`, m.id);
          }
          st.total += page.messages?.length ?? 0;
          pageToken = page.nextPageToken;
          if (!pageToken) break;
        }
        st.pageToken = pageToken ?? null;
        if (!pageToken) st.phase = "importing";
        this.#save(st);
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return;
      }

      const batch = this.ctx.storage.sql
        .exec<Row<{ ord: number; gmail_id: string; attempts: number }>>(`SELECT ord, gmail_id, attempts FROM queue ORDER BY ord ASC LIMIT ?`, BATCH)
        .toArray();
      // A few at a time: each message is fetch, store, then sort, which is
      // mostly waiting. The storing step runs one at a time (exclusive) so a
      // conversation can't split into two threads.
      const queue = [...batch];
      let authFailure: unknown = null;
      let troubled = false;
      let chain: Promise<unknown> = Promise.resolve();
      const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => undefined);
        return run;
      };
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        for (let item = queue.shift(); item && !authFailure; item = queue.shift()) {
          try {
            const outcome = await importGmailMessage(this.env, st.address, api, item.gmail_id, { sort: st.sorted < st.sortBudget, exclusive });
            if (outcome === "stored") { st.done++; st.sorted++; } else st.skipped++;
            if (outcome === "too_large") st.lastError = "Skipped a message over 25 MB (Busta's size limit); it's still in Gmail.";
          } catch (e) {
            if (isAuthFailure(e)) { authFailure = e; return; }
            const gone = e instanceof GmailError && e.status === 404; // deleted in Gmail since it was listed
            const message = e instanceof Error ? e.message : String(e);
            troubled = true;
            const hiccup = PLATFORM_HICCUP.test(message);
            if (!gone && (hiccup || item.attempts + 1 < MAX_ATTEMPTS)) {
              if (!hiccup) this.ctx.storage.sql.exec(`UPDATE queue SET attempts = attempts + 1 WHERE ord = ?`, item.ord);
              st.lastError = message.slice(0, 300);
              console.error("gmail import: will retry", st.address, item.gmail_id, hiccup ? "(platform)" : `(try ${item.attempts + 1})`, message);
              continue;
            }
            st.skipped++;
            if (!gone) {
              st.lastError = `Skipped one message after ${MAX_ATTEMPTS} tries: ${message.slice(0, 200)}`;
              this.ctx.storage.sql.exec(
                `INSERT INTO skipped (gmail_id, reason, at) VALUES (?, ?, ?) ON CONFLICT(gmail_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
                item.gmail_id, message.slice(0, 300), Date.now(),
              );
              console.error("gmail import: skipped", st.address, item.gmail_id, message);
            }
          }
          this.ctx.storage.sql.exec(`DELETE FROM queue WHERE ord = ?`, item.ord);
        }
      }));
      // A clean batch clears an old problem, except a note about a skipped message.
      if (!troubled && st.lastError && !st.lastError.startsWith("Skipped")) st.lastError = null;
      this.#save(st);
      if (authFailure) throw authFailure;
      if (this.#queued() === 0) {
        if (!st.reconciled) {
          // Catch-up pass: list the window again and queue anything that isn't
          // in the mailbox yet (skipped, or missed). Runs once per import.
          await this.#reconcile(st, api);
          this.#save({ ...st, reconciled: true });
          await this.ctx.storage.setAlarm(Date.now() + 250);
          return;
        }
        this.#save({ ...st, phase: "done", finishedAt: Date.now(), lastError: st.lastError?.startsWith("Skipped") ? st.lastError : null });
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + 250);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isAuthFailure(e)) {
        this.#save({ ...st, phase: "paused", lastError: "Waiting for Gmail to be reconnected." });
        return;
      }
      console.error("gmail import failed", st.address, message);
      this.#save({ ...st, lastError: message.slice(0, 300) });
      await this.ctx.storage.setAlarm(Date.now() + (e instanceof GmailError && e.transient ? 60_000 : 5 * 60_000));
    }
  }
}
