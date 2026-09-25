/**
 * The Gmail API as the rest of Busta sees it: every call goes to the
 * account's GmailVaultDO (src/vault-do.ts), which holds the tokens and makes
 * the request. Nothing here ever has a token. Failures come back as
 * GmailError with Google's status, so callers can tell "try later" from
 * "reconnect".
 */
import { normalizeAddress } from "../addressing";
import { GmailError, type HistoryRecord, type RawMessage } from "./gmail";

export type VaultResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string | null; message: string };

export function vaultStub(env: Env, account: string) {
  return env.VAULT.get(env.VAULT.idFromName(normalizeAddress(account)));
}

function unwrap<T>(r: VaultResult<T>): T {
  if (r.ok) return r.value;
  throw new GmailError(r.message, r.status, r.reason);
}

/** A Gmail client for one account. Holds a stub, not a credential. */
export function gmailFor(env: Env, account: string) {
  const v = vaultStub(env, account);
  return {
    profile: async () => unwrap(await v.profile()) as { emailAddress: string; historyId: string; messagesTotal: number },
    watch: async (topic: string) => unwrap(await v.watch(topic)) as { historyId: string; expiration: string },
    stopWatch: async () => { unwrap(await v.stopWatch()); },
    listMessages: async (q: string, pageToken?: string) =>
      unwrap(await v.listMessages(q, pageToken)) as { messages?: { id: string; threadId: string }[]; nextPageToken?: string },
    getRaw: async (id: string) => unwrap(await v.getRaw(id)) as RawMessage,
    getHeaders: async (id: string, names: string[]) =>
      unwrap(await v.getHeaders(id, names)) as { id: string; threadId: string; payload?: { headers?: { name: string; value: string }[] } },
    listHistory: async (start: string, pageToken?: string) =>
      unwrap(await v.listHistory(start, pageToken)) as { history?: HistoryRecord[]; historyId: string; nextPageToken?: string },
    modify: async (id: string, add: string[], remove: string[]) => { unwrap(await v.modify(id, add, remove)); },
    trash: async (id: string) => { unwrap(await v.trash(id)); },
    untrash: async (id: string) => { unwrap(await v.untrash(id)); },
    sendRaw: async (raw: Uint8Array, threadId?: string | null) =>
      unwrap(await v.sendRaw(raw, threadId)) as { id: string; threadId: string },
  };
}

export type GmailApi = ReturnType<typeof gmailFor>;
