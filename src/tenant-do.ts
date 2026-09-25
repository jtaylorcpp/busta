import { DurableObject } from "cloudflare:workers";

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
}
