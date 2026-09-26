/**
 * POST /mb/<address>/folders/test — JSON {name, rule, days?, limit?, offset?}
 * → how that rule would judge the mail "Sort mail I already have" looks at
 * (the window, newest first, in Messages and every folder), 20 at a time:
 * {total, next, results: [{id, from, subject, place, in, p}]}. `place` is the
 * folder the email is in now (null for Messages); `p` is the model's
 * probability for this folder. The tester calls again with `offset: next`
 * until `next` is null. Read-only.
 *
 * A mailbox with almost no mail (new, or in the Getting started guide) is
 * tested against built-in sample mail instead, in one batch, and the
 * response says `sample: true` so the UI can mark it.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { classifyEmail } from "../../../../../../src/classify";
import { gate } from "../../../../lib/actions";
import { FOLDER_THRESHOLD, SORT_WINDOW, judgeForFolder } from "../../../../../../src/folders";
import type { SortCandidate } from "../../../../../../src/mailbox-do";
import { SAMPLE_BELOW, SAMPLE_MAIL } from "../../../../lib/sample-mail";

const BATCH = 20;
const whole = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : def;
};

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const body = (await ctx.request.json()) as { name?: string; rule?: string; days?: number; limit?: number; offset?: number };
  if (!body.rule?.trim()) return Response.json({ error: "Write a rule to test." }, { status: 400 });
  const folder = { id: "test", name: (body.name ?? "").trim() || "This folder", rule: body.rule.trim().slice(0, 2000) };
  const headers = { "cache-control": "no-store" };

  if (((await g.stub.recentReceived(SAMPLE_BELOW)) as unknown[]).length < SAMPLE_BELOW) {
    const results = await Promise.all(SAMPLE_MAIL.map(async (s) => {
      try {
        const out = await classifyEmail(env, s, [folder]);
        const p = out.probabilities.test ?? (out.folderId ? out.probability : 0);
        return { id: s.id, from: s.fromName, subject: s.subject, place: null, in: out.folderId === "test" && p >= FOLDER_THRESHOLD, p };
      } catch (e) {
        return { id: s.id, from: s.fromName, subject: s.subject, place: null, error: String(e).slice(0, 200) };
      }
    }));
    return Response.json({ sample: true, total: results.length, next: null, results }, { headers });
  }

  const days = whole(body.days, SORT_WINDOW.days, 1, 365);
  const limit = whole(body.limit, SORT_WINDOW.limit, 1, 500);
  const offset = whole(body.offset, 0, 0, limit);
  const rows = (await g.stub.sortCandidates({ days, limit })) as SortCandidate[];
  const batch = rows.slice(offset, offset + BATCH);
  const results = await Promise.all(batch.map(async (r) => {
    const base = { id: r.id, from: r.from_name || r.sender, subject: r.subject, place: r.place };
    try {
      return { ...base, ...(await judgeForFolder(env, g.address, r, folder)) };
    } catch (e) {
      return { ...base, error: String(e).slice(0, 200) };
    }
  }));
  const end = offset + batch.length;
  return Response.json({ sample: false, total: rows.length, next: end < rows.length ? end : null, results }, { headers });
};
