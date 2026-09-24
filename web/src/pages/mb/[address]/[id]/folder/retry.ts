/** POST /mb/<address>/<id>/folder/retry — run the folder rules on one message again. */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { fileMessage } from "../../../../../../../src/folders";
import { back, gate } from "../../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const row = (await g.stub.lookup(ctx.params.id!)) as { id: string; thread_id: string; label: string | null; folder_source: string | null } | null;
  if (!row) return new Response("Message not found", { status: 404 });
  if (row.folder_source === "you") {
    return back(ctx, g.address, `/mb/${encodeURIComponent(g.address)}`, { kind: "ok", text: "You filed this by hand, so rules leave it alone." });
  }
  const d = await fileMessage(env, g.address, { id: row.id, threadId: row.thread_id, label: row.label });
  const text =
    !d ? "No folder rules to apply." :
    d.state === "failed" ? "Couldn't sort it again. Try later." :
    d.state === "filed" ? "Sorted." :
    d.state === "unsure" ? "Still unsure. Pick a folder by hand." : "No folder fits.";
  return back(ctx, g.address, `/mb/${encodeURIComponent(g.address)}`, { kind: d?.state === "failed" ? "error" : "ok", text });
};
