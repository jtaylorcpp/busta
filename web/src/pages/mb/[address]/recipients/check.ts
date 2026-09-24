/**
 * GET /mb/<address>/recipients/check?a=x@y&a=… → { bounced: [...] }
 * Which of the given addresses are on this mailbox's bounce list. Advisory:
 * compose shows a warning, sending is never blocked. Same auth gate as pages.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { openMailbox } from "../../../../lib/mail-data";

export const GET: APIRoute = async ({ locals, params, url }) => {
  const { userId, orgId } = locals.auth();
  if (!userId || !orgId) return new Response("Sign in again", { status: 401 });
  const access = await openMailbox(env, { userId, orgId }, params.address!);
  if (!access.ok) return new Response(access.message, { status: access.status });
  const addrs = url.searchParams.getAll("a").map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, 50);
  const bounced = addrs.length ? ((await access.stub.suppressed(addrs)) as string[]) : [];
  return Response.json({ bounced }, { headers: { "cache-control": "no-store" } });
};
