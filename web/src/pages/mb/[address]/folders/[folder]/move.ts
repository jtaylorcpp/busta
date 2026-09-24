/** POST /mb/<address>/folders/<id>/move?dir=up|down — reorder. Order only breaks ties. */
import type { APIRoute } from "astro";
import { gate } from "../../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const dir = ctx.url.searchParams.get("dir") === "up" ? "up" : "down";
  await g.stub.moveFolder(ctx.params.folder!, dir);
  return ctx.redirect(`/mb/${encodeURIComponent(g.address)}/folders`, 303);
};
