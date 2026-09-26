import { DurableObject } from "cloudflare:workers";
import { newThreadId } from "./addressing";
import { classify, deliver, nextAttemptDelay, type OutboundPayload } from "./delivery";
import type { MessageMetadata } from "./metadata";
import type { ThreadAttachment } from "./thread-do";
import { gmailTick, labelState, type GmailHost, type GmailState } from "./sources/gmail-sync";
import { gmailFor, vaultStub } from "./sources/vault";
import { tenantStub, threadStub } from "./mail";

export type Direction = "in" | "out";

type Row<T> = T & Record<string, SqlStorageValue>;

/** One row per message: everything the inbox list renders, and nothing more. */
export interface IndexedMessage {
  id: string;
  thread_id: string;
  direction: Direction;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  message_id: string | null;
  received_at: number;
  read: number;
  size: number;
  attachment_count: number;
  grafted: number;
  /** User sub-address label this arrived on, e.g. `sales+newsletter@`. */
  label: string | null;
  from_name: string | null;
  to_count: number;
  cc_count: number;
  list_id: string | null;
  subject_key: string | null;
  /** Packed booleans — see FLAG in metadata.ts. */
  flags: number;
  /** Packed SPF/DKIM/DMARC verdicts — see AUTH in metadata.ts. */
  auth: number;
  body_chars: number;
  /** Monotonic arrival sequence. Doubles as the full-text index rowid. */
  seq: number;
  /** Set when moved to Trash. Purging is a separate, explicit step. */
  deleted_at: number | null;
  /** Set when archived: out of Messages and folders, in the Archive bin. */
  archived_at: number | null;
  starred: number;
  /** sent | queued | failed | bounced — outbound only. */
  delivery_status: string | null;
  delivery_code: string | null;
  delivery_detail: string | null;
  folder_id: string | null;
  /** rule | address | you */
  folder_source: string | null;
  /** pending | filed | unsure | none | failed */
  folder_state: string | null;
  folder_suggest: string | null;
  folder_confidence: number | null;
  folder_probs: string | null;
}

export interface Folder {
  id: string;
  name: string;
  rule: string;
  plus_label: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  sorted_at: number | null;
  /** The rule before its last change; null when there is nothing to undo. */
  prev_rule: string | null;
}

export interface FolderWithCounts extends Folder {
  total: number;
  unread: number;
}

/** What a classifier (or a person) decided for one message. */
export interface FolderDecision {
  folderId: string | null;
  source: "rule" | "address" | "you";
  state: "filed" | "unsure" | "none" | "failed";
  suggest?: string | null;
  confidence?: number | null;
  probs?: Record<string, number> | null;
}

/** A message a folder save may sort (and the rule tester checks). */
export interface SortCandidate {
  id: string;
  thread_id: string;
  label: string | null;
  /** The folder it's in now, or null for Messages. */
  place: string | null;
  sender: string;
  from_name: string | null;
  subject: string;
}

export interface IndexInput {
  id: string;
  threadId: string;
  direction: Direction;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  messageId: string | null;
  receivedAt: number;
  size: number;
  attachmentCount: number;
  grafted?: boolean;
  label?: string | null;
  delivery?: { status: string; code?: string | null; detail?: string | null } | null;
  metadata?: MessageMetadata | null;
  /** Body text to index for search. Truncated by the caller. */
  searchBody?: string | null;
}

/**
 * Configuration for the generalized email agent that hosts this mailbox.
 *
 * There is one agent implementation, instantiated per mailbox address — the
 * same shape as Cloudflare's address-based resolver, where the address picks
 * the instance. Nothing is addressed as an agent: mail to `sales@` is already
 * mail to this mailbox's agent. An agent that needs to behave differently for
 * different mail reads the user label (`sales+triage@` → label `triage`).
 *
 * Per-conversation working state lives on ThreadDO, not here.
 */
export interface AgentConfig {
  enabled: boolean;
  /** Free-form policy the agent interprets: persona, rules, escalation. */
  policy: string | null;
  /** Labels the agent acts on. Empty means all mail to this address. */
  labels: string[];
  /** Whether drafts are sent automatically or held for review. */
  autoSend: boolean;
  updatedAt: number;
}

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  enabled: false,
  policy: null,
  labels: [],
  autoSend: false,
  updatedAt: 0,
};

/**
 * Progress through the Getting started guide (designs/2026-09-24-getting-started).
 * Three steps: describe what matters (creates the "Must read" folder), send
 * yourself a test, see where it went. `active` shows the guide on Messages,
 * `done` shows the one-time "You're set up" bar, `hidden` shows nothing.
 * Mailboxes created before the guide existed have no state, which reads as
 * hidden; the account menu can still open it.
 */
export interface GuideState {
  status: "active" | "done" | "hidden";
  folderId: string | null;
  ruleSkipped: boolean;
  /** When step 2 began (ms). */
  testSince: number | null;
  /**
   * The mailbox's arrival counter when step 2 began: the first mail received
   * after it is the test. Arrival order, not the Date header, which is the
   * sender's clock and can run behind.
   */
  testAfterSeq: number | null;
  testSkipped: boolean;
  landedId: string | null;
}

export interface GuideView extends GuideState {
  folderName: string | null;
  folderRule: string | null;
  /** The test message, once it has arrived. */
  landed: IndexedMessage | null;
}

const NEW_GUIDE: GuideState = {
  status: "active",
  folderId: null,
  ruleSkipped: false,
  testSince: null,
  testAfterSeq: null,
  testSkipped: false,
  landedId: null,
};

export interface Draft {
  id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** Set when the draft is a reply, so sending keeps the conversation. */
  thread_id: string | null;
  reply_to_id: string | null;
  /** JSON array of {id, filename, mime_type, size, r2_key}. */
  attachments_json: string | null;
  updated_at: number;
}

export interface ThreadResolution {
  threadId: string;
  isNewThread: boolean;
  /** Set when a signed reply tag pinned the thread rather than RFC headers. */
  trusted: boolean;
}

const SCHEMA_VERSION = 3;
/** Sequence numbers inspected per search step. */
const SEARCH_WINDOW = 5_000;
/** Ceiling for one Durable Object. */
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_HIGH_WATERMARK = 0.85;
const DEFAULT_LOW_WATERMARK = 0.7;
/** Messages whose search body is dropped per relief batch. */
const TRIM_BATCH = 500;
const TRIM_BUDGET = 20_000;

/**
 * One Durable Object per mailbox address — the index, not the store.
 *
 * Holds ownership, the message index that the inbox list renders, read state,
 * and the Message-ID → thread map used to resolve threading. Message bodies
 * and attachments live in ThreadDO; long-term bytes live in R2.
 *
 * Keeping bodies out means this DO stays small no matter how much mail flows
 * through, and listing an inbox is a single hop with no hydration.
 */
export class MailboxDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#migrate();
    // Keep-alive pings from open pages are answered by the runtime without
    // waking this object, so an idle tab costs nothing.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- live updates ----------------------------------------------------
  //
  // Open pages hold a hibernatable WebSocket to this object. Every method that
  // changes something a page shows announces it with a small event — never the
  // data itself; the page re-renders the affected region from the server. An
  // idle socket costs nothing: the object hibernates between events.
  //
  // Authentication and ownership are checked before the upgrade reaches here
  // (src/live.ts), so this only accepts.

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "closing"); } catch { /* already closed */ }
  }

  /**
   * Tell open pages what changed.
   *   new  — a message was indexed (id, its thread, direction)
   *   row  — one message's state changed (read, star, trash, folder, delivery)
   *   list — many rows changed at once
   *   nav  — folders or drafts changed (sidebar only)
   */
  #emit(event: { t: "new"; id: string; thread: string; dir: string } | { t: "row"; id: string } | { t: "list" } | { t: "nav" }): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const text = JSON.stringify(event);
    for (const ws of sockets) {
      try { ws.send(text); } catch { /* closing; the runtime will drop it */ }
    }
  }

  // ---- schema ----------------------------------------------------------

  /**
   * Schema setup, split by whether the step is safe to repeat.
   *
   * Only genuinely one-shot work is version-gated. Everything additive —
   * CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, add-column-if-
   * missing — runs on every construction, because gating it means an object
   * created at an older version never receives it. That bug is invisible in
   * testing whenever the local state is wiped between runs, and shows up only
   * against real data.
   */
  #migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);

    const from = Number(this.#meta("schema_version") ?? 0);

    // One-shot: v1/v2 stored whole messages here. Park them for backfill() to
    // move into ThreadDOs, then rebuild this DO as a pure index.
    if (from > 0 && from < SCHEMA_VERSION) {
      const hasLegacy = sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM pragma_table_info('messages') WHERE name = 'body_text'`,
        )
        .toArray()[0]?.n;

      if (hasLegacy) {
        sql.exec(`ALTER TABLE messages RENAME TO messages_legacy`);
        sql.exec(`ALTER TABLE attachments RENAME TO attachments_legacy`);
        this.#setMeta("backfill_pending", "1");
      }
    }

    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        thread_id        TEXT NOT NULL,
        direction        TEXT NOT NULL,
        sender           TEXT NOT NULL,
        recipient        TEXT NOT NULL,
        subject          TEXT NOT NULL,
        snippet          TEXT NOT NULL,
        message_id       TEXT,
        received_at      INTEGER NOT NULL,
        read             INTEGER NOT NULL DEFAULT 0,
        size             INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        -- 1 when this message joined an existing thread on attacker-supplied
        -- RFC headers rather than a signed reply tag.
        grafted          INTEGER NOT NULL DEFAULT 0,
        -- User sub-address label recorded at ingest, so the inbox can filter
        -- by the folder a message was addressed to.
        label            TEXT,
        -- Filterable metadata lifted from headers at ingest. All of it is
        -- re-derivable from the raw MIME in R2, so this is a cost optimisation
        -- rather than the only copy.
        from_name        TEXT,
        to_count         INTEGER NOT NULL DEFAULT 0,
        cc_count         INTEGER NOT NULL DEFAULT 0,
        list_id          TEXT,
        subject_key      TEXT,
        flags            INTEGER NOT NULL DEFAULT 0,
        auth             INTEGER NOT NULL DEFAULT 0,
        body_chars       INTEGER NOT NULL DEFAULT 0,
        seq              INTEGER,
        deleted_at       INTEGER,
        starred          INTEGER NOT NULL DEFAULT 0
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_received ON messages(received_at DESC);`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_thread ON messages(thread_id, received_at);`);

    // Message-ID → thread. Separate from `messages` so a reply can join a
    // thread even after its parent message row is deleted.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS msgids (
        message_id TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL
      );
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id       TEXT PRIMARY KEY,
        subject         TEXT NOT NULL,
        last_message_at INTEGER NOT NULL,
        message_count   INTEGER NOT NULL DEFAULT 0
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_threads_recent ON threads(last_message_at DESC);`);

    // Drafts live with the mailbox rather than a thread: most have no thread
    // yet, and they must survive being abandoned mid-compose.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id               TEXT PRIMARY KEY,
        "to"             TEXT NOT NULL DEFAULT '',
        cc               TEXT NOT NULL DEFAULT '',
        bcc              TEXT NOT NULL DEFAULT '',
        subject          TEXT NOT NULL DEFAULT '',
        body             TEXT NOT NULL DEFAULT '',
        thread_id        TEXT,
        reply_to_id      TEXT,
        attachments_json TEXT,
        updated_at       INTEGER NOT NULL
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_recent ON drafts(updated_at DESC);`);

    // Sends that failed transiently. Keeping them here rather than dropping
    // them is the whole point: a rate limit must not lose the user's mail.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id              TEXT PRIMARY KEY,
        message_id      TEXT,
        payload_json    TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_code       TEXT,
        last_error      TEXT,
        status          TEXT NOT NULL DEFAULT 'queued',
        created_at      INTEGER NOT NULL
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);`);

    // Local mirror of what we know has hard-bounced or complained. Cloudflare
    // keeps its own list; this one lets us refuse before spending a send.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS suppressions (
        address    TEXT PRIMARY KEY,
        reason     TEXT NOT NULL,
        status     TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    // Additive columns, applied idempotently so an existing v3 index picks
    // them up without another version bump.
    this.#addColumn("messages", "label", "TEXT");
    for (const [column, type] of [
      ["from_name", "TEXT"],
      ["to_count", "INTEGER NOT NULL DEFAULT 0"],
      ["cc_count", "INTEGER NOT NULL DEFAULT 0"],
      ["list_id", "TEXT"],
      ["subject_key", "TEXT"],
      ["flags", "INTEGER NOT NULL DEFAULT 0"],
      ["auth", "INTEGER NOT NULL DEFAULT 0"],
      ["body_chars", "INTEGER NOT NULL DEFAULT 0"],
      ["seq", "INTEGER"],
      ["fts_trimmed", "INTEGER NOT NULL DEFAULT 0"],
      ["deleted_at", "INTEGER"],
      ["starred", "INTEGER NOT NULL DEFAULT 0"],
      ["delivery_status", "TEXT"],
      ["delivery_code", "TEXT"],
      ["delivery_detail", "TEXT"],
      // Folder filing. folder_state: pending (being sorted) | filed | unsure
      // (best guess below the threshold, kept in folder_suggest) | none (no
      // folder fits) | failed (the model call errored). folder_source says who
      // filed it: rule | address | you. "you" is never overwritten by a rule.
      ["folder_id", "TEXT"],
      ["folder_source", "TEXT"],
      ["folder_state", "TEXT"],
      ["folder_suggest", "TEXT"],
      ["folder_confidence", "REAL"],
      /** JSON {folderId|"none": probability} for the top few options. */
      ["folder_probs", "TEXT"],
      // Archived: done, but kept. Out of Messages and folders, in the Archive
      // bin, still searchable. For Gmail it mirrors leaving Gmail's Inbox.
      ["archived_at", "INTEGER"],
    ] as const) {
      this.#addColumn("messages", column, type);
    }
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_idx_seq ON messages(seq);`);

    // Full-text index. FTS5 rowids are the arrival sequence, so iterating
    // rowid DESC is both newest-first and the order FTS5 walks natively —
    // that is what makes a cursor cheap instead of a full sort of every match.
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        id UNINDEXED,
        subject,
        sender,
        from_name,
        label,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);

    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_label ON messages(label, received_at DESC);`);

    // User folders under Messages. A folder is a filter over the index, not a
    // location: a message has at most one folder_id and never leaves Messages.
    // `rule` is plain English for the classifier; `plus_label` optionally
    // catches mail sent to local+plus_label@ without asking the model.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        rule        TEXT NOT NULL DEFAULT '',
        plus_label  TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        sorted_at   INTEGER
      );
    `);
    // The rule before its last change, so "Undo" can put it back.
    this.#addColumn("folders", "prev_rule", "TEXT");
    // The last "Sort mail I already have" for each folder: how every message
    // it changed was filed before, so "Undo" can put them back.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS sort_undo (
        folder_id  TEXT NOT NULL,
        message_id TEXT NOT NULL,
        prev       TEXT NOT NULL,
        PRIMARY KEY (folder_id, message_id)
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_folder ON messages(folder_id, seq DESC);`);
    // The list runs in each message's own time (arrival order breaks ties), so
    // imported mail can arrive in any order and still land where it belongs.
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_time ON messages(received_at DESC, seq DESC);`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_folder_time ON messages(folder_id, received_at DESC, seq DESC);`);
    // Partial index: most mail carries no List-Id, so this stays small while
    // making "all newsletters" a cheap query.
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_idx_list ON messages(list_id, received_at DESC)
         WHERE list_id IS NOT NULL;`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_sender ON messages(sender, received_at DESC);`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_idx_subject_key ON messages(subject_key);`);

    // Connected Gmail (src/sources/gmail-sync.ts): Gmail id ↔ Busta message,
    // and changes waiting to go to Gmail. Imports queue in ImportDO.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_ext (
        gmail_id     TEXT PRIMARY KEY,
        message_id   TEXT NOT NULL,
        gmail_thread TEXT
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_gmail_ext_msg ON gmail_ext(message_id);`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_outbox (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        gmail_id TEXT NOT NULL,
        op       TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at  INTEGER NOT NULL,
        error    TEXT
      );
    `);

    if (from !== SCHEMA_VERSION) this.#setMeta("schema_version", String(SCHEMA_VERSION));
  }

  #nextSeq(): number {
    const next = Number(this.#meta("seq_counter") ?? 0) + 1;
    this.#setMeta("seq_counter", String(next));
    return next;
  }

  #addColumn(table: string, column: string, type: string): void {
    const present = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`,
        table,
        column,
      )
      .toArray()[0]?.n;
    if (!present) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  #meta(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, key)
      .toArray();
    return rows.length > 0 ? rows[0]!.v : null;
  }

  #setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    );
  }

  // ---- ownership -------------------------------------------------------

  claim(orgId: string, address: string): { claimed: boolean; ownerOrgId: string } {
    const existing = this.#meta("owner_org_id");
    if (existing) return { claimed: existing === orgId, ownerOrgId: existing };

    this.#setMeta("owner_org_id", orgId);
    this.#setMeta("address", address);
    this.#setMeta("created_at", String(Date.now()));
    // A brand-new mailbox opens on the Getting started guide.
    if (this.#meta("guide") === null) this.#setMeta("guide", JSON.stringify(NEW_GUIDE));
    return { claimed: true, ownerOrgId: orgId };
  }

  ownerOrgId(): string | null {
    return this.#meta("owner_org_id");
  }

  /**
   * Hand a mailbox from one organization to another.
   *
   * `from` is required and checked rather than being a convenience: an
   * unconditional setter would let any caller who can name an address take it,
   * turning ownership into a suggestion. Passing the expected current owner
   * makes the swap a compare-and-set, and the Durable Object's single-threaded
   * execution makes that atomic — two simultaneous transfers cannot both win.
   */
  transfer(from: string, to: string): { transferred: boolean; ownerOrgId: string | null } {
    const current = this.#meta("owner_org_id");
    if (current !== from) return { transferred: false, ownerOrgId: current };
    this.#setMeta("owner_org_id", to);
    return { transferred: true, ownerOrgId: to };
  }

  release(orgId: string): boolean {
    if (this.#meta("owner_org_id") !== orgId) return false;
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'owner_org_id'`);
    return true;
  }

  // ---- getting started --------------------------------------------------

  #guideState(): GuideState {
    const raw = this.#meta("guide");
    return raw === null ? { ...NEW_GUIDE, status: "hidden" } : { ...NEW_GUIDE, ...JSON.parse(raw) };
  }

  /**
   * The guide with what the page needs to render it. While step 2 is waiting,
   * this is also where the test is detected: the first mail received since
   * `testSince` becomes the landed message.
   */
  guide(): GuideView {
    const state = this.#guideState();
    const sql = this.ctx.storage.sql;
    if (state.status !== "hidden" && state.testSince !== null && !state.landedId && !state.testSkipped) {
      // Guides saved before testAfterSeq existed fall back to the Date header.
      const first = (
        state.testAfterSeq !== null
          ? sql.exec<{ id: string }>(
              `SELECT id FROM messages WHERE direction = 'in' AND deleted_at IS NULL AND seq > ?
                ORDER BY seq ASC LIMIT 1`,
              state.testAfterSeq,
            )
          : sql.exec<{ id: string }>(
              `SELECT id FROM messages WHERE direction = 'in' AND deleted_at IS NULL AND received_at >= ?
                ORDER BY received_at ASC LIMIT 1`,
              state.testSince,
            )
      ).toArray()[0];
      if (first) {
        state.landedId = first.id;
        this.#setMeta("guide", JSON.stringify(state));
      }
    }
    const folder = state.folderId ? this.getFolder(state.folderId) : null;
    if (state.folderId && !folder) state.folderId = null; // deleted since
    const landed = state.landedId
      ? ((sql
          .exec<Row<IndexedMessage>>(`SELECT * FROM messages WHERE id = ?`, state.landedId)
          .toArray()[0] as IndexedMessage | undefined) ?? null)
      : null;
    return { ...state, folderName: folder?.name ?? null, folderRule: folder?.rule ?? null, landed };
  }

  /** Change the guide's progress; returns the new state. Notifies open pages. */
  updateGuide(patch: Partial<GuideState>): GuideState {
    const prev = this.#guideState();
    const next = { ...prev, ...patch };
    // Starting step 2 marks where in the arrival order the test must come after.
    if (patch.testSince && patch.testSince !== prev.testSince) next.testAfterSeq = Number(this.#meta("seq_counter") ?? 0);
    this.#setMeta("guide", JSON.stringify(next));
    this.#emit({ t: "list" });
    return next;
  }

  /** Open the guide again from the account menu, keeping the folder it made. */
  restartGuide(): GuideState {
    const { folderId } = this.#guideState();
    return this.updateGuide({ ...NEW_GUIDE, folderId: folderId && this.getFolder(folderId) ? folderId : null });
  }

  /** A folder by name, ignoring case — so the guide reuses an existing "Must read". */
  folderByName(name: string): Folder | null {
    const rows = this.ctx.storage.sql
      .exec<Row<Folder>>(`SELECT * FROM folders WHERE lower(name) = lower(?) LIMIT 1`, name.trim())
      .toArray();
    return (rows[0] as Folder | undefined) ?? null;
  }

  // ---- agent -----------------------------------------------------------

  agentConfig(): AgentConfig {
    const raw = this.#meta("agent_config");
    return raw === null ? { ...DEFAULT_AGENT_CONFIG } : { ...DEFAULT_AGENT_CONFIG, ...JSON.parse(raw) };
  }

  setAgentConfig(patch: Partial<Omit<AgentConfig, "updatedAt">>): AgentConfig {
    const next: AgentConfig = { ...this.agentConfig(), ...patch, updatedAt: Date.now() };
    this.#setMeta("agent_config", JSON.stringify(next));
    return next;
  }

  /** Whether the agent should act on a message carrying this label. */
  agentHandles(label: string | null): boolean {
    const config = this.agentConfig();
    if (!config.enabled) return false;
    return config.labels.length === 0 || (label !== null && config.labels.includes(label));
  }

  // ---- threading -------------------------------------------------------

  /**
   * Decide which thread a message belongs to.
   *
   * A verified reply tag wins outright. Otherwise we fall back to RFC 2822
   * headers, which are attacker-supplied — a sender who learns a Message-ID
   * can graft onto that thread. The damage is bounded to this one mailbox,
   * and `trusted` records which path was taken.
   */
  resolveThread(input: {
    verifiedThreadId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
  }): ThreadResolution {
    if (input.verifiedThreadId) {
      const known = this.ctx.storage.sql
        .exec(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`, input.verifiedThreadId)
        .toArray();
      if (known.length > 0) {
        return { threadId: input.verifiedThreadId, isNewThread: false, trusted: true };
      }
    }

    const candidates: string[] = [];
    if (input.inReplyTo) candidates.push(input.inReplyTo.trim());
    if (input.references) {
      // Newest first, so a deep thread still lands correctly when the
      // immediate parent was never delivered to this mailbox.
      candidates.push(...(input.references.match(/<[^>]+>/g) ?? []).reverse());
    }

    for (const candidate of candidates) {
      const rows = this.ctx.storage.sql
        .exec<{ thread_id: string }>(
          `SELECT thread_id FROM msgids WHERE message_id = ? LIMIT 1`,
          candidate,
        )
        .toArray();
      if (rows.length > 0) return { threadId: rows[0]!.thread_id, isNewThread: false, trusted: false };
    }

    return { threadId: newThreadId(), isNewThread: true, trusted: false };
  }

  /** Existing id for this Message-ID, so redelivery is idempotent. */
  findByMessageId(messageId: string): { id: string; thread_id: string } | null {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; thread_id: string }>(
        `SELECT id, thread_id FROM messages WHERE message_id = ? LIMIT 1`,
        messageId,
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  }

  // ---- index -----------------------------------------------------------

  /**
   * Check storage pressure after writes and schedule relief only when needed.
   * Nothing is scheduled in the common case, so a quiet mailbox has no alarms.
   */
  async checkPressure(): Promise<boolean> {
    const over =
      this.ctx.storage.sql.databaseSize >=
      this.#watermark(this.env.STORAGE_HIGH_WATERMARK, DEFAULT_HIGH_WATERMARK);
    if (over && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
    return over;
  }

  async alarm(): Promise<void> {
    const drained = await this.drainOutbox();
    const relief = await this.relieve();
    if (this.#meta("purge")) {
      // Deleting this mailbox's copies: nothing else runs, and the last step
      // wipes this object entirely.
      const more = await this.#purgeStep();
      if (more) await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }
    const gmailNext = this.#meta("gmail") ? await gmailTick(this.#gmailHost()) : null;

    // Whichever wants attention sooner wins the next alarm slot.
    const wants: number[] = [];
    if (gmailNext !== null) wants.push(gmailNext);
    if (!relief.settled && !relief.exhausted) wants.push(Date.now() + 60_000);
    const pending = this.outboxStats().nextAttemptAt;
    if (pending !== null) wants.push(pending);
    if (wants.length > 0) await this.ctx.storage.setAlarm(Math.min(...wants));

    if (drained.attempted > 0) {
      console.log("outbox drained", JSON.stringify(drained));
    }
  }

  // ---- connected Gmail -------------------------------------------------
  //
  // State lives in meta "gmail" (GmailState). The Google tokens don't live
  // here at all: GmailVaultDO holds them and makes every Gmail call.
  // The work happens in alarm() via gmailTick; everything else only records
  // what to do and asks for the alarm sooner.

  #gmail(): GmailState | null {
    const raw = this.#meta("gmail");
    return raw ? (JSON.parse(raw) as GmailState) : null;
  }

  #setGmail(patch: Partial<GmailState>): void {
    const cur = this.#gmail();
    if (!cur) return;
    this.#setMeta("gmail", JSON.stringify({ ...cur, ...patch }));
    this.#emit({ t: "nav" });
  }

  async #wake(delayMs = 0): Promise<void> {
    const at = Date.now() + delayMs;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  /** Start (or, with a new token, resume) syncing a Gmail account into this mailbox. */
  async connectGmail(input: { account: string }): Promise<void> {
    const cur = this.#gmail();
    // Remembered after a disconnect, so this address never sends as busta.app.
    this.#setMeta("source_kind", "gmail");
    // No Getting started: a connected account arrives with your folders.
    this.updateGuide({ status: "hidden" });
    const next: GmailState = cur
      ? { ...cur, status: "live", pending: true, lastError: null, watchRenewAt: 0 }
      : {
          account: input.account,
          status: "live",
          connectedAt: Date.now(),
          historyId: null,
          watchRenewAt: 0,
          watchExpires: null,
          lastSyncAt: null,
          lastMailAt: null,
          lastError: null,
          pending: true,
        };
    this.#setMeta("gmail", JSON.stringify(next));
    await this.#wake();
  }

  /** Gmail's push said something changed. */
  async gmailPushed(): Promise<boolean> {
    const st = this.#gmail();
    if (!st || st.status === "needs_reconnect") return false;
    this.#setGmail({ pending: true });
    await this.#wake();
    return true;
  }

  /** What the Accounts page shows. No secrets. */
  gmailStatus(): (GmailState & { changesWaiting: number }) | null {
    const st = this.#gmail();
    if (!st) return null;
    const waiting = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM gmail_outbox`).toArray()[0]?.n ?? 0;
    return { ...st, changesWaiting: waiting };
  }

  /**
   * How this address sends: busta (Email Sending), gmail (connected), or
   * gmail-off (a Gmail account that was disconnected: it must not send at all,
   * least of all as itself through Busta).
   */
  sendingAs(): "busta" | "gmail" | "gmail-off" {
    if (this.#gmail()?.status === "live") return "gmail";
    return this.#meta("source_kind") === "gmail" ? "gmail-off" : "busta";
  }

  /** Already brought in? */
  gmailKnown(gmailId: string): boolean {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM gmail_ext WHERE gmail_id = ? LIMIT 1`, gmailId).toArray().length > 0;
  }

  /** Set read, star, archive and trash from Gmail's labels, without echoing back. */
  applyGmailLabels(messageId: string, labels: string[]): void {
    this.#gmailHost().applyRemote(messageId, labelState(labels));
  }

  /**
   * Stop syncing and have the vault revoke Busta's access at Google and
   * forget the tokens. Mail already here stays. Returns whether Google
   * confirmed the revocation (null if nothing was connected).
   */
  async disconnectGmail(): Promise<boolean | null> {
    const st = this.#gmail();
    const address = this.#meta("address") ?? "";
    const vault = vaultStub(this.env, address);
    if (!st && !(await vault.holds())) return null;
    await gmailFor(this.env, address).stopWatch().catch(() => undefined); // the grant may already be gone
    const revoked = await vault.revoke();
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'gmail'`);
    this.ctx.storage.sql.exec(`DELETE FROM gmail_outbox`);
    this.#emit({ t: "nav" });
    return revoked;
  }

  // ---- deleting this mailbox's copies ------------------------------------

  /**
   * Delete everything this mailbox holds (Disconnect → "Delete it from
   * Busta"): messages, their bodies and files in R2, drafts, folders. Runs in
   * batches from the alarm; when done the org forgets the address and this
   * object is wiped. The source (Gmail) is never touched.
   */
  async startPurge(): Promise<{ total: number }> {
    const total = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`).toArray()[0]?.n ?? 0;
    if (!this.#meta("purge")) this.#setMeta("purge", JSON.stringify({ total, done: 0, startedAt: Date.now() }));
    this.#emit({ t: "nav" });
    await this.ctx.storage.setAlarm(Date.now());
    return { total };
  }

  purgeStatus(): { total: number; done: number } | null {
    const raw = this.#meta("purge");
    return raw ? (JSON.parse(raw) as { total: number; done: number }) : null;
  }

  async #purgeStep(): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const address = this.#meta("address") ?? "";
    const rows = sql.exec<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM messages LIMIT 50`).toArray();
    for (const r of rows) {
      const keys = await threadStub(this.env, address, r.thread_id).remove(r.id).catch(() => [] as string[]);
      if (keys.length) await this.env.MAIL_ARCHIVE.delete(keys);
      this.unindex(r.id);
    }
    if (rows.length > 0) {
      const st = this.purgeStatus()!;
      this.#setMeta("purge", JSON.stringify({ ...st, done: st.done + rows.length }));
      return true;
    }
    // Drafts' staged files, then the org's record, then everything here.
    for (const d of this.listDrafts(500)) for (const key of this.deleteDraft(d.id)) await this.env.MAIL_ARCHIVE.delete(key).catch(() => undefined);
    const org = this.#meta("owner_org_id");
    if (org) await tenantStub(this.env, org).removeMailbox(address);
    this.#emit({ t: "list" });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // This instance stays loaded; give it empty tables so the next request
    // sees an unowned mailbox (404) rather than a missing schema.
    this.#migrate();
    return false;
  }

  /** The Gmail thread a Busta message belongs to, for replying in the same Gmail thread. */
  gmailThreadOf(messageId: string): string | null {
    return this.ctx.storage.sql
      .exec<{ t: string | null }>(`SELECT gmail_thread AS t FROM gmail_ext WHERE message_id = ? LIMIT 1`, messageId)
      .toArray()[0]?.t ?? null;
  }

  linkGmail(gmailId: string, messageId: string, gmailThreadId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO gmail_ext (gmail_id, message_id, gmail_thread) VALUES (?, ?, ?)
       ON CONFLICT(gmail_id) DO UPDATE SET message_id = excluded.message_id, gmail_thread = excluded.gmail_thread`,
      gmailId, messageId, gmailThreadId,
    );
  }

  isGmail(): boolean {
    return this.#gmail() !== null;
  }

  /** Record a Busta-side change for Gmail, if this message came from Gmail. */
  #toGmail(messageId: string, op: string): void {
    if (this.#applyingRemote || !this.#meta("gmail")) return;
    const ext = this.ctx.storage.sql
      .exec<{ g: string }>(`SELECT gmail_id AS g FROM gmail_ext WHERE message_id = ? LIMIT 1`, messageId)
      .toArray()[0];
    if (!ext) return;
    this.ctx.storage.sql.exec(`INSERT INTO gmail_outbox (gmail_id, op, next_at) VALUES (?, ?, ?)`, ext.g, op, Date.now());
    void this.#wake(1000);
  }

  #applyingRemote = false;

  #gmailHost(): GmailHost {
    const sql = this.ctx.storage.sql;
    const address = this.#meta("address") ?? "";
    return {
      env: this.env,
      address,
      api: gmailFor(this.env, address),
      state: () => this.#gmail(),
      update: (patch) => this.#setGmail(patch),
      local: (gmailId) => sql
        .exec<Row<{ id: string }>>(`SELECT m.id FROM gmail_ext e JOIN messages m ON m.id = e.message_id WHERE e.gmail_id = ?`, gmailId)
        .toArray()[0] ?? null,
      applyRemote: (id, c) => {
        this.#applyingRemote = true;
        try {
          if (c.read !== undefined) this.setRead(id, c.read);
          if (c.starred !== undefined) this.setStarred(id, c.starred);
          if (c.trashed === true) this.trash(id);
          if (c.trashed === false) this.restore(id);
          if (c.archived !== undefined) this.setArchived(id, c.archived);
        } finally {
          this.#applyingRemote = false;
        }
      },
      outboxTake: (n) => sql
        .exec<Row<{ seq: number; gmail_id: string; op: string; attempts: number }>>(
          `SELECT seq, gmail_id, op, attempts FROM gmail_outbox WHERE next_at <= ? ORDER BY seq ASC LIMIT ?`, Date.now(), n,
        ).toArray(),
      outboxDone: (seq) => { sql.exec(`DELETE FROM gmail_outbox WHERE seq = ?`, seq); },
      outboxRetry: (seq, attempts, error) => {
        sql.exec(`UPDATE gmail_outbox SET attempts = ?, error = ?, next_at = ? WHERE seq = ?`, attempts, error.slice(0, 200), Date.now() + Math.min(2 ** attempts * 30_000, 3_600_000), seq);
      },
    };
  }

  /**
   * Retry queued sends that are due.
   *
   * Runs inside the Durable Object so the retry survives the request that
   * created it — the user closing their laptop must not be what decides
   * whether their mail goes out.
   */
  async drainOutbox(limit = 10): Promise<{ attempted: number; sent: number; failed: number }> {
    const due = this.dueOutbox(limit);
    let sent = 0;
    let failed = 0;

    for (const item of due) {
      const { payload, storedId } = JSON.parse(item.payload_json) as {
        payload: OutboundPayload;
        storedId: string;
      };

      try {
        const result = await deliver(this.env, payload);
        if (result.gmail) this.linkGmail(result.gmail.id, storedId, result.gmail.threadId);
        this.settleOutbox(item.id, "sent");
        this.setDelivery(storedId, "sent", null, null);
        this.ctx.storage.sql.exec(
          `UPDATE messages SET message_id = ? WHERE id = ?`,
          result.messageId,
          storedId,
        );
        sent += 1;
      } catch (error) {
        const verdict = classify(error);
        const delay =
          verdict.status === "failed" ? null : nextAttemptDelay(item.attempts);

        if (delay === null) {
          // Permanent, or out of attempts. Stop retrying and say so plainly
          // rather than leaving it queued forever where nobody looks.
          this.settleOutbox(item.id, "failed", verdict.code, verdict.message);
          this.setDelivery(
            storedId,
            "failed",
            verdict.code,
            verdict.status === "failed"
              ? verdict.remedy
              : // Do not append the transient remedy here — it says "queued
                // for retry", which is exactly what is no longer true.
                `Gave up after ${item.attempts} attempts. Last error: ${verdict.message.slice(0, 160)}`,
          );
          failed += 1;
        } else {
          await this.rescheduleOutbox(item.id, delay, verdict.code, verdict.message);
          this.setDelivery(storedId, "queued", verdict.code, verdict.remedy);
        }
      }
    }

    return { attempted: due.length, sent, failed };
  }

  /** Record a bounce against the original outbound message. */
  applyBounce(input: {
    originalMessageId: string | null;
    failedRecipient: string | null;
    permanent: boolean;
    status: string | null;
    description: string;
  }): { matchedId: string | null; suppressed: boolean } {
    let target: IndexedMessage | null = null;

    if (input.originalMessageId) target = this.findOutboundByMessageId(input.originalMessageId);
    // Fall back to the most recent unbounced message to that recipient: many
    // servers return a DSN without the original Message-ID.
    if (!target && input.failedRecipient) {
      target = this.findLatestOutboundTo(input.failedRecipient);
    }

    if (target) this.setDelivery(target.id, "bounced", input.status, input.description);

    let suppressed = false;
    if (input.permanent && input.failedRecipient) {
      this.suppress(input.failedRecipient, "hard bounce", input.status);
      suppressed = true;
    }

    return { matchedId: target?.id ?? null, suppressed };
  }

  index(input: IndexInput): void {
    const sql = this.ctx.storage.sql;

    // Re-indexing an existing message keeps its sequence, so a redelivery
    // never reorders search results or invalidates a live cursor.
    const existing = sql
      .exec<{ seq: number | null }>(`SELECT seq FROM messages WHERE id = ?`, input.id)
      .toArray()[0];
    const seq = existing?.seq ?? this.#nextSeq();

    sql.exec(
      `INSERT INTO messages
        (id, thread_id, direction, sender, recipient, subject, snippet,
         message_id, received_at, read, size, attachment_count, grafted, label,
         from_name, to_count, cc_count, list_id, subject_key, flags, auth, body_chars, seq,
         delivery_status, delivery_code, delivery_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         snippet = excluded.snippet,
         size    = excluded.size`,
      input.id,
      input.threadId,
      input.direction,
      input.sender,
      input.recipient,
      input.subject,
      input.snippet,
      input.messageId,
      input.receivedAt,
      // Outbound messages are authored by the user, so never "unread".
      input.direction === "out" ? 1 : 0,
      input.size,
      input.attachmentCount,
      input.grafted ? 1 : 0,
      input.label ?? null,
      input.metadata?.fromName ?? null,
      input.metadata?.toCount ?? 0,
      input.metadata?.ccCount ?? 0,
      input.metadata?.listId ?? null,
      input.metadata?.subjectKey ?? null,
      input.metadata?.flags ?? 0,
      input.metadata?.auth ?? 0,
      input.metadata?.bodyChars ?? 0,
      seq,
      input.delivery?.status ?? null,
      input.delivery?.code ?? null,
      input.delivery?.detail ?? null,
    );

    sql.exec(`DELETE FROM messages_fts WHERE rowid = ?`, seq);
    sql.exec(
      `INSERT INTO messages_fts (rowid, id, subject, sender, from_name, label, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      seq,
      input.id,
      input.subject,
      input.sender,
      input.metadata?.fromName ?? "",
      input.label ?? "",
      input.searchBody ?? input.snippet,
    );

    if (input.messageId) {
      sql.exec(
        `INSERT INTO msgids (message_id, thread_id) VALUES (?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
        input.messageId,
        input.threadId,
      );
    }

    sql.exec(
      `INSERT INTO threads (thread_id, subject, last_message_at, message_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(thread_id) DO UPDATE SET
         last_message_at = MAX(threads.last_message_at, excluded.last_message_at),
         message_count   = (SELECT COUNT(*) FROM messages WHERE thread_id = excluded.thread_id)`,
      input.threadId,
      input.subject,
      input.receivedAt,
    );
      this.#emit({ t: "new", id: input.id, thread: input.threadId, dir: input.direction });
  }

  // ---- storage pressure ------------------------------------------------

  #watermark(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    const ratio = Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
    return STORAGE_LIMIT_BYTES * ratio;
  }

  pressure(): {
    databaseSize: number;
    highWatermark: number;
    lowWatermark: number;
    limit: number;
    overHigh: boolean;
    usedFraction: number;
    trimmed: number;
  } {
    const size = this.ctx.storage.sql.databaseSize;
    const high = this.#watermark(this.env.STORAGE_HIGH_WATERMARK, DEFAULT_HIGH_WATERMARK);
    const trimmed =
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE fts_trimmed = 1`)
        .toArray()[0]?.n ?? 0;
    return {
      databaseSize: size,
      highWatermark: high,
      lowWatermark: this.#watermark(this.env.STORAGE_LOW_WATERMARK, DEFAULT_LOW_WATERMARK),
      limit: STORAGE_LIMIT_BYTES,
      overHigh: size >= high,
      usedFraction: size / STORAGE_LIMIT_BYTES,
      trimmed,
    };
  }

  /**
   * Relieve storage pressure on the index.
   *
   * Unlike a thread, the index has no bodies to move — the message rows *are*
   * the inbox. The recoverable space is the full-text body content, which is
   * the single largest component (FTS5 costs ~2.4 bytes per indexed
   * character). Oldest messages are re-indexed on subject, sender and label
   * alone, so they stay listable and findable by header, losing only body
   * search depth. Nothing is deleted and no mail becomes unreadable: the body
   * is still in the thread, and the raw MIME is still in R2.
   */
  async relieve(): Promise<{
    trimmed: number;
    sizeBefore: number;
    sizeAfter: number;
    /** No further relief needed right now — storage is in an acceptable state. */
    settled: boolean;
    exhausted: boolean;
  }> {
    const sql = this.ctx.storage.sql;
    const sizeBefore = sql.databaseSize;
    const high = this.#watermark(this.env.STORAGE_HIGH_WATERMARK, DEFAULT_HIGH_WATERMARK);

    if (sizeBefore < high) {
      return { trimmed: 0, sizeBefore, sizeAfter: sizeBefore, settled: true, exhausted: false };
    }

    const low = this.#watermark(this.env.STORAGE_LOW_WATERMARK, DEFAULT_LOW_WATERMARK);

    // databaseSize does not drop until the transaction commits, so a mid-loop
    // check reads as zero progress and would trim every message in the
    // mailbox. Size the run from the measured FTS cost instead — roughly 2.4
    // bytes per indexed character — and re-check on the next alarm.
    const indexedChars = Number(this.env.SEARCH_BODY_CHARS ?? 2000);
    const averageIndexed =
      sql
        .exec<{ avg: number | null }>(
          `SELECT AVG(MIN(body_chars, ?)) AS avg FROM messages WHERE fts_trimmed = 0`,
          Number.isFinite(indexedChars) ? indexedChars : 2000,
        )
        .toArray()[0]?.avg ?? 0;

    const perMessage = Math.max(averageIndexed * 2.4, 64);
    const target = Math.min(TRIM_BUDGET, Math.ceil((sizeBefore - low) / perMessage));

    let trimmed = 0;
    let exhausted = false;

    while (trimmed < target) {
      const rows = sql
        .exec<{ id: string; seq: number; subject: string; sender: string; from_name: string | null; label: string | null }>(
          `SELECT id, seq, subject, sender, from_name, label
             FROM messages
            WHERE fts_trimmed = 0 AND seq IS NOT NULL
            ORDER BY seq ASC
            LIMIT ?`,
          Math.min(TRIM_BATCH, target - trimmed),
        )
        .toArray();

      if (rows.length === 0) {
        exhausted = true;
        break;
      }

      for (const row of rows) {
        sql.exec(`DELETE FROM messages_fts WHERE rowid = ?`, row.seq);
        sql.exec(
          `INSERT INTO messages_fts (rowid, id, subject, sender, from_name, label, body)
           VALUES (?, ?, ?, ?, ?, ?, '')`,
          row.seq,
          row.id,
          row.subject,
          row.sender,
          row.from_name ?? "",
          row.label ?? "",
        );
        sql.exec(`UPDATE messages SET fts_trimmed = 1 WHERE id = ?`, row.id);
      }
      trimmed += rows.length;
    }

    const sizeAfter = sql.databaseSize;
    this.#setMeta("last_relief_at", String(Date.now()));
    return { trimmed, sizeBefore, sizeAfter, settled: sizeAfter <= low, exhausted };
  }

  /** Reports whether FTS5 virtual tables can be created in this runtime. */
  probeFts(): { available: boolean; error?: string; bytesFor1000?: number } {
    const sql = this.ctx.storage.sql;
    try {
      sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_probe USING fts5(subject, body)`);
      const before = sql.databaseSize;
      for (let i = 0; i < 1000; i += 1) {
        sql.exec(
          `INSERT INTO fts_probe (subject, body) VALUES (?, ?)`,
          `Quarterly procurement review and vendor pricing #${i}`,
          `Hi there, following up on the thread below about bulk pricing for the next ` +
            `quarter. We would like to revise the quantities upward and confirm lead ` +
            `times before the end of the month. Please send a revised quote #${i}.`,
        );
      }
      const after = sql.databaseSize;
      const hits = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM fts_probe WHERE fts_probe MATCH ?`, "procurement")
        .toArray()[0]?.n;
      sql.exec(`DROP TABLE fts_probe`);
      return { available: hits === 1000, bytesFor1000: after - before };
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Exact bytes this object's SQLite database occupies, indexes included. */
  databaseSize(): number {
    return this.ctx.storage.sql.databaseSize;
  }

  /** Index many messages in one call. Used by bulk ingest and capacity tests. */
  bulkIndex(inputs: IndexInput[]): number {
    for (const input of inputs) this.index(input);
    this.#emit({ t: "list" });
    return inputs.length;
  }

  /**
   * Inbox listing. `before` is a sequence cursor for paging back through
   * history; trashed messages are excluded unless explicitly requested.
   */
  list(
    limit = 50,
    offset = 0,
    filter?: {
      label?: string;
      before?: number;
      trash?: boolean;
      starred?: boolean;
      /** Exclude starred rows (the second half of a "starred first" listing). */
      unstarred?: boolean;
      /** messages = received mail, sent = our own. Ignored in Trash. */
      box?: "messages" | "sent";
      folder?: string;
      unread?: boolean;
      /** Page cursor: the (received_at, seq) of the last row shown. */
      after?: { at: number; seq: number };
      /** The Archive bin. */
      archived?: boolean;
    },
  ): IndexedMessage[] {
    const where: string[] = [filter?.trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
    const bindings: SqlStorageValue[] = [];
    // Archived mail is only in the Archive bin (and Sent keeps what you sent).
    if (filter?.archived) where.push("archived_at IS NOT NULL");
    else if (!filter?.trash && (filter?.box === "messages" || filter?.folder)) where.push("archived_at IS NULL");

    if (!filter?.trash && filter?.box) where.push(filter.box === "sent" ? "direction = 'out'" : "direction = 'in'");
    if (filter?.folder) {
      where.push("folder_id = ?");
      bindings.push(filter.folder);
    }
    if (filter?.unstarred) where.push("starred = 0");
    if (filter?.unread) where.push("read = 0");

    if (filter?.label) {
      where.push("label = ?");
      bindings.push(filter.label);
    }
    if (filter?.starred) where.push("starred = 1");
    // Guard on the type, not on `!== undefined`: a caller passing null for
    // "no cursor" would otherwise produce `seq < NULL`, which matches nothing.
    if (typeof filter?.before === "number" && Number.isFinite(filter.before)) {
      where.push("seq < ?");
      bindings.push(filter.before);
    }
    const after = filter?.after;
    if (after && Number.isFinite(after.at) && Number.isFinite(after.seq)) {
      where.push("(received_at < ? OR (received_at = ? AND seq < ?))");
      bindings.push(after.at, after.at, after.seq);
    }

    return this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(
        `SELECT * FROM messages WHERE ${where.join(" AND ")}
          ORDER BY received_at DESC, seq DESC LIMIT ? OFFSET ?`,
        ...bindings,
        limit,
        offset,
      )
      .toArray();
  }

  /** Move to Trash. Reversible, and nothing in R2 is touched. */
  trash(id: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
      Date.now(),
      id,
    );
      this.#emit({ t: "row", id });
    this.#toGmail(id, "trash");
  }

  restore(id: string): void {
    this.ctx.storage.sql.exec(`UPDATE messages SET deleted_at = NULL WHERE id = ?`, id);
      this.#emit({ t: "row", id });
    this.#toGmail(id, "untrash");
  }

  setStarred(id: string, starred: boolean): void {
    this.ctx.storage.sql.exec(
      `UPDATE messages SET starred = ? WHERE id = ?`,
      starred ? 1 : 0,
      id,
    );
      this.#emit({ t: "row", id });
    this.#toGmail(id, starred ? "star" : "unstar");
  }

  setRead(id: string, read: boolean): void {
    this.ctx.storage.sql.exec(`UPDATE messages SET read = ? WHERE id = ?`, read ? 1 : 0, id);
      this.#emit({ t: "row", id });
    this.#toGmail(id, read ? "read" : "unread");
  }

  /** Archive or bring back. For Gmail, the same as leaving or rejoining the Inbox. */
  setArchived(id: string, archived: boolean): void {
    if (archived) this.ctx.storage.sql.exec(`UPDATE messages SET archived_at = ? WHERE id = ? AND archived_at IS NULL`, Date.now(), id);
    else this.ctx.storage.sql.exec(`UPDATE messages SET archived_at = NULL WHERE id = ?`, id);
    this.#emit({ t: "row", id });
    this.#toGmail(id, archived ? "archive" : "unarchive");
  }

  /**
   * Filter the index on the captured metadata. Deliberately narrow for now —
   * the point of capturing the columns early is that richer queries become a
   * SQL change rather than a re-ingest of every archived message.
   */
  search(query: {
    label?: string;
    listId?: string;
    sender?: string;
    subjectKey?: string;
    /** Bits that must all be set. */
    flagsAll?: number;
    /** Bits that must all be clear. */
    flagsNone?: number;
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  }): IndexedMessage[] {
    const where: string[] = [];
    const bindings: SqlStorageValue[] = [];

    if (query.label) {
      where.push("label = ?");
      bindings.push(query.label);
    }
    if (query.listId) {
      where.push("list_id = ?");
      bindings.push(query.listId);
    }
    if (query.sender) {
      where.push("sender = ?");
      bindings.push(query.sender);
    }
    if (query.subjectKey) {
      where.push("subject_key = ?");
      bindings.push(query.subjectKey);
    }
    if (query.flagsAll) {
      where.push("(flags & ?) = ?");
      bindings.push(query.flagsAll, query.flagsAll);
    }
    if (query.flagsNone) {
      where.push("(flags & ?) = 0");
      bindings.push(query.flagsNone);
    }
    if (query.unreadOnly) where.push("read = 0");

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(
        `SELECT * FROM messages ${clause} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
        ...bindings,
        query.limit ?? 50,
        query.offset ?? 0,
      )
      .toArray();
  }

  /**
   * Cursor-paginated full-text search, newest first.
   *
   * Walks the FTS index in descending rowid (arrival) order in batches, so a
   * page costs work proportional to what it returns rather than to the size of
   * the whole match set. Structured filters are applied as we go; if they are
   * selective we keep pulling batches until the page fills, a scan budget is
   * spent, or history runs out.
   *
   * `nextCursor` is the sequence to resume strictly below. A non-null cursor
   * with a short page means "budget spent, call again" — not "no more
   * results"; only `exhausted` means the history ran out.
   */
  searchText(query: {
    q: string;
    cursor?: number | null;
    limit?: number;
    /** Sequence numbers to inspect per call. Bounds work, not result count. */
    maxScan?: number;
    label?: string;
    listId?: string;
    sender?: string;
    flagsAll?: number;
    flagsNone?: number;
    unreadOnly?: boolean;
  }): {
    results: IndexedMessage[];
    nextCursor: number | null;
    /** Sequence numbers inspected this call — the real work measure. */
    examined: number;
    exhausted: boolean;
  } {
    const sql = this.ctx.storage.sql;
    const limit = Math.min(query.limit ?? 25, 100);
    const maxScan = Math.min(query.maxScan ?? 50_000, 1_000_000);
    const match = buildMatchExpression(query.q);

    if (!match) return { results: [], nextCursor: null, examined: 0, exhausted: true };

    const filters: string[] = ["m.deleted_at IS NULL"];
    const filterBindings: SqlStorageValue[] = [];
    if (query.label) {
      filters.push("m.label = ?");
      filterBindings.push(query.label);
    }
    if (query.listId) {
      filters.push("m.list_id = ?");
      filterBindings.push(query.listId);
    }
    if (query.sender) {
      filters.push("m.sender = ?");
      filterBindings.push(query.sender);
    }
    if (query.flagsAll) {
      filters.push("(m.flags & ?) = ?");
      filterBindings.push(query.flagsAll, query.flagsAll);
    }
    if (query.flagsNone) {
      filters.push("(m.flags & ?) = 0");
      filterBindings.push(query.flagsNone);
    }
    if (query.unreadOnly) filters.push("m.read = 0");
    const clause = `AND ${filters.join(" AND ")}`;

    const results: IndexedMessage[] = [];
    const highWater = Number(this.#meta("seq_counter") ?? 0) + 1;
    let cursor = query.cursor ?? highWater;
    let examined = 0;
    let exhausted = false;

    // Each step inspects a bounded slice of the sequence space rather than
    // letting one query walk the whole index. A selective filter therefore
    // costs several cheap steps instead of one unbounded scan.
    while (results.length < limit && examined < maxScan && cursor > 0) {
      const floor = Math.max(0, cursor - SEARCH_WINDOW);
      const want = limit - results.length;

      const rows = sql
        .exec<Row<IndexedMessage>>(
          `SELECT m.*
             FROM messages_fts f
             JOIN messages m ON m.id = f.id
            WHERE messages_fts MATCH ?
              AND f.rowid < ?
              AND f.rowid >= ?
              ${clause}
            ORDER BY f.rowid DESC
            LIMIT ?`,
          match,
          cursor,
          floor,
          ...filterBindings,
          want,
        )
        .toArray();

      const windowTop = cursor;

      for (const row of rows) {
        results.push(row as IndexedMessage);
        // Resume strictly below the last row actually returned. Advancing to
        // the end of the batch instead would skip every match in between.
        cursor = Number(row.seq);
      }

      if (results.length >= limit) {
        // Only the part of the window actually traversed counts as work.
        examined += windowTop - cursor;
        break;
      }

      // Window drained without filling the page — drop to the next slice.
      examined += windowTop - floor;
      cursor = floor;
      if (floor === 0) exhausted = true;
    }

    if (cursor <= 0) exhausted = true;

    return {
      results,
      nextCursor: exhausted ? null : cursor,
      examined,
      exhausted,
    };
  }

  /** Mailing lists seen in this mailbox, for a "newsletters" view. */
  lists(): { list_id: string; total: number; unread: number }[] {
    return this.ctx.storage.sql
      .exec<{ list_id: string; total: number; unread: number }>(
        `SELECT list_id,
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS unread
           FROM messages
          WHERE list_id IS NOT NULL
          GROUP BY list_id
          ORDER BY total DESC
          LIMIT 100`,
      )
      .toArray();
  }

  /**
   * Labels actually seen on delivered mail, with counts. Nothing is
   * pre-registered — a label exists because someone mailed it.
   */
  // ---- folders ----------------------------------------------------------

  listFolders(): FolderWithCounts[] {
    return this.ctx.storage.sql
      .exec<Row<FolderWithCounts>>(
        `SELECT f.*,
                COALESCE(SUM(CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS total,
                COALESCE(SUM(CASE WHEN m.read = 0 THEN 1 ELSE 0 END), 0) AS unread
           FROM folders f
           LEFT JOIN messages m ON m.folder_id = f.id AND m.deleted_at IS NULL AND m.archived_at IS NULL
          GROUP BY f.id
          ORDER BY f.position ASC, f.created_at ASC`,
      )
      .toArray() as FolderWithCounts[];
  }

  getFolder(id: string): Folder | null {
    const rows = this.ctx.storage.sql.exec<Row<Folder>>(`SELECT * FROM folders WHERE id = ?`, id).toArray();
    return (rows[0] as Folder | undefined) ?? null;
  }

  /** Create (no id) or update a folder. Returns its id. */
  saveFolder(input: { id?: string; name: string; rule: string; plusLabel?: string | null }): string {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const plus = input.plusLabel?.trim().toLowerCase() || null;
    const current = input.id ? this.getFolder(input.id) : null;
    if (input.id && current) {
      const rule = input.rule.trim();
      sql.exec(
        `UPDATE folders SET name = ?, rule = ?, plus_label = ?, updated_at = ?, prev_rule = ? WHERE id = ?`,
        input.name.trim(), rule, plus, now, rule === current.rule ? current.prev_rule : current.rule, input.id,
      );
      this.#emit({ t: "nav" });
      return input.id;
    }
    const id = crypto.randomUUID();
    const next = sql.exec<{ p: number }>(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM folders`).toArray()[0]?.p ?? 0;
    sql.exec(
      `INSERT INTO folders (id, name, rule, plus_label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, input.name.trim(), input.rule.trim(), plus, next, now, now,
    );
    this.#emit({ t: "nav" });
    return id;
  }

  /** Put a folder's rule back to what it was before its last change. */
  undoRule(id: string): Folder | null {
    const f = this.getFolder(id);
    if (!f || f.prev_rule === null) return null;
    this.ctx.storage.sql.exec(
      `UPDATE folders SET rule = ?, prev_rule = NULL, updated_at = ? WHERE id = ?`,
      f.prev_rule, Date.now(), id,
    );
    this.#emit({ t: "nav" });
    return this.getFolder(id);
  }

  /** Delete a folder. Its mail stays in Messages, unfiled. */
  deleteFolder(id: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `UPDATE messages SET folder_id = NULL, folder_source = NULL, folder_state = NULL,
              folder_suggest = NULL, folder_confidence = NULL, folder_probs = NULL
        WHERE folder_id = ? OR folder_suggest = ?`,
      id, id,
    );
    sql.exec(`DELETE FROM folders WHERE id = ?`, id);
    sql.exec(`DELETE FROM sort_undo WHERE folder_id = ?`, id);
      this.#emit({ t: "list" });
  }

  /**
   * Put folders in this order, by name (trimmed, case-insensitive): the order
   * mail is sorted in. Folders not named keep their order, after the rest.
   */
  reorderFolders(names: string[]): void {
    const rank = new Map(names.map((n, i) => [n.trim().replace(/\s+/g, " ").toLowerCase(), i]));
    const list = this.listFolders();
    const key = (f: Folder) => rank.get(f.name.trim().replace(/\s+/g, " ").toLowerCase()) ?? names.length;
    const next = list.map((f, i) => ({ f, i })).sort((a, b) => key(a.f) - key(b.f) || a.i - b.i);
    next.forEach(({ f }, pos) => this.ctx.storage.sql.exec(`UPDATE folders SET position = ? WHERE id = ?`, pos, f.id));
    this.#emit({ t: "nav" });
  }

  markFoldersSorted(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) this.ctx.storage.sql.exec(`UPDATE folders SET sorted_at = ? WHERE id = ?`, now, id);
      this.#emit({ t: "nav" });
  }

  /** Mark a message as being sorted, unless a person already filed it. */
  markSorting(id: string): boolean {
    const cur = this.lookup(id);
    if (!cur || cur.folder_source === "you") return false;
    this.ctx.storage.sql.exec(`UPDATE messages SET folder_state = 'pending' WHERE id = ?`, id);
    this.#emit({ t: "row", id });
    return true;
  }

  /**
   * Record a filing decision. A rule or +address never overrides a folder a
   * person chose; a person's choice always wins.
   */
  fileMessage(id: string, d: FolderDecision): boolean {
    const cur = this.lookup(id);
    if (!cur) return false;
    if (d.source !== "you" && cur.folder_source === "you") return false;
    this.ctx.storage.sql.exec(
      `UPDATE messages SET folder_id = ?, folder_source = ?, folder_state = ?, folder_suggest = ?,
              folder_confidence = ?, folder_probs = ? WHERE id = ?`,
      d.folderId,
      d.source,
      d.state,
      d.suggest ?? null,
      d.confidence ?? null,
      d.probs ? JSON.stringify(d.probs) : null,
      id,
    );
    this.#emit({ t: "row", id });
    return true;
  }

  /**
   * Received mail to re-sort: within the window, newest first, never trashed
   * or already filed by hand. Ids only; the caller classifies each.
   */
  recentForSorting(input: { days: number; limit: number }): { id: string; thread_id: string; label: string | null }[] {
    const since = Date.now() - Math.max(0, input.days) * 86_400_000;
    return this.ctx.storage.sql
      .exec<{ id: string; thread_id: string; label: string | null }>(
        `SELECT id, thread_id, label FROM messages
          WHERE direction = 'in' AND deleted_at IS NULL AND received_at >= ?
            AND (folder_source IS NULL OR folder_source != 'you')
          ORDER BY seq DESC LIMIT ?`,
        since,
        Math.max(1, Math.min(input.limit, 1000)),
      )
      .toArray();
  }

  /**
   * Received mail "Sort mail I already have" looks at, and the rule tester
   * checks: within the window, newest first, in Messages or a folder. Never
   * trashed, archived, or filed by hand.
   */
  sortCandidates(input: { days: number; limit: number }): SortCandidate[] {
    const since = Date.now() - Math.max(0, input.days) * 86_400_000;
    return this.ctx.storage.sql
      .exec<Row<SortCandidate>>(
        `SELECT id, thread_id, label, folder_id AS place, sender, from_name, subject FROM messages
          WHERE direction = 'in' AND deleted_at IS NULL AND archived_at IS NULL AND received_at >= ?
            AND (folder_source IS NULL OR folder_source != 'you')
          ORDER BY seq DESC LIMIT ?`,
        since,
        Math.max(1, Math.min(input.limit, 1000)),
      )
      .toArray() as SortCandidate[];
  }

  /** A new sort for this folder starts: forget the last one's Undo. */
  startSortUndo(folderId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM sort_undo WHERE folder_id = ?`, folderId);
  }

  /** Before a sort changes a message, remember how it was filed. */
  rememberForUndo(folderId: string, messageId: string): void {
    const cur = this.lookup(messageId);
    if (!cur) return;
    const prev = {
      folder_id: cur.folder_id, folder_source: cur.folder_source, folder_state: cur.folder_state,
      folder_suggest: cur.folder_suggest, folder_confidence: cur.folder_confidence, folder_probs: cur.folder_probs,
    };
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO sort_undo (folder_id, message_id, prev) VALUES (?, ?, ?)`,
      folderId, messageId, JSON.stringify(prev),
    );
  }

  /**
   * Undo the last sort for this folder: every message it changed goes back to
   * how it was filed, unless a person has filed it since. Returns how many.
   */
  undoSort(folderId: string): number {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<{ message_id: string; prev: string }>(`SELECT message_id, prev FROM sort_undo WHERE folder_id = ?`, folderId).toArray();
    let n = 0;
    for (const r of rows) {
      const cur = this.lookup(r.message_id);
      if (!cur || cur.folder_source === "you") continue;
      const p = JSON.parse(r.prev) as Pick<IndexedMessage, "folder_id" | "folder_source" | "folder_state" | "folder_suggest" | "folder_confidence" | "folder_probs">;
      sql.exec(
        `UPDATE messages SET folder_id = ?, folder_source = ?, folder_state = ?, folder_suggest = ?,
                folder_confidence = ?, folder_probs = ? WHERE id = ?`,
        p.folder_id, p.folder_source, p.folder_state, p.folder_suggest, p.folder_confidence, p.folder_probs, r.message_id,
      );
      n += 1;
    }
    sql.exec(`DELETE FROM sort_undo WHERE folder_id = ?`, folderId);
    if (n) this.#emit({ t: "list" });
    return n;
  }

  /** Received mail for a rule preview: the newest few, filed or not. */
  recentReceived(limit: number): IndexedMessage[] {
    return this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(
        `SELECT * FROM messages WHERE direction = 'in' AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?`,
        Math.max(1, Math.min(limit, 50)),
      )
      .toArray() as IndexedMessage[];
  }

  boxCounts(): { messages: number; messagesUnread: number; sent: number; archived: number } {
    const row = this.ctx.storage.sql
      .exec<{ messages: number; messagesUnread: number; sent: number; archived: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'in' AND archived_at IS NULL THEN 1 ELSE 0 END), 0) AS messages,
                COALESCE(SUM(CASE WHEN direction = 'in' AND archived_at IS NULL AND read = 0 THEN 1 ELSE 0 END), 0) AS messagesUnread,
                COALESCE(SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END), 0) AS sent,
                COALESCE(SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived
           FROM messages WHERE deleted_at IS NULL`,
      )
      .toArray()[0];
    return { messages: row?.messages ?? 0, messagesUnread: row?.messagesUnread ?? 0, sent: row?.sent ?? 0, archived: row?.archived ?? 0 };
  }

  labels(): { label: string; total: number; unread: number }[] {
    return this.ctx.storage.sql
      .exec<{ label: string; total: number; unread: number }>(
        `SELECT label,
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS unread
           FROM messages
          WHERE label IS NOT NULL
          GROUP BY label
          ORDER BY total DESC`,
      )
      .toArray();
  }

  /** Index rows for one conversation — enough to render a thread with no extra hops. */
  threadIndex(threadId: string): IndexedMessage[] {
    return this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(
        `SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC`,
        threadId,
      )
      .toArray();
  }

  lookup(id: string): IndexedMessage | null {
    const rows = this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(`SELECT * FROM messages WHERE id = ?`, id)
      .toArray();
    return rows.length > 0 ? (rows[0]! as IndexedMessage) : null;
  }

  markRead(id: string): void {
    const was = this.ctx.storage.sql.exec<{ read: number }>(`SELECT read FROM messages WHERE id = ?`, id).toArray()[0];
    this.ctx.storage.sql.exec(`UPDATE messages SET read = 1 WHERE id = ?`, id);
      this.#emit({ t: "row", id });
    if (was && !was.read) this.#toGmail(id, "read");
  }

  unindex(id: string): void {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ seq: number | null }>(`SELECT seq FROM messages WHERE id = ?`, id)
      .toArray()[0];
    if (row?.seq != null) sql.exec(`DELETE FROM messages_fts WHERE rowid = ?`, row.seq);
    sql.exec(`DELETE FROM messages WHERE id = ?`, id);
      this.#emit({ t: "list" });
  }

  stats(): { total: number; unread: number; threads: number; trashed: number; starred: number } {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ total: number; unread: number; trashed: number; starred: number }>(
        `SELECT COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS total,
                COALESCE(SUM(CASE WHEN read = 0 AND deleted_at IS NULL AND archived_at IS NULL THEN 1 ELSE 0 END), 0) AS unread,
                COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trashed,
                COALESCE(SUM(CASE WHEN starred = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS starred
           FROM messages`,
      )
      .toArray()[0];
    const threads =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM threads`).toArray()[0]?.n ?? 0;
    return {
      total: row?.total ?? 0,
      unread: row?.unread ?? 0,
      threads,
      trashed: row?.trashed ?? 0,
      starred: row?.starred ?? 0,
    };
  }

  // ---- delivery, outbox and suppression --------------------------------

  setDelivery(id: string, status: string, code: string | null, detail: string | null): void {
    this.ctx.storage.sql.exec(
      `UPDATE messages SET delivery_status = ?, delivery_code = ?, delivery_detail = ? WHERE id = ?`,
      status,
      code,
      detail,
      id,
    );
      this.#emit({ t: "row", id });
  }

  /** Find an outbound message by its RFC Message-ID, to attach a bounce to it. */
  findOutboundByMessageId(messageId: string): IndexedMessage | null {
    const rows = this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(
        `SELECT * FROM messages WHERE message_id = ? AND direction = 'out' LIMIT 1`,
        messageId,
      )
      .toArray();
    return rows.length > 0 ? (rows[0]! as IndexedMessage) : null;
  }

  /** Most recent outbound message to an address — a fallback when a DSN omits the Message-ID. */
  findLatestOutboundTo(recipient: string): IndexedMessage | null {
    // `recipient` comes from a bounce the sender wrote, so it can be anything.
    // Match exactly ("a@b" or "a@b +2"), never as a LIKE pattern: a pattern
    // with enough wildcards makes SQLite give up ("pattern too complex").
    const r = recipient.trim().toLowerCase();
    if (!r || r.length > 320) return null;
    const rows = this.ctx.storage.sql
      .exec<Row<IndexedMessage>>(
        `SELECT * FROM messages
          WHERE direction = 'out' AND (recipient = ? OR substr(recipient, 1, ?) = ?) AND delivery_status != 'bounced'
          ORDER BY received_at DESC LIMIT 1`,
        r,
        r.length + 2,
        `${r} +`,
      )
      .toArray();
    return rows.length > 0 ? (rows[0]! as IndexedMessage) : null;
  }

  async enqueue(payloadJson: string, messageId: string | null, delayMs: number): Promise<string> {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO outbox (id, message_id, payload_json, attempts, next_attempt_at, status, created_at)
       VALUES (?, ?, ?, 1, ?, 'queued', ?)`,
      id,
      messageId,
      payloadJson,
      Date.now() + delayMs,
      Date.now(),
    );
    await this.#wakeForOutbox(delayMs);
    return id;
  }

  dueOutbox(limit = 10): {
    id: string;
    message_id: string | null;
    payload_json: string;
    attempts: number;
  }[] {
    return this.ctx.storage.sql
      .exec<{ id: string; message_id: string | null; payload_json: string; attempts: number }>(
        `SELECT id, message_id, payload_json, attempts FROM outbox
          WHERE status = 'queued' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC LIMIT ?`,
        Date.now(),
        limit,
      )
      .toArray();
  }

  async rescheduleOutbox(
    id: string,
    delayMs: number,
    code: string,
    error: string,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_code = ?, last_error = ?
        WHERE id = ?`,
      Date.now() + delayMs,
      code,
      error.slice(0, 500),
      id,
    );
    await this.#wakeForOutbox(delayMs);
  }

  settleOutbox(id: string, status: "sent" | "failed", code?: string, error?: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE outbox SET status = ?, last_code = ?, last_error = ? WHERE id = ?`,
      status,
      code ?? null,
      error?.slice(0, 500) ?? null,
      id,
    );
  }

  /** Test hook: make every queued item due now, so backoff need not elapse. */
  makeOutboxDue(): number {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE outbox SET next_attempt_at = ? WHERE status = 'queued'`,
      Date.now(),
    );
    return cursor.rowsWritten;
  }

  outboxStats(): { queued: number; failed: number; nextAttemptAt: number | null } {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ queued: number; failed: number }>(
        `SELECT COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
           FROM outbox`,
      )
      .toArray()[0];
    const next = sql
      .exec<{ n: number | null }>(
        `SELECT MIN(next_attempt_at) AS n FROM outbox WHERE status = 'queued'`,
      )
      .toArray()[0]?.n;
    return { queued: row?.queued ?? 0, failed: row?.failed ?? 0, nextAttemptAt: next ?? null };
  }

  async #wakeForOutbox(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  suppress(address: string, reason: string, status: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO suppressions (address, reason, status, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET reason = excluded.reason, status = excluded.status`,
      address.toLowerCase(),
      reason,
      status,
      Date.now(),
    );
  }

  unsuppress(address: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM suppressions WHERE address = ?`, address.toLowerCase());
  }

  /** Returns the subset of the given addresses that must not be sent to. */
  suppressed(addresses: string[]): string[] {
    if (addresses.length === 0) return [];
    const found: string[] = [];
    for (const address of addresses) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT 1 FROM suppressions WHERE address = ? LIMIT 1`, address.toLowerCase())
        .toArray();
      if (rows.length > 0) found.push(address);
    }
    return found;
  }

  listSuppressions(): { address: string; reason: string; status: string | null }[] {
    return this.ctx.storage.sql
      .exec<{ address: string; reason: string; status: string | null }>(
        `SELECT address, reason, status FROM suppressions ORDER BY created_at DESC LIMIT 200`,
      )
      .toArray();
  }

  // ---- drafts ----------------------------------------------------------

  saveDraft(input: {
    id?: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string;
    threadId?: string | null;
    replyToId?: string | null;
    attachmentsJson?: string | null;
  }): Draft {
    const id = input.id ?? crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO drafts (id, "to", cc, bcc, subject, body, thread_id, reply_to_id,
                           attachments_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         "to" = excluded."to", cc = excluded.cc, bcc = excluded.bcc,
         subject = excluded.subject, body = excluded.body,
         thread_id = excluded.thread_id, reply_to_id = excluded.reply_to_id,
         -- Keep existing attachments when a save does not carry new ones, so
         -- editing the subject cannot silently drop uploaded files.
         attachments_json = COALESCE(excluded.attachments_json, drafts.attachments_json),
         updated_at = excluded.updated_at`,
      id,
      input.to,
      input.cc,
      input.bcc,
      input.subject,
      input.body,
      input.threadId ?? null,
      input.replyToId ?? null,
      input.attachmentsJson ?? null,
      Date.now(),
    );
    this.#emit({ t: "nav" });
    return this.getDraft(id)!;
  }

  listDrafts(limit = 50): Draft[] {
    return this.ctx.storage.sql
      .exec<Row<Draft>>(`SELECT * FROM drafts ORDER BY updated_at DESC LIMIT ?`, limit)
      .toArray();
  }

  getDraft(id: string): Draft | null {
    const rows = this.ctx.storage.sql
      .exec<Row<Draft>>(`SELECT * FROM drafts WHERE id = ?`, id)
      .toArray();
    return rows.length > 0 ? (rows[0]! as Draft) : null;
  }

  draftCount(): number {
    return (
      this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM drafts`).toArray()[0]?.n ??
      0
    );
  }

  /** Returns the R2 keys of any staged attachments so the caller can clean up. */
  deleteDraft(id: string): string[] {
    const draft = this.getDraft(id);
    if (!draft) return [];
    const keys: string[] = draft.attachments_json
      ? (JSON.parse(draft.attachments_json) as { r2_key: string }[]).map((a) => a.r2_key)
      : [];
    this.ctx.storage.sql.exec(`DELETE FROM drafts WHERE id = ?`, id);
    this.#emit({ t: "nav" });
    return keys;
  }

  // ---- legacy backfill -------------------------------------------------

  backfillPending(): boolean {
    return this.#meta("backfill_pending") === "1";
  }

  /**
   * Move pre-split messages into ThreadDOs and rebuild the index.
   *
   * Old thread ids were Message-ID strings, which are too long and not
   * address-safe for reply tags, so each legacy thread is reassigned a fresh
   * short id. Idempotent: legacy tables are dropped only once it succeeds.
   */
  async backfill(): Promise<{ migrated: number; threads: number }> {
    if (!this.backfillPending()) return { migrated: 0, threads: 0 };

    const sql = this.ctx.storage.sql;
    const address = this.#meta("address") ?? "";
    const legacy = sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM messages_legacy ORDER BY received_at ASC`,
      )
      .toArray();

    const threadIds = new Map<string, string>();
    let migrated = 0;

    for (const row of legacy) {
      const oldThread = String(row.thread_id);
      let threadId = threadIds.get(oldThread);
      if (!threadId) {
        threadId = newThreadId();
        threadIds.set(oldThread, threadId);
      }

      const id = String(row.id);
      const attachments = sql
        .exec<Row<ThreadAttachment>>(
          `SELECT * FROM attachments_legacy WHERE message_id = ?`,
          id,
        )
        .toArray()
        .map((a) => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          r2_key: a.r2_key,
          content_id: a.content_id ?? null,
        }));

      const stub = this.env.THREAD.get(this.env.THREAD.idFromName(`${address}|${threadId}`));
      await stub.append(
        { mailbox: address, threadId },
        {
          id,
          direction: row.direction === "out" ? "out" : "in",
          sender: String(row.sender),
          recipient: String(row.recipient),
          subject: String(row.subject),
          snippet: String(row.snippet),
          bodyText: row.body_text === null ? null : String(row.body_text),
          bodyHtml: row.body_html === null ? null : String(row.body_html),
          messageId: row.message_id === null ? null : String(row.message_id),
          inReplyTo: row.in_reply_to === null ? null : String(row.in_reply_to),
          references: row.refs === null ? null : String(row.refs),
          receivedAt: Number(row.received_at),
          size: Number(row.size),
          r2Prefix: row.r2_prefix === null ? null : String(row.r2_prefix),
          r2RawKey: row.r2_raw_key === null ? null : String(row.r2_raw_key),
          archived:
            row.archived_at === null
              ? undefined
              : {
                  bodyR2Key: row.body_r2_key === null ? null : String(row.body_r2_key),
                  archivedAt: Number(row.archived_at),
                },
          attachments,
        },
      );

      this.index({
        id,
        threadId,
        direction: row.direction === "out" ? "out" : "in",
        sender: String(row.sender),
        recipient: String(row.recipient),
        subject: String(row.subject),
        snippet: String(row.snippet),
        messageId: row.message_id === null ? null : String(row.message_id),
        receivedAt: Number(row.received_at),
        size: Number(row.size),
        attachmentCount: Number(row.attachment_count),
      });

      // Preserve read state, which index() derives from direction alone.
      sql.exec(`UPDATE messages SET read = ? WHERE id = ?`, Number(row.read), id);
      migrated += 1;
    }

    sql.exec(`DROP TABLE IF EXISTS messages_legacy`);
    sql.exec(`DROP TABLE IF EXISTS attachments_legacy`);
    sql.exec(`DELETE FROM meta WHERE k = 'backfill_pending'`);

    return { migrated, threads: threadIds.size };
  }
}

/**
 * Turn user input into a safe FTS5 MATCH expression.
 *
 * FTS5 treats bare input as query syntax, so an unescaped quote or a stray
 * `AND`/`NEAR` is a runtime error at best and operator injection at worst.
 * Every term is quoted; a trailing `*` is preserved as a prefix search.
 */
function buildMatchExpression(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_*@.-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term !== "*");

  if (terms.length === 0) return null;

  const expressions = terms
    .slice(0, 16)
    .map((term) => {
      const prefix = term.endsWith("*");
      const bare = (prefix ? term.slice(0, -1) : term).replace(/"/g, "");
      if (!bare) return null;
      return prefix ? `"${bare}"*` : `"${bare}"`;
    })
    .filter((term): term is string => term !== null);

  return expressions.length > 0 ? expressions.join(" AND ") : null;
}
