/**
 * POST /mb/<address>/folders/test — JSON {name, rule} → how that rule would
 * judge the 5 newest received messages: [{id, from, subject, in, p}] where
 * `p` is the model's probability for this folder (vs none). Read-only.
 *
 * A mailbox with almost no mail (new, or in the Getting started guide) is
 * tested against built-in sample mail instead, and the response says
 * `sample: true` so the UI can mark it.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { threadStub } from "../../../../../../src/mail";
import { classifyEmail, type ClassifyResult } from "../../../../../../src/classify";
import { gate } from "../../../../lib/actions";
import { FOLDER_THRESHOLD } from "../../../../../../src/folders";
import { SAMPLE_BELOW, SAMPLE_MAIL } from "../../../../lib/sample-mail";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { name, rule } = (await ctx.request.json()) as { name?: string; rule?: string };
  if (!rule?.trim()) return Response.json({ error: "Write a rule to test." }, { status: 400 });
  const rows = (await g.stub.recentReceived(5)) as { id: string; thread_id: string; sender: string; from_name: string | null; subject: string }[];
  const folder = { id: "test", name: (name ?? "").trim() || "This folder", rule: rule.trim().slice(0, 2000) };
  const sample = rows.length < SAMPLE_BELOW;

  const judge = async (id: string, from: string, subject: string, run: () => Promise<ClassifyResult>) => {
    try {
      const out = await run();
      const p = out.probabilities.test ?? (out.folderId ? out.probability : 0);
      return { id, from, subject, in: out.folderId === "test" && p >= FOLDER_THRESHOLD, p };
    } catch (e) {
      return { id, from, subject, error: String(e).slice(0, 200) };
    }
  };

  const results = await Promise.all(
    sample
      ? SAMPLE_MAIL.map((s) => judge(s.id, s.fromName, s.subject, () => classifyEmail(env, s, [folder])))
      : rows.map((r) => judge(r.id, r.from_name || r.sender, r.subject, () => threadStub(env, g.address, r.thread_id).classify(r.id, [folder]))),
  );
  return Response.json({ threshold: FOLDER_THRESHOLD, sample, results }, { headers: { "cache-control": "no-store" } });
};
