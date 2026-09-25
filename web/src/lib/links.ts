/**
 * Serving one-time links (/v/<token>, /a/<token>): read the session cookie,
 * check the PIN, and load exactly what a link may show. Every message is
 * re-checked at serve time: its mailbox must still belong to the link's org,
 * and an answer link can only open the emails its answer cited.
 */
import type { APIContext, AstroCookies } from "astro";
import { mailboxStub, tenantStub, threadStub } from "../../../src/mail";
import { linkStub, SESSION_COOKIE, validToken } from "../../../src/sms/links";
import { checkPin } from "../../../src/sms/pin";
import type { LinkRecord } from "../../../src/link-do";
import type { TextingView } from "../../../src/tenant-do";
import type { IndexedMessage } from "../../../src/mailbox-do";
import type { ThreadAttachment, ThreadMessage } from "../../../src/thread-do";

export const linkPath = (kind: "v" | "a", token: string) => `/${kind}/${token}`;

export function sessionId(cookies: AstroCookies): string | null {
  return cookies.get(SESSION_COOKIE)?.value ?? null;
}

/** Host-only, this link's path only, 30 minutes, never sent cross-site. */
export function setSession(cookies: AstroCookies, path: string, id: string, secure: boolean) {
  cookies.set(SESSION_COOKIE, id, { path, httpOnly: true, secure, sameSite: "strict", maxAge: 30 * 60 });
}

export function clearSession(cookies: AstroCookies, path: string) {
  cookies.delete(SESSION_COOKIE, { path });
}

/** The live record for this token and cookie, or null. */
export async function openLink(env: Env, token: string, cookies: AstroCookies): Promise<LinkRecord | null> {
  if (!validToken(token)) return null;
  const sid = sessionId(cookies);
  return sid ? ((await (await linkStub(env, token)).open(sid)) as LinkRecord | null) : null;
}

/** The feature a link kind depends on; turning it off stops its links working. */
const FEATURE = { email: "links", answer: "ask" } as const;

/**
 * Try a PIN on a link. On success the link is used up and its session starts.
 */
export async function tryPin(ctx: APIContext | { cookies: AstroCookies; url: URL }, env: Env, kind: "v" | "a", token: string, pin: string):
  Promise<{ ok: true } | { ok: false; message: string }> {
  const link = await linkStub(env, token);
  const st = await link.status();
  if (st.status !== "ready") return { ok: false, message: "This link can't be opened." };
  const tenant = tenantStub(env, st.orgId!);
  const v = (await tenant.texting(st.userId!)) as TextingView;
  if (!v.phone || v.paused || !v.features[FEATURE[st.kind!]]) {
    return { ok: false, message: "Texted links are turned off in Busta's Texting settings." };
  }
  if (!(await checkPin(pin, (await tenant.textingPinHash(st.userId!)) as string | null))) {
    const left = await link.failPin();
    return { ok: false, message: left > 0 ? `That PIN didn't match. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong PINs. This link no longer works." };
  }
  const session = await link.use();
  if (!session) return { ok: false, message: "This link can't be opened." };
  setSession(ctx.cookies, linkPath(kind, token), session.id, ctx.url.protocol === "https:");
  return { ok: true };
}

export interface LinkedMessage {
  row: IndexedMessage;
  message: ThreadMessage;
  attachments: ThreadAttachment[];
  text: string;
}

/** One message, if its mailbox still belongs to `orgId`. */
export async function loadLinkedMessage(env: Env, orgId: string, address: string, messageId: string): Promise<LinkedMessage | null> {
  const mailbox = mailboxStub(env, address);
  if ((await mailbox.ownerOrgId()) !== orgId) return null;
  const row = (await mailbox.lookup(messageId)) as IndexedMessage | null;
  if (!row || row.deleted_at !== null) return null;
  const found = await threadStub(env, address, row.thread_id).get(messageId);
  if (!found) return null;
  const m = found.message as ThreadMessage;
  const text = m.body_text?.trim() || htmlToText(m.body_html ?? "") || "(no text in this email)";
  return { row, message: m, attachments: found.attachments as ThreadAttachment[], text };
}

/** Plain text from HTML, for a page that shows no remote content at all. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An attachment of a linked message, as a download that browsers don't keep. */
export async function attachmentResponse(env: Env, linked: LinkedMessage, attId: string): Promise<Response> {
  const att = linked.attachments.find((a) => a.id === attId);
  if (!att) return new Response("Not found", { status: 404 });
  const object = await env.MAIL_ARCHIVE.get(att.r2_key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": att.mime_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${att.filename.replace(/["\r\n]/g, "")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
