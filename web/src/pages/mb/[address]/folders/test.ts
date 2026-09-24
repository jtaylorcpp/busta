/**
 * POST /mb/<address>/folders/test — JSON {name, rule} → how that rule would
 * judge the 5 newest received messages: [{id, from, subject, in, p}] where
 * `p` is the model's probability for this folder (vs none). Read-only.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { threadStub } from "../../../../../../src/mail";
import { gate } from "../../../../lib/actions";
import { FOLDER_THRESHOLD } from "../../../../../../src/folders";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { name, rule } = (await ctx.request.json()) as { name?: string; rule?: string };
  if (!rule?.trim()) return Response.json({ error: "Write a rule to test." }, { status: 400 });
  const rows = (await g.stub.recentReceived(5)) as { id: string; thread_id: string; sender: string; from_name: string | null; subject: string }[];
  const folder = { id: "test", name: (name ?? "").trim() || "This folder", rule: rule.trim().slice(0, 2000) };
  const results = await Promise.all(
    rows.map(async (r) => {
      try {
        const out = await threadStub(env, g.address, r.thread_id).classify(r.id, [folder]);
        const p = out.probabilities.test ?? (out.folderId ? out.probability : 0);
        return { id: r.id, from: r.from_name || r.sender, subject: r.subject, in: out.folderId === "test" && p >= FOLDER_THRESHOLD, p };
      } catch (e) {
        return { id: r.id, from: r.from_name || r.sender, subject: r.subject, error: String(e).slice(0, 200) };
      }
    }),
  );
  return Response.json({ threshold: FOLDER_THRESHOLD, results }, { headers: { "cache-control": "no-store" } });
};
