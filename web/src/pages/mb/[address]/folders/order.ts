/**
 * POST /mb/<address>/folders/order — put folders in this order (the order
 * mail is sorted in), by name, in every account the user can open. JSON
 * {names} from drag and drop answers 204; a form with repeated `name`
 * fields (the filing panel's "Move … above …") returns to ?back=.
 */
import type { APIRoute } from "astro";
import { back, gate } from "../../../../lib/actions";
import { applyFolderOrder } from "../../../../lib/folder-order";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { userId, orgId } = ctx.locals.auth();
  const json = (ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const raw = json
    ? ((await ctx.request.json()) as { names?: unknown }).names
    : (await ctx.request.formData()).getAll("name").map(String);
  const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, 200) : [];
  if (names.length === 0) return json ? Response.json({ error: "No folders to order." }, { status: 400 }) : back(ctx, g.address, `/mb/${encodeURIComponent(g.address)}/folders`);
  await applyFolderOrder({ userId: userId!, orgId: orgId! }, g.address, names);
  if (json) return new Response(null, { status: 204 });
  return back(ctx, g.address, `/mb/${encodeURIComponent(g.address)}/folders`, { kind: "ok", text: "Folder order saved. New mail is sorted in this order." });
};
