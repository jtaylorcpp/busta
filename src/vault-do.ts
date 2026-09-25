import { DurableObject } from "cloudflare:workers";
import * as gmail from "./sources/gmail";
import { GmailError } from "./sources/gmail";
import { GoogleAuthError, refreshAccess, revoke } from "./sources/google";
import type { VaultResult } from "./sources/vault";

/**
 * The only place a connected Gmail account's Google tokens live, one object
 * per account. It stores the refresh token, keeps a short-lived access token
 * in memory, and makes every Gmail call itself. There is deliberately no
 * method that returns a token: the rest of Busta (live sync, the import
 * queue, sending) can ask it to act, never walk off with the credential, so a
 * token can't end up in a log, an error or a response.
 *
 * Results come back as VaultResult rather than thrown errors, because RPC
 * keeps an error's message but not its status; src/sources/vault.ts turns
 * them back into GmailError for callers.
 */
export class GmailVaultDO extends DurableObject<Env> {
  #access: { token: string; expiresAt: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS vault (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  }

  #get(k: string): string | null {
    return this.ctx.storage.sql.exec<{ v: string }>(`SELECT v FROM vault WHERE k = ?`, k).toArray()[0]?.v ?? null;
  }

  /** Write-only: keep the refresh token Google issued at sign-in. */
  store(input: { account: string; refreshToken: string }): void {
    for (const [k, v] of [["account", input.account], ["refresh", input.refreshToken]] as const) {
      this.ctx.storage.sql.exec(`INSERT INTO vault (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
    }
    this.#access = null;
  }

  /** Is there a credential here? (Says nothing about it.) */
  holds(): boolean {
    return this.#get("refresh") !== null;
  }

  /** Ask Google to drop Busta's access, then forget everything. True if Google confirmed. */
  async revoke(): Promise<boolean> {
    const refresh = this.#get("refresh");
    const ok = refresh ? await revoke(refresh).catch(() => false) : true;
    this.#access = null;
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS vault (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    return ok;
  }

  #token: gmail.TokenSource = async () => {
    if (this.#access && this.#access.expiresAt - Date.now() > 60_000) return this.#access.token;
    const refresh = this.#get("refresh");
    if (!refresh) throw new GoogleAuthError("Gmail isn't connected", "not_connected");
    const fresh = await refreshAccess(this.env, refresh);
    this.#access = { token: fresh.accessToken, expiresAt: fresh.expiresAt };
    return fresh.accessToken;
  };

  async #run<T>(fn: (t: gmail.TokenSource) => Promise<T>): Promise<VaultResult<T>> {
    try {
      return { ok: true, value: await fn(this.#token) };
    } catch (e) {
      if (e instanceof GmailError) {
        if (e.status === 401) this.#access = null;
        return { ok: false, status: e.status, reason: e.reason, message: e.message };
      }
      if (e instanceof GoogleAuthError) {
        // invalid_grant / not_connected: the user has to reconnect.
        return { ok: false, status: 401, reason: e.code, message: e.message };
      }
      return { ok: false, status: 500, reason: null, message: e instanceof Error ? e.message : String(e) };
    }
  }

  profile() { return this.#run((t) => gmail.profile(t)); }
  watch(topic: string) { return this.#run((t) => gmail.watch(t, topic)); }
  stopWatch() { return this.#run((t) => gmail.stopWatch(t)); }
  listMessages(q: string, pageToken?: string) { return this.#run((t) => gmail.listMessages(t, q, pageToken)); }
  getRaw(id: string) { return this.#run((t) => gmail.getRaw(t, id)); }
  getHeaders(id: string, names: string[]) { return this.#run((t) => gmail.getHeaders(t, id, names)); }
  listHistory(startHistoryId: string, pageToken?: string) { return this.#run((t) => gmail.listHistory(t, startHistoryId, pageToken)); }
  modify(id: string, add: string[], remove: string[]) { return this.#run((t) => gmail.modify(t, id, add, remove)); }
  trash(id: string) { return this.#run((t) => gmail.trash(t, id)); }
  untrash(id: string) { return this.#run((t) => gmail.untrash(t, id)); }
  sendRaw(raw: Uint8Array, threadId?: string | null) { return this.#run((t) => gmail.sendRaw(t, raw, threadId)); }
}
