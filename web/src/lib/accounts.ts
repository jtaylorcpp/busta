/**
 * Several accounts shown as one mailbox (designs/2026-09-24-connect-gmail).
 *
 * Every account is its own MailboxDO, isolated from the others: its own mail,
 * folders and filing. Nothing is copied between them. The combined views are
 * built at read time: ask each shown account, then merge the answers. The
 * list interleaves by time; folders merge by name (trimmed, case-insensitive)
 * with their counts added.
 */
import { tenantStub } from "../../../src/mail";
import type { TenantMailbox } from "../../../src/tenant-do";
import type { FolderWithCounts, IndexedMessage } from "../../../src/mailbox-do";
import { INBOX_PAGE_SIZE, loadNav, openMailbox, type MailboxStub, type Session } from "./mail-data";

/** Account colors, in the order new accounts get them. Tokens: --acct-<name>. */
export const ACCOUNT_COLORS = ["blue", "teal", "slate", "sand"] as const;
export type AccountColor = (typeof ACCOUNT_COLORS)[number];

export interface Account {
  address: string;
  kind: "busta" | "gmail";
  color: AccountColor;
  shown: boolean;
  label: string | null;
}

export interface OpenAccount extends Account {
  stub: MailboxStub;
}

/** Short name for an account: its domain, or the whole address when two share a domain. */
export function shortName(a: { address: string }, all: { address: string }[]): string {
  const domain = a.address.split("@")[1] ?? a.address;
  return all.filter((x) => x.address.split("@")[1] === domain).length > 1 ? a.address : domain;
}

/** Where the combined views live. */
export const ALL = "/mail";

/** The org's ready accounts, oldest first, each with its color. */
export async function listAccounts(env: Env, orgId: string): Promise<Account[]> {
  const rows = ((await tenantStub(env, orgId).listMailboxes()) as TenantMailbox[]).filter((m) => m.status === "ready");
  return rows.map((m, i) => ({
    address: m.address,
    kind: m.kind === "gmail" ? "gmail" : "busta",
    color: (ACCOUNT_COLORS as readonly string[]).includes(m.color ?? "") ? (m.color as AccountColor) : ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]!,
    shown: m.shown !== 0,
    label: m.label,
  }));
}

/**
 * The shown accounts, each authorized the same way a single mailbox page is
 * (the MailboxDO must say this org owns it), so a stale tenant row can never
 * surface someone else's mail.
 */
export async function openShown(env: Env, session: Session, accounts: Account[]): Promise<OpenAccount[]> {
  const shown = accounts.filter((a) => a.shown);
  const opened = await Promise.all(shown.map(async (a) => {
    const access = await openMailbox(env, session, a.address);
    return access.ok ? { ...a, stub: access.stub } : null;
  }));
  return opened.filter((a): a is OpenAccount => a !== null);
}

/** "Must read", " must  READ " → one key. */
export const folderKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export interface MergedFolder {
  key: string;
  name: string;
  total: number;
  unread: number;
  /** The folder in each account that has it. */
  parts: { address: string; color: AccountColor; id: string; rule: string }[];
}

/** Folders from every shown account, merged by name, in first-seen order. */
export function mergeFolders(per: { account: Account; folders: FolderWithCounts[] }[]): MergedFolder[] {
  const byKey = new Map<string, MergedFolder>();
  for (const { account, folders } of per) {
    for (const f of folders) {
      const key = folderKey(f.name);
      let m = byKey.get(key);
      if (!m) byKey.set(key, (m = { key, name: f.name, total: 0, unread: 0, parts: [] }));
      m.total += f.total;
      m.unread += f.unread;
      m.parts.push({ address: account.address, color: account.color, id: f.id, rule: f.rule });
    }
  }
  return [...byKey.values()];
}

/** Sidebar data for the combined views: counts added across accounts. */
export async function loadCombinedNav(accounts: OpenAccount[]) {
  const navs = await Promise.all(accounts.map((a) => loadNav(a.stub)));
  return {
    messagesUnread: navs.reduce((n, x) => n + x.messagesUnread, 0),
    sent: navs.reduce((n, x) => n + x.sent, 0),
    archived: navs.reduce((n, x) => n + x.archived, 0),
    trashed: navs.reduce((n, x) => n + x.trashed, 0),
    drafts: navs.reduce((n, x) => n + x.drafts, 0),
    folders: mergeFolders(accounts.map((account, i) => ({ account, folders: navs[i]!.folders }))),
    perAccount: accounts.map((a, i) => ({ address: a.address, folders: navs[i]!.folders })),
  };
}

// --- the combined list --------------------------------------------------------

/**
 * Paging across accounts: each account keeps its own position (the time and
 * seq of the last row shown from it), or "done" once it has nothing older. Encoded in one
 * query parameter so a page link is still a plain GET.
 */
type Cursor = Record<string, [number, number] | "done">;

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string | null): Cursor {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Cursor = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "done") out[k] = v;
      else if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))) out[k] = [v[0], v[1]];
    }
    return out;
  } catch {
    return {};
  }
}

export interface CombinedRow extends IndexedMessage {
  account: OpenAccount;
}

/**
 * One page of mail across `accounts`, newest first. Each account returns its
 * newest page before its own cursor; the rows are interleaved by time and the
 * first INBOX_PAGE_SIZE kept. An account that contributed nothing keeps its
 * cursor, so paging never skips or repeats a message.
 */
export async function loadCombinedList(accounts: OpenAccount[], params: URLSearchParams, folders: MergedFolder[]) {
  const rawView = params.get("view");
  const view: "messages" | "sent" | "trash" | "archive" = rawView === "trash" ? "trash" : rawView === "sent" ? "sent" : rawView === "archive" ? "archive" : "messages";
  const unread = params.get("unread") === "1";
  const starredFirst = params.get("sort") === "starred";
  const folderParam = params.get("folder");
  const folder = folderParam ? folders.find((f) => f.key === folderKey(folderParam)) ?? null : null;
  const cursor = decodeCursor(params.get("c"));
  const firstPage = Object.keys(cursor).length === 0;

  // In a folder, only the accounts that have it take part.
  const taking = folder ? accounts.filter((a) => folder.parts.some((p) => p.address === a.address)) : accounts;
  const filterFor = (a: OpenAccount) => ({
    folder: folder ? folder.parts.find((p) => p.address === a.address)!.id : undefined,
    trash: view === "trash",
    archived: view === "archive" || undefined,
    box: view === "trash" || view === "archive" ? undefined : view,
    unread: unread || undefined,
  });

  const byTime = (x: IndexedMessage, y: IndexedMessage) => y.received_at - x.received_at || y.seq - x.seq;

  const pinned: CombinedRow[] = starredFirst && firstPage
    ? (await Promise.all(taking.map(async (a) =>
        ((await a.stub.list(INBOX_PAGE_SIZE, 0, { ...filterFor(a), starred: true })) as IndexedMessage[]).map((r) => ({ ...r, account: a })),
      ))).flat().sort(byTime)
    : [];

  const pages = await Promise.all(taking.map(async (a) => {
    const at = cursor[a.address];
    if (at === "done") return { a, rows: [] as IndexedMessage[] };
    const rows = (await a.stub.list(INBOX_PAGE_SIZE + 1, 0, {
      ...filterFor(a),
      after: Array.isArray(at) ? { at: at[0], seq: at[1] } : undefined,
      unstarred: starredFirst || undefined,
    })) as IndexedMessage[];
    return { a, rows };
  }));

  const merged = pages.flatMap(({ a, rows }) => rows.map((r) => ({ ...r, account: a } as CombinedRow))).sort(byTime);
  const shown = merged.slice(0, INBOX_PAGE_SIZE);

  const next: Cursor = {};
  let more = false;
  for (const { a, rows } of pages) {
    const mine = shown.filter((r) => r.account.address === a.address);
    const at = cursor[a.address];
    if (at === "done" || (mine.length === rows.length && rows.length <= INBOX_PAGE_SIZE)) { next[a.address] = "done"; continue; }
    const lastMine = mine[mine.length - 1];
    next[a.address] = lastMine ? [lastMine.received_at, lastMine.seq] : Array.isArray(at) ? at : [Number.MAX_SAFE_INTEGER, 0];
    more = true;
  }

  return {
    view,
    unread,
    starredFirst,
    folder,
    messages: [...pinned, ...shown],
    pinnedCount: pinned.length,
    nextCursor: more ? encodeCursor(next) : null,
  };
}
