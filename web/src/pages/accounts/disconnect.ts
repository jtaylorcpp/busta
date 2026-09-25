/**
 * POST /accounts/disconnect — stop syncing a Gmail account and revoke Busta's
 * access at Google. The mail already brought in stays, read-only.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { openMailbox } from "../../lib/mail-data";
import { revoke } from "../../../../src/sources/google";
import { unseal } from "../../../../src/sources/seal";

export const POST: APIRoute = async (ctx) => {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId || !orgId) return ctx.redirect("/sign-in", 303);
  const f = await ctx.request.formData();
  const access = await openMailbox(env, { userId, orgId }, String(f.get("address") ?? ""));
  if (!access.ok) return new Response(access.message, { status: access.status });
  const sealed = (await access.stub.disconnectGmail()) as string | null;
  let note = "";
  if (sealed) {
    const revoked = await revoke(await unseal(env, sealed)).catch(() => false);
    if (!revoked) note = " Google didn't confirm; you can also remove Busta at myaccount.google.com/permissions.";
  }
  return ctx.redirect(`/accounts?ok=${encodeURIComponent(`Disconnected ${access.address}.${note}`)}`, 303);
};
