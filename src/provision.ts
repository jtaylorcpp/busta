import { mailboxStub, tenantStub } from "./mail";

/**
 * Create a mailbox: claim the address for the org, then list it on the
 * tenant as ready. Two Durable Object writes, done inline in the request.
 *
 * This used to be a Workflow, from when setup also created a per-address
 * Email Routing rule. Inbound mail now reaches the Worker through the zone's
 * catch-all, so an address is live the moment its Durable Object says who
 * owns it — there is nothing external to wait on or retry. Running it inline
 * also means the page that asked for a mailbox can open it immediately,
 * instead of rendering "setting up" before a background run has written it.
 *
 * Safe to repeat: claim() succeeds again for the org that already owns the
 * address, and addMailbox() upserts. A failure between the two writes is
 * repaired by calling this again (the Retry action does exactly that).
 */
export async function provisionMailbox(
  env: Env,
  input: { orgId: string; address: string; localPart: string; label: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const claim = await mailboxStub(env, input.address).claim(input.orgId, input.address);
  if (!claim.claimed) {
    return { ok: false, reason: `${input.address} is already owned by another organization.` };
  }
  await tenantStub(env, input.orgId).addMailbox(input.address, input.localPart, env.MAIL_DOMAIN, input.label, "ready");
  return { ok: true };
}
