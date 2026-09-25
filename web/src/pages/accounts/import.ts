/**
 * POST /accounts/import — "Bring in older mail" for a Gmail account: queue the
 * next window back (days: 90, 365, or 0 for everything) in its import queue.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { importStub } from "../../../../src/mail";
import { openMailbox } from "../../lib/mail-data";

export const POST: APIRoute = async (ctx) => {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId || !orgId) return ctx.redirect("/sign-in", 303);
  const f = await ctx.request.formData();
  const access = await openMailbox(env, { userId, orgId }, String(f.get("address") ?? ""));
  if (!access.ok) return new Response(access.message, { status: access.status });
  if ((await access.stub.sendingAs()) !== "gmail") return ctx.redirect(`/accounts?error=${encodeURIComponent("Reconnect Gmail first.")}`, 303);
  const days = [90, 365, 0].includes(Number(f.get("days"))) ? Number(f.get("days")) : 365;
  const st = await importStub(env, access.address).start({ address: access.address, days, older: true, sortBudget: 1_000 });
  const text = st.phase === "done" ? "Nothing older to bring in for that window." : `Bringing in older mail for ${access.address}. The newest 1,000 are sorted by your rules.`;
  return ctx.redirect(`/accounts?ok=${encodeURIComponent(text)}`, 303);
};
