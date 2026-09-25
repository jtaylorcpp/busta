import { DurableObject } from "cloudflare:workers";
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
}

const BATCH = 20;
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
        .exec<Row<{ ord: number; gmail_id: string }>>(`SELECT ord, gmail_id FROM queue ORDER BY ord ASC LIMIT ?`, BATCH)
        .toArray();
      for (const item of batch) {
        let outcome;
        try {
          outcome = await importGmailMessage(this.env, st.address, api, item.gmail_id, { sort: st.sorted < st.sortBudget });
        } catch (e) {
          if (!(e instanceof GmailError && e.status === 404)) throw e;
          outcome = "skipped" as const; // deleted in Gmail since it was listed
        }
        if (outcome === "stored") { st.done++; st.sorted++; } else st.skipped++;
        this.ctx.storage.sql.exec(`DELETE FROM queue WHERE ord = ?`, item.ord);
        this.#save(st);
      }
      if (this.#queued() === 0) {
        this.#save({ ...st, phase: "done", finishedAt: Date.now(), lastError: null });
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
