/**
 * POST /mb/<address>/folders/<id>/unsort — Undo the last "Sort mail I already
 * have" for this folder: what it moved goes back where it was, unless you've
 * filed it by hand since. Returns to the folder.
 */
import type { APIRoute } from "astro";
import { gate } from "../../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const id = ctx.params.folder!;
  const n = (await g.stub.undoSort(id)) as number;
  const text = n ? `Undone: ${n} email${n === 1 ? "" : "s"} went back where they were.` : "Nothing to undo.";
  return ctx.redirect(`/mb/${encodeURIComponent(g.address)}?folder=${encodeURIComponent(id)}&ok=${encodeURIComponent(text)}`, 303);
};
