/**
 * POST /mb/<address>/<id>/folder — file a message by hand (field `folder`:
 * a folder id, or "" for no folder). A manual choice locks the message:
 * rules never refile it.
 */
import type { APIRoute } from "astro";
import { back, gate } from "../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const form = await ctx.request.formData();
  const folderId = String(form.get("folder") ?? "") || null;
  const folders = (await g.stub.listFolders()) as { id: string; name: string }[];
  const folder = folderId ? folders.find((f) => f.id === folderId) : null;
  if (folderId && !folder) return back(ctx, g.address, `/mb/${encodeURIComponent(g.address)}`, { kind: "error", text: "That folder no longer exists." });
  await g.stub.fileMessage(ctx.params.id!, { folderId, source: "you", state: folderId ? "filed" : "none" });
  return back(ctx, g.address, `/mb/${encodeURIComponent(g.address)}/${ctx.params.id}`, {
    kind: "ok",
    text: folder ? `Filed in ${folder.name}.` : "Kept in Messages. Rules won't refile it.",
  });
};
