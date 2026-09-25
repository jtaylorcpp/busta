import { DurableObject } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { classifyEmail, type ClassifyResult, type EmailForClassify } from "./classify";
import { explainFolder, ruleHash, type Explanation } from "./explain";

export type Direction = "in" | "out";

type Row<T> = T & Record<string, SqlStorageValue>;

export interface ThreadMessage {
  id: string;
  direction: Direction;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  received_at: number;
  size: number;
  r2_prefix: string | null;
  r2_raw_key: string | null;
  body_r2_key: string | null;
  archived_at: number | null;
  attachment_count: number;
  /** JSON: to/cc/replyTo lists plus selected headers. */
  envelope_json: string | null;
}

export interface ThreadAttachment {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  size: number;
  r2_key: string;
  /** MIME Content-ID, for resolving `cid:` references in HTML bodies. */
  content_id: string | null;
}

export interface AppendInput {
  id: string;
  direction: Direction;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  receivedAt: number;
  size: number;
  r2Prefix: string | null;
  r2RawKey: string | null;
  /** Full recipient lists and headers — bulky, so kept off the mailbox index. */
  envelope?: unknown;
  /** Carried over when migrating a message that was already tiered to R2. */
  archived?: { bodyR2Key: string | null; archivedAt: number };
  attachments?: Omit<ThreadAttachment, "message_id">[];
}

export type BodySource = "hot" | "archive" | "raw";

export interface MessageView {
  message: ThreadMessage;
  attachments: ThreadAttachment[];
  bodySource: BodySource;
}

const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const SWEEP_CONTINUE_MS = 60_000;
const SWEEP_BATCH = 200;
/** Ceiling for one Durable Object. */
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
/** Start shedding bodies at this fraction of the limit. */
const DEFAULT_HIGH_WATERMARK = 0.85;
/** Stop shedding once back under this fraction. */
const DEFAULT_LOW_WATERMARK = 0.7;
/** Bodies archived in a single relief run before yielding. */
const RELIEF_BUDGET = 2_000;

/**
 * One Durable Object per conversation, keyed `{mailbox}|{threadId}`.
 *
 * This is the unit an agent reasons over: the full message record, its own
 * storage, its own alarm, and a slot for agent state. The mailbox index knows
 * a thread exists and can list it; everything that requires reading or acting
 * on the actual conversation happens here.
 *
 * Bodies are hot in SQLite while recent and tier out to R2 on the alarm;
 * reads hydrate them back. Attachment content is always in R2.
 */
export class ThreadDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#migrate();
  }

  #migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    // Attachment text for Ask by text, converted once (toMarkdown) and kept.
    sql.exec(`CREATE TABLE IF NOT EXISTS attachment_text (attachment_id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    // "Why not this folder?" answers, kept until the folder's rule changes.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS explanations (
        message_id TEXT NOT NULL,
        folder_id  TEXT NOT NULL,
        rule_hash  TEXT NOT NULL,
        json       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, folder_id)
      );
    `);

    // Additive and idempotent, so it runs every construction rather than only
    // on a version change — see the note on MailboxDO#migrate.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        direction        TEXT NOT NULL,
        sender           TEXT NOT NULL,
        recipient        TEXT NOT NULL,
        subject          TEXT NOT NULL,
        snippet          TEXT NOT NULL,
        body_text        TEXT,
        body_html        TEXT,
        message_id       TEXT,
        in_reply_to      TEXT,
        refs             TEXT,
        received_at      INTEGER NOT NULL,
        size             INTEGER NOT NULL DEFAULT 0,
        r2_prefix        TEXT,
        r2_raw_key       TEXT,
        body_r2_key      TEXT,
        archived_at      INTEGER,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        envelope_json    TEXT
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_thread_received ON messages(received_at);`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_thread_sweep ON messages(archived_at, received_at);`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id         TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        filename   TEXT NOT NULL,
        mime_type  TEXT,
        size       INTEGER NOT NULL,
        r2_key     TEXT NOT NULL,
        content_id TEXT
      );
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_thread_att ON attachments(message_id);`);

    this.#addColumn("attachments", "content_id", "TEXT");
    this.#addColumn("messages", "envelope_json", "TEXT");

    if (Number(this.#meta("schema_version") ?? 0) !== SCHEMA_VERSION) {
      this.#setMeta("schema_version", String(SCHEMA_VERSION));
    }
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

  // ---- conversation ----------------------------------------------------

  /**
   * Add a message. Upserts on the caller-supplied id so a redelivered message
   * (Email Routing retries) overwrites rather than duplicating.
   */
  async append(
    identity: { mailbox: string; threadId: string },
    input: AppendInput,
  ): Promise<{ id: string; messageCount: number }> {
    const sql = this.ctx.storage.sql;

    if (this.#meta("mailbox") === null) {
      this.#setMeta("mailbox", identity.mailbox);
      this.#setMeta("thread_id", identity.threadId);
      this.#setMeta("subject", input.subject);
      this.#setMeta("created_at", String(Date.now()));
    }

    sql.exec(
      `INSERT INTO messages
        (id, direction, sender, recipient, subject, snippet, body_text, body_html,
         message_id, in_reply_to, refs, received_at, size,
         r2_prefix, r2_raw_key, body_r2_key, archived_at, attachment_count, envelope_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         body_text = excluded.body_text,
         body_html = excluded.body_html,
         snippet   = excluded.snippet,
         size      = excluded.size`,
      input.id,
      input.direction,
      input.sender,
      input.recipient,
      input.subject,
      input.snippet,
      input.bodyText,
      input.bodyHtml,
      input.messageId,
      input.inReplyTo,
      input.references,
      input.receivedAt,
      input.size,
      input.r2Prefix,
      input.r2RawKey,
      input.archived?.bodyR2Key ?? null,
      input.archived?.archivedAt ?? null,
      (input.attachments ?? []).length,
      input.envelope === undefined ? null : JSON.stringify(input.envelope),
    );

    for (const att of input.attachments ?? []) {
      sql.exec(
        `INSERT INTO attachments (id, message_id, filename, mime_type, size, r2_key, content_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        att.id,
        input.id,
        att.filename,
        att.mime_type,
        att.size,
        att.r2_key,
        att.content_id ?? null,
      );
    }

    this.#setMeta("last_message_at", String(input.receivedAt));
    await this.#ensureAlarm();
    return { id: input.id, messageCount: this.count() };
  }

  /** Append many messages in one call. Used by bulk ingest and capacity tests. */
  async bulkAppend(
    identity: { mailbox: string; threadId: string },
    inputs: AppendInput[],
  ): Promise<number> {
    for (const input of inputs) await this.append(identity, input);
    return inputs.length;
  }

  /**
   * Ask SQLite to return freed pages to the filesystem.
   *
   * Nulling a column marks its pages free but does not shrink the database —
   * those pages are reused by later writes instead. Whether an explicit
   * reclaim is even available here is runtime-dependent, so this reports what
   * happened rather than assuming.
   */
  reclaim(): { before: number; after: number; method: string; error?: string } {
    const sql = this.ctx.storage.sql;
    const before = sql.databaseSize;
    for (const method of ["PRAGMA incremental_vacuum", "VACUUM"]) {
      try {
        sql.exec(method);
        return { before, after: sql.databaseSize, method };
      } catch (err) {
        if (method === "VACUUM") {
          return {
            before,
            after: sql.databaseSize,
            method: "none",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
    return { before, after: sql.databaseSize, method: "none" };
  }

  databaseSize(): number {
    return this.ctx.storage.sql.databaseSize;
  }

  count(): number {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)
        .toArray()[0]?.n ?? 0
    );
  }

  /** The whole conversation, oldest first. Bodies stay as stored. */
  list(): ThreadMessage[] {
    return this.ctx.storage.sql
      .exec<Row<ThreadMessage>>(`SELECT * FROM messages ORDER BY received_at ASC`)
      .toArray();
  }

  /** A stored message as the folder models read it: headers and plain text. */
  async #emailFor(id: string): Promise<EmailForClassify> {
    const view = await this.get(id);
    if (!view) throw new Error(`message ${id} not found`);
    const m = view.message;
    const envelope = m.envelope_json ? (JSON.parse(m.envelope_json) as Record<string, unknown>) : {};
    const addrs = (list: unknown) =>
      Array.isArray(list)
        ? list.map((a) => (typeof a === "string" ? a : (a as { address?: string })?.address ?? "")).filter(Boolean)
        : [];
    const text = m.body_text ?? (m.body_html ? m.body_html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ") : "");
    return {
      from: m.sender,
      to: addrs(envelope.to).join(", ") || m.recipient,
      cc: addrs(envelope.cc).join(", "),
      subject: m.subject,
      body: text,
    };
  }

  /**
   * Ask Workers AI which of the given folders a message belongs in.
   *
   * Runs here, beside the message, so the body never has to be shipped to the
   * caller. Uses typesafe/jev's `choice` question: each folder's plain-English
   * rule is the description of its option, plus a "none" option. Returns the
   * chosen folder id (null for none), its probability, and the probability of
   * every option so the UI can show a match percentage.
   */
  /**
   * How likely this message helps answer `question` (Ask by text), scored by
   * jev with the question as the one "folder rule". Cheap: the body stays here.
   */
  async relevance(id: string, question: string): Promise<number> {
    const r = await classifyEmail(this.env, await this.#emailFor(id), [
      { id: "q", name: "Answers the question", rule: `Emails that help answer this question: ${question}` },
    ]);
    return r.probabilities.q ?? (r.folderId === "q" ? r.probability : 0);
  }

  /**
   * A message as the answer model reads it: headers, body text, and text
   * pulled from its PDFs, images and documents (converted once, then kept).
   */
  async readForAnswer(id: string, maxChars = 6000): Promise<{ from: string; subject: string; date: number; body: string; attachments: { name: string; kind: "pdf" | "image" | "doc"; text: string }[] } | null> {
    const view = await this.get(id);
    if (!view) return null;
    const email = await this.#emailFor(id);
    const attachments: { name: string; kind: "pdf" | "image" | "doc"; text: string }[] = [];
    for (const a of view.attachments.slice(0, 3)) {
      const mime = (a.mime_type ?? "").toLowerCase();
      const kind = mime.includes("pdf") ? "pdf" : mime.startsWith("image/") ? "image" : /word|officedocument|opendocument|text\/(plain|csv|html)/.test(mime) ? "doc" : null;
      if (!kind || a.size > 5_000_000) continue;
      const cached = this.ctx.storage.sql.exec<{ text: string }>(`SELECT text FROM attachment_text WHERE attachment_id = ?`, a.id).toArray()[0];
      let text = cached?.text ?? null;
      if (text === null) {
        const object = await this.env.MAIL_ARCHIVE.get(a.r2_key);
        if (!object) continue;
        try {
          const blob = new Blob([await object.arrayBuffer()], { type: mime || "application/octet-stream" });
          const out = (await this.env.AI.toMarkdown({ name: a.filename, blob })) as { data?: string };
          text = (out.data ?? "").slice(0, 8000);
        } catch (e) {
          console.error("toMarkdown failed", a.id, String(e).slice(0, 120));
          text = "";
        }
        this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO attachment_text (attachment_id, text, created_at) VALUES (?, ?, ?)`, a.id, text, Date.now());
      }
      if (text) attachments.push({ name: a.filename, kind, text: text.slice(0, 3000) });
    }
    return { from: email.from, subject: email.subject, date: view.message.received_at, body: email.body.replace(/\s+\n/g, "\n").slice(0, maxChars), attachments };
  }

  async classify(id: string, folders: { id: string; name: string; rule: string }[]): Promise<ClassifyResult> {
    return classifyEmail(this.env, await this.#emailFor(id), folders);
  }

  /**
   * Why this message didn't land in a folder, in words, plus the part of the
   * email it was judged on. Cached per message and folder until the rule
   * changes; `fresh` asks again anyway.
   */
  async explain(
    id: string,
    mailbox: string,
    folder: { id: string; name: string; rule: string },
    score: number | null,
    fresh = false,
  ): Promise<{ explanation: Explanation; email: { from: string; subject: string; text: string } }> {
    const email = await this.#emailFor(id);
    const excerpt = { from: email.from, subject: email.subject, text: email.body.replace(/\s+/g, " ").trim().slice(0, 700) };
    const sql = this.ctx.storage.sql;
    const hash = ruleHash(folder.rule);
    if (!fresh) {
      const hit = sql
        .exec<{ json: string }>(`SELECT json FROM explanations WHERE message_id = ? AND folder_id = ? AND rule_hash = ?`, id, folder.id, hash)
        .toArray()[0];
      if (hit) return { explanation: JSON.parse(hit.json) as Explanation, email: excerpt };
    }
    const explanation = await explainFolder(this.env, { ...email, mailbox }, folder, score);
    sql.exec(
      `INSERT INTO explanations (message_id, folder_id, rule_hash, json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, folder_id) DO UPDATE SET rule_hash = excluded.rule_hash, json = excluded.json, created_at = excluded.created_at`,
      id, folder.id, hash, JSON.stringify(explanation), Date.now(),
    );
    return { explanation, email: excerpt };
  }

  async get(id: string): Promise<MessageView | null> {
    const rows = this.ctx.storage.sql
      .exec<Row<ThreadMessage>>(`SELECT * FROM messages WHERE id = ?`, id)
      .toArray();
    if (rows.length === 0) return null;

    const message = rows[0]! as ThreadMessage;
    const attachments = this.ctx.storage.sql
      .exec<Row<ThreadAttachment>>(`SELECT * FROM attachments WHERE message_id = ?`, id)
      .toArray() as ThreadAttachment[];

    const bodySource = message.archived_at === null ? "hot" : await this.#hydrate(message);
    return { message, attachments, bodySource };
  }

  /**
   * Restore an archived body. Prefers the compact body.json written by the
   * sweep; falls back to re-parsing the raw MIME, which is the real system of
   * record and survives even if the derived body object is lost.
   */
  async #hydrate(message: ThreadMessage): Promise<BodySource> {
    if (message.body_r2_key) {
      const object = await this.env.MAIL_ARCHIVE.get(message.body_r2_key);
      if (object) {
        const body = (await object.json()) as { text: string | null; html: string | null };
        message.body_text = body.text;
        message.body_html = body.html;
        return "archive";
      }
    }

    if (message.r2_raw_key) {
      const object = await this.env.MAIL_ARCHIVE.get(message.r2_raw_key);
      if (object) {
        const parsed = await PostalMime.parse(await object.arrayBuffer());
        message.body_text = parsed.text ?? null;
        message.body_html = parsed.html ?? null;
        return "raw";
      }
    }

    return "archive";
  }

  /** R2 keys the caller should delete, so R2 never orphans blobs. */
  remove(id: string): string[] {
    const sql = this.ctx.storage.sql;
    const keys: string[] = [];

    const msg = sql
      .exec<{ r2_raw_key: string | null; body_r2_key: string | null }>(
        `SELECT r2_raw_key, body_r2_key FROM messages WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!msg) return keys;
    if (msg.r2_raw_key) keys.push(msg.r2_raw_key);
    if (msg.body_r2_key) keys.push(msg.body_r2_key);

    for (const att of sql
      .exec<{ r2_key: string }>(`SELECT r2_key FROM attachments WHERE message_id = ?`, id)
      .toArray()) {
      keys.push(att.r2_key);
    }

    sql.exec(`DELETE FROM attachments WHERE message_id = ?`, id);
    sql.exec(`DELETE FROM messages WHERE id = ?`, id);
    return keys;
  }

  // ---- agent seam ------------------------------------------------------

  /**
   * Opaque per-thread state for future agent work (draft replies, tool state,
   * approval status). Stored here because the thread is the unit an agent
   * reasons over, and it already owns an alarm for scheduled follow-ups.
   */
  agentState(): unknown {
    const raw = this.#meta("agent_state");
    return raw === null ? null : JSON.parse(raw);
  }

  setAgentState(state: unknown): void {
    this.#setMeta("agent_state", JSON.stringify(state));
  }

  /** Schedule agent work on this conversation. Coexists with the tiering sweep. */
  async scheduleFollowUp(at: number, reason: string): Promise<void> {
    this.#setMeta("follow_up_at", String(at));
    this.#setMeta("follow_up_reason", reason);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  // ---- tiering ---------------------------------------------------------

  #highWatermarkBytes(): number {
    return STORAGE_LIMIT_BYTES * fraction(this.env.STORAGE_HIGH_WATERMARK, DEFAULT_HIGH_WATERMARK);
  }

  #lowWatermarkBytes(): number {
    return STORAGE_LIMIT_BYTES * fraction(this.env.STORAGE_LOW_WATERMARK, DEFAULT_LOW_WATERMARK);
  }

  /**
   * Bodies stay hot until storage actually demands otherwise.
   *
   * Nothing is scheduled while the object is comfortably under the high
   * watermark — a periodic sweep across millions of idle conversations would
   * be pure cost for objects that will never come close to 10 GB. Pressure is
   * checked on write, which is the only time the size can grow.
   *
   * An explicit age policy (ARCHIVE_AFTER_DAYS > 0) opts back into a daily
   * alarm for retention rules that are not about capacity.
   */
  async #ensureAlarm(): Promise<void> {
    const ageDays = Number(this.env.ARCHIVE_AFTER_DAYS ?? 0);
    const wantsAgePolicy = Number.isFinite(ageDays) && ageDays > 0;
    const underPressure = this.ctx.storage.sql.databaseSize >= this.#highWatermarkBytes();

    if (!wantsAgePolicy && !underPressure) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;

    // Under pressure, drain promptly; otherwise wake on the retention cadence.
    await this.ctx.storage.setAlarm(Date.now() + (underPressure ? 1_000 : DAY_MS));
  }

  async sweepSchedule(): Promise<{
    nextAlarmAt: number | null;
    lastSweepAt: number | null;
    lastReliefAt: number | null;
  }> {
    const last = this.#meta("last_sweep_at");
    const relief = this.#meta("last_relief_at");
    return {
      nextAlarmAt: await this.ctx.storage.getAlarm(),
      lastSweepAt: last === null ? null : Number(last),
      lastReliefAt: relief === null ? null : Number(relief),
    };
  }

  async alarm(): Promise<void> {
    const due = this.#meta("follow_up_at");
    if (due !== null && Number(due) <= Date.now()) {
      // Agent hook: scheduled work on this conversation lands here.
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k IN ('follow_up_at','follow_up_reason')`);
    }

    const relief = await this.relieve();

    const ageDays = Number(this.env.ARCHIVE_AFTER_DAYS ?? 0);
    if (Number.isFinite(ageDays) && ageDays > 0) {
      await this.sweep(Date.now() - ageDays * DAY_MS);
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
      return;
    }

    // Still over the line and there was more to shed — come back and continue.
    if (!relief.settled && relief.archived > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_CONTINUE_MS);
    }
  }

  /** Current storage position relative to the watermarks. */
  pressure(): {
    databaseSize: number;
    highWatermark: number;
    lowWatermark: number;
    limit: number;
    overHigh: boolean;
    usedFraction: number;
  } {
    const size = this.ctx.storage.sql.databaseSize;
    const high = this.#highWatermarkBytes();
    return {
      databaseSize: size,
      highWatermark: high,
      lowWatermark: this.#lowWatermarkBytes(),
      limit: STORAGE_LIMIT_BYTES,
      overHigh: size >= high,
      usedFraction: size / STORAGE_LIMIT_BYTES,
    };
  }

  /**
   * Shed the oldest bodies to R2 until storage is back under the low
   * watermark. A no-op unless the object is over the high watermark, so the
   * common case costs one integer read.
   */
  async relieve(): Promise<{
    archived: number;
    bytes: number;
    sizeBefore: number;
    sizeAfter: number;
    /** No further relief needed right now — storage is in an acceptable state. */
    settled: boolean;
  }> {
    const sql = this.ctx.storage.sql;
    const sizeBefore = sql.databaseSize;

    if (sizeBefore < this.#highWatermarkBytes()) {
      return { archived: 0, bytes: 0, sizeBefore, sizeAfter: sizeBefore, settled: true };
    }

    const low = this.#lowWatermarkBytes();

    // Freed pages are not reflected in databaseSize until the transaction
    // commits, so re-reading it inside the loop always looks like no progress
    // and sheds everything. Size the run up front from the average hot body
    // instead, then let the next alarm re-check against the committed size.
    const averageHotBody =
      sql
        .exec<{ avg: number | null }>(
          `SELECT AVG(LENGTH(COALESCE(body_text, '')) + LENGTH(COALESCE(body_html, ''))) AS avg
             FROM messages WHERE archived_at IS NULL`,
        )
        .toArray()[0]?.avg ?? 0;

    // Slack covers per-row overhead the average misses; the floor stops a
    // mailbox of tiny bodies from computing an unbounded target.
    const perMessage = Math.max(averageHotBody * 1.1, 256);
    const target = Math.min(RELIEF_BUDGET, Math.ceil((sizeBefore - low) / perMessage));

    let archived = 0;
    let bytes = 0;

    while (archived < target) {
      // Oldest first: the least likely to be read, and archiving is reversible.
      const batch = await this.sweep(Number.MAX_SAFE_INTEGER, Math.min(SWEEP_BATCH, target - archived));
      if (batch.archived === 0) break; // nothing hot left to shed
      archived += batch.archived;
      bytes += batch.bytes;
    }

    const sizeAfter = sql.databaseSize;
    this.#setMeta("last_relief_at", String(Date.now()));
    return { archived, bytes, sizeBefore, sizeAfter, settled: sizeAfter <= low };
  }

  /**
   * Move bodies older than `cutoff` into R2 and clear them from SQLite.
   * Measured: freed pages are returned to the file, so this genuinely reduces
   * `databaseSize` rather than only stopping its growth.
   *
   * Not wrapped in blockConcurrencyWhile: a concurrent read either sees the
   * hot body or the archived one, both correct. A crash between the R2 put and
   * the SQL update leaves an orphan the next sweep overwrites at the same key.
   */
  async sweep(cutoff: number, limit = SWEEP_BATCH): Promise<{ archived: number; bytes: number }> {
    const sql = this.ctx.storage.sql;
    const candidates = sql
      .exec<{
        id: string;
        r2_prefix: string | null;
        body_text: string | null;
        body_html: string | null;
      }>(
        `SELECT id, r2_prefix, body_text, body_html
           FROM messages
          WHERE archived_at IS NULL AND received_at < ? AND r2_prefix IS NOT NULL
          ORDER BY received_at ASC
          LIMIT ?`,
        cutoff,
        limit,
      )
      .toArray();

    let archived = 0;
    let bytes = 0;

    for (const row of candidates) {
      const payload = JSON.stringify({ text: row.body_text, html: row.body_html });
      const key = `${row.r2_prefix}/body.json`;

      await this.env.MAIL_ARCHIVE.put(key, payload, {
        httpMetadata: { contentType: "application/json" },
      });
      sql.exec(
        `UPDATE messages
            SET body_text = NULL, body_html = NULL, body_r2_key = ?, archived_at = ?
          WHERE id = ?`,
        key,
        Date.now(),
        row.id,
      );

      archived += 1;
      bytes += payload.length;
    }

    if (archived > 0) this.#setMeta("last_sweep_at", String(Date.now()));
    return { archived, bytes };
  }
}

/** Clamp a configured watermark to a sane fraction, falling back on garbage. */
function fraction(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}
