/**
 * POST /accounts/show — show or hide accounts in the combined list (the
 * account menu's checkboxes, and "Show all"). Fields: address (repeatable),
 * shown ("1" or "0"), back (a path to return to). A hidden account keeps
 * receiving and sorting mail; it is only left out of the views.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { tenantStub } from "../../../../src/mail";
import { ALL } from "../../lib/accounts";

export const POST: APIRoute = async (ctx) => {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId || !orgId) return ctx.redirect("/sign-in", 303);
  const f = await ctx.request.formData();
  const shown = f.get("shown") === "1";
  const tenant = tenantStub(env, orgId);
  for (const raw of f.getAll("address")) {
    const address = String(raw).toLowerCase();
    if (await tenant.hasMailbox(address)) await tenant.setShown(address, shown);
  }
  const back = String(f.get("back") ?? "");
  // Only return to our own views; anything else goes to the combined list.
  const target = /^\/(mail|mb\/)[^\s]*$/.test(back) && !back.startsWith("//") ? back : ALL;
  const u = new URL(target, ctx.url);
  u.searchParams.delete("c");
  return ctx.redirect(u.pathname + u.search, 303);
};
