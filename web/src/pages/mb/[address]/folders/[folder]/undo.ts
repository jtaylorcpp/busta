/**
 * POST /mb/<address>/folders/<id>/undo — put the rule back to what it was
 * before its last change, and re-sort recent mail. Returns to ?back=.
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { sortRecent } from "../../../../../../../src/folders";
import { back, gate } from "../../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const b = `/mb/${encodeURIComponent(g.address)}`;
  const f = (await g.stub.undoRule(ctx.params.folder!)) as { name: string } | null;
  if (!f) return back(ctx, g.address, `${b}/folders/${ctx.params.folder}`, { kind: "error", text: "There's no earlier rule to go back to." });
  waitUntil(sortRecent(env, g.address, { days: 7, limit: 100 }).catch((e) => console.error("sortRecent failed", String(e))));
  return back(ctx, g.address, `${b}/folders/${ctx.params.folder}`, { kind: "ok", text: `${f.name} is back to its previous rule. Re-sorting recent mail.` });
};
