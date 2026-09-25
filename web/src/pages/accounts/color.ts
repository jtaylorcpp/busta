/**
 * POST /accounts/color — set an account's color (address, color). Colors stay
 * unique: an account already wearing it swaps to this account's old color.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { tenantStub } from "../../../../src/mail";
import { ACCOUNT_COLORS, listAccounts } from "../../lib/accounts";

export const POST: APIRoute = async (ctx) => {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId || !orgId) return ctx.redirect("/sign-in", 303);
  const f = await ctx.request.formData();
  const address = String(f.get("address") ?? "").toLowerCase();
  const color = String(f.get("color") ?? "");
  const tenant = tenantStub(env, orgId);
  if (!(ACCOUNT_COLORS as readonly string[]).includes(color) || !(await tenant.hasMailbox(address))) {
    return ctx.redirect(`/accounts?error=${encodeURIComponent("Pick one of the colors shown.")}`, 303);
  }
  const accounts = await listAccounts(env, orgId);
  const mine = accounts.find((a) => a.address === address)!;
  // Pin every account's current color first, so positional defaults don't shift.
  for (const a of accounts) await tenant.setColor(a.address, a.color);
  const holder = accounts.find((a) => a.address !== address && a.color === color);
  if (holder) await tenant.setColor(holder.address, mine.color);
  await tenant.setColor(address, color);
  return ctx.redirect("/accounts", 303);
};
