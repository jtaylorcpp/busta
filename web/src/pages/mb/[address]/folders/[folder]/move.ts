/**
 * POST /mb/<address>/folders/<id>/move?dir=up|down — move a folder one place
 * in the sort order (every account, by name). The arrows on the Folders page;
 * they work without JavaScript.
 */
import type { APIRoute } from "astro";
import { gate } from "../../../../../lib/actions";
import { applyFolderOrder, namesWithMove } from "../../../../../lib/folder-order";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { userId, orgId } = ctx.locals.auth();
  const dir = ctx.url.searchParams.get("dir") === "up" ? "up" : "down";
  await applyFolderOrder({ userId: userId!, orgId: orgId! }, g.address, await namesWithMove(g.stub, ctx.params.folder!, dir));
  return ctx.redirect(`/mb/${encodeURIComponent(g.address)}/folders`, 303);
};
