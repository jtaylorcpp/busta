import { DurableObject } from "cloudflare:workers";

/** The texting features (designs/2026-09-25-text-busta); each is off until opted into. */
export const TEXTING_FEATURES = ["notify", "subject", "links", "ask"] as const;
export type TextingFeature = (typeof TEXTING_FEATURES)[number];

/** A user's texting setup in this org. Never includes the PIN hash. */
export interface TextingView {
  userId: string;
  phone: string | null;
  verifiedAt: number | null;
  /** A number waiting for its Verify code. */
  pendingPhone: string | null;
  pendingSentAt: number | null;
  hasPin: boolean;
  features: Record<TextingFeature, boolean>;
  /** Folder keys (trimmed, lower-case names) whose filed mail texts. */
  folders: string[];
  /** Carrier at verification; a change means the number was ported. */
  carrier: string | null;
  /** Re-verify by this time (every 90 days). */
  reverifyBy: number | null;
  /** Why texting is paused (SIM or carrier change, overdue re-verification), if it is. */
  paused: string | null;
}

const NO_FEATURES: Record<TextingFeature, boolean> = { notify: false, subject: false, links: false, ask: false };
const REVERIFY_MS = 90 * 86_400_000;
/** Verify codes per user per day: stops SMS-pumping through our Verify service. */
const MAX_VERIFY_SENDS = 3;

export interface TenantMailbox {
  address: string;
  local_part: string;
  domain: string;
  label: string | null;
  created_at: number;
  /**
   * provisioning | ready | failed. A mailbox is latched — not enterable —
   * until it is ready, because an address whose routing rule does not exist
   * yet looks identical to a working one and silently receives nothing.
   */
  status: string;
  failure: string | null;
  /** busta (an address here) | gmail (a connected Gmail account). */
  kind: string;
  /** Account color name (see ACCOUNT_COLORS in web/src/lib/accounts.ts); null = by position. */
  color: string | null;
  /** 1 when the account is in the combined list, 0 when hidden from it. */
  shown: number;
}

/**
 * One Durable Object per tenant (Clerk organization). Holds the list of
 * mailboxes the org owns. Authorization still checks MailboxDO.ownerOrgId()
 * so a stale entry here can never grant access to someone else's mail.
 */
export class TenantDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        address    TEXT PRIMARY KEY,
        local_part TEXT NOT NULL,
        domain     TEXT NOT NULL,
        label      TEXT,
        created_at INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'ready',
        failure    TEXT
      );
    `);

    // Additive and idempotent, so it runs on every construction rather than
    // only on a version change — see the note on MailboxDO#migrate.
    for (const [column, type] of [
      ["status", "TEXT NOT NULL DEFAULT 'ready'"],
      ["failure", "TEXT"],
      ["kind", "TEXT NOT NULL DEFAULT 'busta'"],
      ["color", "TEXT"],
      ["shown", "INTEGER NOT NULL DEFAULT 1"],
    ] as const) {
      const present = ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM pragma_table_info('mailboxes') WHERE name = ?`,
          column,
        )
        .toArray()[0]?.n;
      if (!present) ctx.storage.sql.exec(`ALTER TABLE mailboxes ADD COLUMN ${column} ${type}`);
    }

    // Texting, one row per user (see TextingView).
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS texting (
        user_id         TEXT PRIMARY KEY,
        phone           TEXT,
        verified_at     INTEGER,
        pending_phone   TEXT,
        pending_sent_at INTEGER,
        sends_day       TEXT,
        sends_count     INTEGER NOT NULL DEFAULT 0,
        pin_hash        TEXT,
        features        TEXT NOT NULL DEFAULT '{}',
        folders         TEXT NOT NULL DEFAULT '[]',
        carrier         TEXT,
        paused          TEXT,
        updated_at      INTEGER NOT NULL
      );
    `);

    // Single-row key/value for tenant-level facts that are not mailboxes.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenant_flags (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Claim the right to run first-mailbox setup.
   *
   * The check and the write happen in one Durable Object turn, so two page
   * loads racing on a fresh sign-in cannot both start provisioning.
   *
   * A value of `running` is written immediately and replaced by the outcome.
   * An earlier version stored only a timestamp and treated any prior value as
   * "already handled"; that is read as unknown here and retried once, so a
   * tenant stranded by that version recovers on its next page load.
   */
  claimAutoProvision(): boolean {
    const prior = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM tenant_flags WHERE key = 'auto_provision'`)
      .toArray()[0]?.value;

    if (prior !== undefined) {
      // Only a well-formed outcome object counts as settled. Testing merely
      // that the value parses is not enough: the earlier version stored
      // `String(Date.now())`, and a bare number is perfectly valid JSON, so a
      // parse-only check silently classified every stranded tenant as
      // "already handled" and never retried them.
      let settled = false;
      try {
        const parsed = JSON.parse(prior) as unknown;
        settled =
          typeof parsed === "object" && parsed !== null && "state" in parsed;
      } catch {
        settled = false;
      }
      if (settled) return false;
    }

    // An org that already has addresses has answered this question by hand.
    if (this.listMailboxes().length > 0) return false;

    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_flags (key, value) VALUES ('auto_provision', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify({ state: "running", at: Date.now() }),
    );
    return true;
  }

  /**
   * Record how first-mailbox setup ended.
   *
   * `retryable` releases the claim entirely. The distinction matters: a Clerk
   * API hiccup should be retried on the next page load, while a username that
   * cannot become an address will never become one and must not be retried on
   * every request.
   */
  finishAutoProvision(outcome: { ok: boolean; reason?: string; retryable?: boolean }): void {
    if (outcome.retryable) {
      this.ctx.storage.sql.exec(`DELETE FROM tenant_flags WHERE key = 'auto_provision'`);
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_flags (key, value) VALUES ('auto_provision', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify({ state: outcome.ok ? "done" : "failed", reason: outcome.reason ?? null }),
    );
  }

  /**
   * Why this tenant has no mailbox, if setup already tried and failed.
   *
   * Without this the explanation appeared exactly once, on the request that
   * consumed the claim, and every load afterwards showed a bare "claim one
   * below" with no hint that anything had been attempted — which reads as the
   * app simply not doing what it promised.
   */
  autoProvisionFailure(): string | null {
    const raw = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM tenant_flags WHERE key = 'auto_provision'`)
      .toArray()[0]?.value;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { state?: string; reason?: string | null };
      return parsed.state === "failed" ? (parsed.reason ?? null) : null;
    } catch {
      return null;
    }
  }

  addMailbox(
    address: string,
    localPart: string,
    domain: string,
    label: string | null,
    status: string = "ready",
    kind: string = "busta",
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO mailboxes (address, local_part, domain, label, created_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET label = excluded.label, status = excluded.status, kind = excluded.kind`,
      address,
      localPart,
      domain,
      label,
      Date.now(),
      status,
      kind,
    );
  }

  /** Show or hide an account in the combined list. It keeps getting mail either way. */
  setShown(address: string, shown: boolean): void {
    this.ctx.storage.sql.exec(`UPDATE mailboxes SET shown = ? WHERE address = ?`, shown ? 1 : 0, address);
  }

  setColor(address: string, color: string | null): void {
    this.ctx.storage.sql.exec(`UPDATE mailboxes SET color = ? WHERE address = ?`, color, address);
  }

  setMailboxStatus(address: string, status: string, failure: string | null = null): void {
    this.ctx.storage.sql.exec(
      `UPDATE mailboxes SET status = ?, failure = ? WHERE address = ?`,
      status,
      failure,
      address,
    );
  }

  /** True while any mailbox is still being set up — drives the UI latch. */
  hasPending(): boolean {
    return (
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM mailboxes WHERE status = 'provisioning' LIMIT 1`)
        .toArray().length > 0
    );
  }

  listMailboxes(): TenantMailbox[] {
    return this.ctx.storage.sql
      .exec<TenantMailbox & Record<string, SqlStorageValue>>(`SELECT * FROM mailboxes ORDER BY created_at ASC`)
      .toArray();
  }

  hasMailbox(address: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM mailboxes WHERE address = ? LIMIT 1`, address)
        .toArray().length > 0
    );
  }

  removeMailbox(address: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM mailboxes WHERE address = ?`, address);
  }

  // ---- texting -----------------------------------------------------------

  #textingRow(userId: string) {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM texting WHERE user_id = ?`, userId)
      .toArray()[0] ?? null;
  }

  #ensureTexting(userId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO texting (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`,
      userId, Date.now(),
    );
  }

  texting(userId: string): TextingView {
    const r = this.#textingRow(userId);
    const features = { ...NO_FEATURES, ...(r ? (JSON.parse(String(r.features)) as Partial<Record<TextingFeature, boolean>>) : {}) };
    const verifiedAt = (r?.verified_at as number | null) ?? null;
    const reverifyBy = verifiedAt ? verifiedAt + REVERIFY_MS : null;
    const overdue = reverifyBy !== null && Date.now() > reverifyBy ? "Re-verify your phone: it's been 90 days." : null;
    return {
      userId,
      phone: (r?.phone as string | null) ?? null,
      verifiedAt,
      pendingPhone: (r?.pending_phone as string | null) ?? null,
      pendingSentAt: (r?.pending_sent_at as number | null) ?? null,
      hasPin: !!r?.pin_hash,
      features,
      folders: r ? (JSON.parse(String(r.folders)) as string[]) : [],
      carrier: (r?.carrier as string | null) ?? null,
      reverifyBy,
      paused: ((r?.paused as string | null) ?? null) || overdue,
    };
  }

  /** The stored PIN hash, for checking a PIN; never shown. */
  textingPinHash(userId: string): string | null {
    return (this.#textingRow(userId)?.pin_hash as string | null) ?? null;
  }

  /**
   * Record that a Verify code is going to `phone`. Refuses past
   * MAX_VERIFY_SENDS a day. Returns false when over the limit.
   */
  startPhoneVerify(userId: string, phone: string): boolean {
    this.#ensureTexting(userId);
    const r = this.#textingRow(userId)!;
    const today = new Date().toISOString().slice(0, 10);
    const count = r.sends_day === today ? Number(r.sends_count) : 0;
    if (count >= MAX_VERIFY_SENDS) return false;
    this.ctx.storage.sql.exec(
      `UPDATE texting SET pending_phone = ?, pending_sent_at = ?, sends_day = ?, sends_count = ?, updated_at = ? WHERE user_id = ?`,
      phone, Date.now(), today, count + 1, Date.now(), userId,
    );
    return true;
  }

  /**
   * The code checked out: this is the user's phone now. A new number starts
   * with every feature off (they were agreed for the old one) and no pause.
   * Returns the previous number, so its PhoneDO mapping can be released.
   */
  confirmPhone(userId: string, phone: string, carrier: string | null): string | null {
    this.#ensureTexting(userId);
    const prev = (this.#textingRow(userId)!.phone as string | null) ?? null;
    const changed = prev !== phone;
    this.ctx.storage.sql.exec(
      `UPDATE texting SET phone = ?, verified_at = ?, pending_phone = NULL, pending_sent_at = NULL, carrier = ?, paused = NULL,
              features = CASE WHEN ? THEN '{}' ELSE features END, updated_at = ? WHERE user_id = ?`,
      phone, Date.now(), carrier, changed ? 1 : 0, Date.now(), userId,
    );
    return changed ? prev : null;
  }

  setTextingPin(userId: string, pinHash: string): void {
    this.#ensureTexting(userId);
    this.ctx.storage.sql.exec(`UPDATE texting SET pin_hash = ?, updated_at = ? WHERE user_id = ?`, pinHash, Date.now(), userId);
  }

  setTextingFeature(userId: string, feature: TextingFeature, on: boolean): void {
    const v = this.texting(userId);
    const features = { ...v.features, [feature]: on };
    this.ctx.storage.sql.exec(`UPDATE texting SET features = ?, updated_at = ? WHERE user_id = ?`, JSON.stringify(features), Date.now(), userId);
  }

  setTextingFolders(userId: string, folders: string[]): void {
    this.#ensureTexting(userId);
    const keys = [...new Set(folders.map((f) => f.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))].slice(0, 50);
    this.ctx.storage.sql.exec(`UPDATE texting SET folders = ?, updated_at = ? WHERE user_id = ?`, JSON.stringify(keys), Date.now(), userId);
  }

  /** Pause texting (SIM or carrier change) until the user re-verifies on the web. */
  pauseTexting(userId: string, reason: string): void {
    this.ctx.storage.sql.exec(`UPDATE texting SET paused = ?, updated_at = ? WHERE user_id = ?`, reason, Date.now(), userId);
  }

  /** Remove the phone entirely: every feature off, PIN kept. Returns the number that was set. */
  removePhone(userId: string): string | null {
    const prev = (this.#textingRow(userId)?.phone as string | null) ?? null;
    this.ctx.storage.sql.exec(
      `UPDATE texting SET phone = NULL, verified_at = NULL, pending_phone = NULL, carrier = NULL, paused = NULL, features = '{}', updated_at = ? WHERE user_id = ?`,
      Date.now(), userId,
    );
    return prev;
  }

  /** Users in this org who get texts for mail filed into `folderKey`. */
  textingForFolder(folderKey: string): TextingView[] {
    const users = this.ctx.storage.sql.exec<{ user_id: string }>(`SELECT user_id FROM texting WHERE phone IS NOT NULL`).toArray();
    return users.map((u) => this.texting(u.user_id)).filter((v) => v.features.notify && !v.paused && v.folders.includes(folderKey));
  }
}
