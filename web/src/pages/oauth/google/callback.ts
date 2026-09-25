/**
 * GET /oauth/google/callback — Google sends the user back here. Finish the
 * sign-in, then make (or reconnect) the Gmail account's mailbox in this org:
 *
 *   - The address is the email Google vouches for; that's the proof of
 *     ownership. A Gmail already connected to another org is refused.
 *   - The refresh token is sealed before it's stored.
 *   - New accounts can start with the org's folders and rules (Applies to).
 *   - The mailbox's alarm then brings in the chosen days and follows new mail.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { mailboxStub, tenantStub } from "../../../../../src/mail";
import { exchangeCode, GoogleAuthError, revoke } from "../../../../../src/sources/google";
import { seal } from "../../../../../src/sources/seal";
import type { FolderWithCounts } from "../../../../../src/mailbox-do";
import { listAccounts, mergeFolders, openShown } from "../../../lib/accounts";
import { redirectUri, takeTicket } from "../../../lib/connect";

export const GET: APIRoute = async (ctx) => {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId) return ctx.redirect("/sign-in", 303);
  const fail = (text: string) => ctx.redirect(`/connect/gmail?error=${encodeURIComponent(text)}`, 303);

  const ticket = await takeTicket(ctx.cookies, env.THREAD_SECRET);
  const q = ctx.url.searchParams;
  if (!ticket || ticket.state !== q.get("state") || ticket.userId !== userId || ticket.orgId !== orgId) {
    return fail("That sign-in expired or didn't match. Try again.");
  }
  if (q.get("error") || !q.get("code")) return fail("Google didn't give Busta access. Nothing was connected.");

  let signedIn: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    signedIn = await exchangeCode(env, { code: q.get("code")!, verifier: ticket.verifier, redirectUri: redirectUri(ctx.url) });
  } catch (e) {
    return fail(e instanceof GoogleAuthError ? e.message : "Google sign-in failed. Try again.");
  }

  const address = signedIn.email;
  const [local, domain] = address.split("@") as [string, string];
  const mailbox = mailboxStub(env, address);
  const owner = await mailbox.ownerOrgId();
  if (owner && owner !== orgId) {
    await revoke(signedIn.refreshToken).catch(() => false);
    return fail(`${address} is already connected to another Busta organization.`);
  }

  const tenant = tenantStub(env, orgId!);
  const isNew = !owner;
  if (isNew) {
    const claim = await mailbox.claim(orgId!, address);
    if (!claim.claimed) return fail(`${address} is already connected to another Busta organization.`);
  }
  await tenant.addMailbox(address, local, domain, "Gmail", "ready", "gmail");

  // Start with the org's folders, merged by name, so Applies to covers Gmail too.
  if (isNew && ticket.copyFolders) {
    const others = (await listAccounts(env, orgId!)).filter((a) => a.address !== address);
    const opened = await openShown(env, { userId, orgId: orgId! }, others.map((a) => ({ ...a, shown: true })));
    const per = await Promise.all(opened.map(async (a) => ({ account: a, folders: (await a.stub.listFolders()) as FolderWithCounts[] })));
    for (const f of mergeFolders(per)) {
      const rule = f.parts[0]!.rule;
      if (rule.trim()) await mailbox.saveFolder({ name: f.name, rule });
    }
  }

  await mailbox.connectGmail({ account: address, sealedRefresh: await seal(env, signedIn.refreshToken), days: ticket.days });

  const text = isNew
    ? `Connected ${address}. Bringing in the last ${ticket.days} days; new mail is next.`
    : `Reconnected ${address}. Catching up now.`;
  return ctx.redirect(`/mail?ok=${encodeURIComponent(text)}`, 303);
};
