/**
 * POST /mb/<address>/start/rule — Getting started, step 1: save the
 * description as the Must read folder's rule, then go to step 2.
 *
 * Updates the folder the guide made before, or an existing folder with the
 * same name, rather than creating a second one. If the mailbox already has
 * mail, recent mail is sorted into it in the background (7 days / 100, the
 * folder editor's default).
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { sortRecent } from "../../../../../../src/folders";
import { gate } from "../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const f = await ctx.request.formData();
  const name = String(f.get("name") ?? "").trim() || "Must read";
  const rule = String(f.get("rule") ?? "").trim();
  const b = `/mb/${encodeURIComponent(g.address)}`;
  const fail = (text: string) => ctx.redirect(`${b}/start?error=${encodeURIComponent(text)}`, 303);

  if (!rule) return fail("Describe what matters to you, or skip this step.");
  if (rule.length > 2000) return fail("Keep the description under 2,000 characters.");
  if (name.length > 60) return fail("Keep the name under 60 characters.");

  const guide = await g.stub.guide();
  const existing = guide.folderId ? await g.stub.getFolder(guide.folderId) : await g.stub.folderByName(name);
  const folderId = (await g.stub.saveFolder({ id: existing?.id, name, rule, plusLabel: existing?.plus_label ?? null })) as string;
  await g.stub.updateGuide({
    status: "active",
    folderId,
    ruleSkipped: false,
    testSince: guide.landedId ? guide.testSince : Date.now(),
  });

  if ((await g.stub.recentReceived(1)).length > 0) {
    waitUntil(sortRecent(env, g.address, { days: 7, limit: 100 }).catch((e) => console.error("sortRecent failed", String(e))));
  }
  return ctx.redirect(`${b}/start/test`, 303);
};
