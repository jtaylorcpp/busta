/**
 * POST /mb/<address>/folders/<id>/unsort — Undo the last sort: for a folder
 * id, the last "Sort mail I already have" for it; for "all", the last "Sort
 * mail again" in every account. What it moved goes back where it was, unless
 * you've filed it by hand since.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { gate } from "../../../../../lib/actions";
import { listAccounts } from "../../../../../lib/accounts";
import { openMailbox } from "../../../../../lib/mail-data";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const id = ctx.params.folder!;
  let n = 0;
  if (id === "all") {
    const { userId, orgId } = ctx.locals.auth();
    const session = { userId: userId!, orgId: orgId! };
    const addresses = new Set([g.address, ...(await listAccounts(env, session.orgId)).map((a) => a.address)]);
    for (const address of addresses) {
      const access = await openMailbox(env, session, address);
      if (access.ok) n += (await access.stub.undoSort("all")) as number;
    }
  } else {
    n = (await g.stub.undoSort(id)) as number;
  }
  const text = n ? `Undone: ${n} email${n === 1 ? "" : "s"} went back where they were.` : "Nothing to undo.";
  const to = id === "all" ? "" : `folder=${encodeURIComponent(id)}&`;
  return ctx.redirect(`/mb/${encodeURIComponent(g.address)}?${to}ok=${encodeURIComponent(text)}`, 303);
};
