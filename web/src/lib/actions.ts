/**
 * Shared bits for Astro POST handlers: auth + mailbox gate, and a safe
 * redirect back to where the form was submitted from.
 */
import type { APIContext } from "astro";
import { env } from "cloudflare:workers";
import { openMailbox } from "./mail-data";

export async function gate(ctx: APIContext) {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId || !orgId) return { ok: false as const, response: ctx.redirect("/sign-in", 303) };
  const access = await openMailbox(env, { userId, orgId }, ctx.params.address!);
  if (!access.ok) return { ok: false as const, response: new Response(access.message, { status: access.status }) };
  return { ok: true as const, address: access.address, stub: access.stub };
}

/** Redirect to ?back= if it points inside this mailbox, else to `fallback`, with a flash. */
export function back(ctx: APIContext, address: string, fallback: string, flash?: { kind: "ok" | "error"; text: string }) {
  let raw = ctx.url.searchParams.get("back") ?? "";
  const mine = `/mb/${encodeURIComponent(address)}`;
  const plain = `/mb/${address}`;
  if (raw.startsWith(plain)) raw = mine + raw.slice(plain.length);
  // The combined view (/mail) is also "inside": its rows act on this mailbox.
  const inside = (p: string) => raw === p || raw.startsWith(`${p}/`) || raw.startsWith(`${p}?`);
  const target = inside(mine) || inside("/mail") ? raw : fallback;
  if (!flash) return ctx.redirect(target, 303);
  const u = new URL(target, ctx.url);
  u.searchParams.delete("ok");
  u.searchParams.delete("error");
  u.searchParams.set(flash.kind, flash.text);
  return ctx.redirect(u.pathname + u.search, 303);
}
