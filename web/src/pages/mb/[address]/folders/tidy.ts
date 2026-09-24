/**
 * POST /mb/<address>/folders/tidy — JSON {name, rule} → a readable rewrite
 * of the rule as "Goes in" / "Leaves out" lists ({goesIn, leavesOut, text}).
 * Proposes only; nothing is saved.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { tidyRule } from "../../../../../../src/explain";
import { gate } from "../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { name, rule } = (await ctx.request.json()) as { name?: string; rule?: string };
  if (!rule?.trim()) return Response.json({ error: "Write a rule first." }, { status: 400 });
  try {
    const t = await tidyRule(env, { name: (name ?? "").trim() || "This folder", rule: rule.trim().slice(0, 2000) });
    return Response.json(t, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("tidy failed", String(e));
    return Response.json({ error: "Couldn't tidy the rule right now. Try again in a moment." }, { status: 502 });
  }
};
