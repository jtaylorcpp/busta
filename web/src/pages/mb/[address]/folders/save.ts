/**
 * POST /mb/<address>/folders/save — create or update a folder, then
 * optionally re-sort recent mail in the background (window: days + cap,
 * default 7 days / 100 messages). Mail you filed by hand is never re-sorted.
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { sortRecent } from "../../../../../../src/folders";
import { gate } from "../../../../lib/actions";

const clamp = (v: FormDataEntryValue | null, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const f = await ctx.request.formData();
  const id = String(f.get("id") ?? "") || undefined;
  const name = String(f.get("name") ?? "").trim();
  const rule = String(f.get("rule") ?? "").trim();
  const usePlus = f.get("use_plus") === "1";
  const plus = String(f.get("plus") ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  const b = `/mb/${encodeURIComponent(g.address)}`;
  const editUrl = id ? `${b}/folders/${id}` : `${b}/folders/new`;
  const fail = (text: string) => ctx.redirect(`${editUrl}?error=${encodeURIComponent(text)}`, 303);

  if (!name) return fail("Give the folder a name.");
  if (name.length > 60) return fail("Keep the name under 60 characters.");
  if (!rule && !(usePlus && plus)) return fail("Add a rule, or catch mail sent to a +address, so something can land here.");
  if (rule.length > 2000) return fail("Keep the rule under 2,000 characters.");

  const folderId = (await g.stub.saveFolder({ id, name, rule, plusLabel: usePlus ? plus : null })) as string;

  let note = "";
  if (f.get("apply") === "1") {
    const window = { days: clamp(f.get("days"), 7, 1, 365), limit: clamp(f.get("limit"), 100, 1, 500) };
    waitUntil(sortRecent(env, g.address, window).catch((e) => console.error("sortRecent failed", String(e))));
    note = ` Sorting mail from the last ${window.days} day${window.days > 1 ? "s" : ""} (up to ${window.limit}).`;
  }
  return ctx.redirect(`${b}?folder=${folderId}&ok=${encodeURIComponent(`${id ? "Saved" : "Created"} ${name}.${note}`)}`, 303);
};
