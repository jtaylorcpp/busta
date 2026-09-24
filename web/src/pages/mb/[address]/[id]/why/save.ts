/**
 * POST /mb/<address>/<id>/why/save — form {folder, rule}: save the folder's
 * new rule (keywords added, maybe tidied), re-file this message now, and
 * re-sort recent mail in the background. The old rule is kept for Undo.
 * Mail you filed by hand never moves.
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { fileMessage, sortRecent } from "../../../../../../../src/folders";
import type { Folder, IndexedMessage } from "../../../../../../../src/mailbox-do";
import { back, gate } from "../../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const f = await ctx.request.formData();
  const thread = `/mb/${encodeURIComponent(g.address)}/${ctx.params.id}`;
  const folder = (await g.stub.getFolder(String(f.get("folder") ?? ""))) as Folder | null;
  const rule = String(f.get("rule") ?? "").trim();
  if (!folder) return back(ctx, g.address, thread, { kind: "error", text: "That folder no longer exists." });
  if (!rule) return back(ctx, g.address, thread, { kind: "error", text: "The rule can't be empty." });
  if (rule.length > 2000) return back(ctx, g.address, thread, { kind: "error", text: "Keep the rule under 2,000 characters." });

  await g.stub.saveFolder({ id: folder.id, name: folder.name, rule, plusLabel: folder.plus_label });
  const m = (await g.stub.lookup(ctx.params.id!)) as IndexedMessage | null;
  const d = m ? await fileMessage(env, g.address, { id: m.id, threadId: m.thread_id, label: m.label }) : null;
  waitUntil(sortRecent(env, g.address, { days: 7, limit: 100 }).catch((e) => console.error("sortRecent failed", String(e))));

  const where = d?.state === "filed" && d.folderId === folder.id
    ? `This message moved into ${folder.name}.`
    : d?.state === "unsure" ? "This message is closer but still unsure." : "This message still doesn't fit.";
  const u = new URL(thread, ctx.url);
  u.searchParams.set("ok", `${folder.name} rule updated. ${where} Re-sorting recent mail.`);
  u.searchParams.set("undo", folder.id);
  return ctx.redirect(u.pathname + u.search, 303);
};
