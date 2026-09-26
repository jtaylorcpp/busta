/**
 * POST /mb/<address>/folders/resort — "Sort mail again": re-sort the mail
 * from the last 30 days (up to 200 per account) in every account, in folder
 * order, in the background. Mail you filed by hand never moves. Lands on
 * Messages with Undo (?sorted=all, which puts every account back).
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { SORT_WINDOW, sortRecent } from "../../../../../../src/folders";
import { gate } from "../../../../lib/actions";
import { listAccounts } from "../../../../lib/accounts";
import { openMailbox } from "../../../../lib/mail-data";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { userId, orgId } = ctx.locals.auth();
  const session = { userId: userId!, orgId: orgId! };
  const addresses = new Set([g.address, ...(await listAccounts(env, session.orgId)).map((a) => a.address)]);
  let n = 0;
  for (const address of addresses) {
    const access = await openMailbox(env, session, address);
    if (!access.ok) continue;
    n += 1;
    waitUntil(sortRecent(env, access.address, SORT_WINDOW, { undoKey: "all" }).catch((e) => console.error("resort failed", access.address, String(e))));
  }
  const text = `Sorting mail from the last ${SORT_WINDOW.days} days again${n > 1 ? ` in ${n} accounts` : ""}, in your folder order. It takes a minute or two.`;
  return ctx.redirect(`/mb/${encodeURIComponent(g.address)}?ok=${encodeURIComponent(text)}&sorted=all`, 303);
};
