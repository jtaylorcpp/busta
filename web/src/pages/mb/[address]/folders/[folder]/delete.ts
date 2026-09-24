/** POST /mb/<address>/folders/<id>/delete — remove a folder. Its mail stays in Messages. */
import type { APIRoute } from "astro";
import { gate } from "../../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const folder = (await g.stub.getFolder(ctx.params.folder!)) as { name: string } | null;
  await g.stub.deleteFolder(ctx.params.folder!);
  const b = `/mb/${encodeURIComponent(g.address)}`;
  return ctx.redirect(`${b}/folders?ok=${encodeURIComponent(folder ? `Deleted ${folder.name}. Its mail is still in Messages.` : "Folder deleted.")}`, 303);
};
