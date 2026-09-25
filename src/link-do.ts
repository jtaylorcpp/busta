import { DurableObject } from "cloudflare:workers";

/**
 * One per one-time link (designs/2026-09-25-text-busta, screens 2-3), named by
 * the SHA-256 of its token, so the token itself is never stored anywhere.
 *
 * A link opens one thing: an email, or an answer plus the emails it cites.
 * It needs the user's PIN, works once, and lasts 12 hours. Opening it with
 * the right PIN starts a 30-minute session for that same scope (reload,
 * attachments), identified by a random id in a path-scoped cookie. Five wrong
 * PINs lock it for good.
 */
export interface Cite {
  address: string;
  messageId: string;
  /** What the answer relied on, quoted from the email or attachment. */
  quote: string;
  kind: "email" | "pdf" | "image" | "doc";
  title: string;
  from: string;
  date: number;
}

export interface LinkRecord {
  kind: "email" | "answer";
  orgId: string;
  userId: string;
  /** Email links: the one message. */
  address?: string;
  messageId?: string;
  /** Shown on the PIN page: the folder, plus sender/subject only if the user opted in. */
  label: string;
  /** Answer links: the question, the full answer, and what it cites. */
  question?: string;
  answer?: string;
  cites?: Cite[];
  createdAt: number;
  expiresAt: number;
}

interface LinkState extends LinkRecord {
  usedAt: number | null;
  pinFails: number;
  session: { id: string; expiresAt: number } | null;
}

export const LINK_TTL_MS = 12 * 3_600_000;
export const SESSION_MS = 30 * 60_000;
const MAX_PIN_FAILS = 5;

export type LinkStatus = "ready" | "open" | "used" | "expired" | "locked" | "missing";

export class LinkDO extends DurableObject<Env> {
  #get(): LinkState | null {
    const raw = this.ctx.storage.kv.get<string>("link");
    return raw ? (JSON.parse(raw) as LinkState) : null;
  }

  #put(st: LinkState): void {
    this.ctx.storage.kv.put("link", JSON.stringify(st));
  }

  create(record: LinkRecord): void {
    this.#put({ ...record, usedAt: null, pinFails: 0, session: null });
    // Forget the whole thing a day after it stops working.
    void this.ctx.storage.setAlarm(record.expiresAt + 86_400_000);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** Where the link stands, and (only) what the PIN page may show. */
  status(sessionId?: string | null): { status: LinkStatus; kind?: "email" | "answer"; label?: string; question?: string; userId?: string; orgId?: string; expiresAt?: number } {
    const st = this.#get();
    if (!st) return { status: "missing" };
    const base = { kind: st.kind, label: st.label, question: st.question, userId: st.userId, orgId: st.orgId, expiresAt: st.expiresAt };
    if (sessionId && st.session && st.session.id === sessionId && st.session.expiresAt > Date.now()) return { status: "open", ...base };
    if (st.pinFails >= MAX_PIN_FAILS) return { status: "locked", ...base };
    if (st.usedAt) return { status: "used", ...base };
    if (st.expiresAt <= Date.now()) return { status: "expired", ...base };
    return { status: "ready", ...base };
  }

  /** A wrong PIN. Returns tries left. */
  failPin(): number {
    const st = this.#get();
    if (!st) return 0;
    st.pinFails += 1;
    this.#put(st);
    return Math.max(0, MAX_PIN_FAILS - st.pinFails);
  }

  /** The right PIN: use the link up and start its session. Null if it can't be used. */
  use(): { id: string; expiresAt: number } | null {
    const st = this.#get();
    if (!st || st.usedAt || st.expiresAt <= Date.now() || st.pinFails >= MAX_PIN_FAILS) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    st.session = { id: btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, ""), expiresAt: Date.now() + SESSION_MS };
    st.usedAt = Date.now();
    this.#put(st);
    return st.session;
  }

  /** The full record, only for a live session. */
  open(sessionId: string): LinkRecord | null {
    const st = this.#get();
    if (!st?.session || st.session.id !== sessionId || st.session.expiresAt <= Date.now()) return null;
    const { usedAt: _u, pinFails: _p, session: _s, ...record } = st;
    return record;
  }

  /** End the session now ("Done"). */
  close(sessionId: string): void {
    const st = this.#get();
    if (st?.session?.id === sessionId) { st.session = null; this.#put(st); }
  }
}
