/**
 * POST /mb/<address>/folders/save — create or update a folder, then
 * optionally re-sort recent mail in the background (window: days + cap,
 * default 7 days / 100 messages). Mail you filed by hand is never re-sorted.
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { sortRecent } from "../../../../../../src/folders";
import { gate } from "../../../../lib/actions";
import { openMailbox } from "../../../../lib/mail-data";
import type { Folder } from "../../../../../../src/mailbox-do";

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

  // "Applies to" (2+ accounts): write the same folder and rule into every
  // checked account, and remove it from the ones that were unchecked. Each
  // account is authorized on its own; a folder is matched by its old name.
  const seen = f.getAll("also_seen").map(String);
  const checked = new Set(f.getAll("also").map(String));
  const origName = String(f.get("orig_name") ?? "").trim() || name;
  const { userId, orgId } = ctx.locals.auth();
  const touched: string[] = [g.address];
  for (const other of seen) {
    if (other === g.address) continue;
    const access = await openMailbox(env, { userId: userId!, orgId: orgId! }, other);
    if (!access.ok) continue;
    const match = ((await access.stub.folderByName(origName)) as Folder | null) ?? (origName !== name ? ((await access.stub.folderByName(name)) as Folder | null) : null);
    if (checked.has(other)) {
      await access.stub.saveFolder({ id: match?.id, name, rule, plusLabel: match?.plus_label ?? null });
      touched.push(access.address);
    } else if (match) {
      await access.stub.deleteFolder(match.id);
    }
  }

  let note = touched.length > 1 ? ` Saved to ${touched.length} accounts.` : "";
  if (f.get("apply") === "1") {
    const window = { days: clamp(f.get("days"), 7, 1, 365), limit: clamp(f.get("limit"), 100, 1, 500) };
    for (const address of touched) {
      waitUntil(sortRecent(env, address, window).catch((e) => console.error("sortRecent failed", address, String(e))));
    }
    note += ` Sorting mail from the last ${window.days} day${window.days > 1 ? "s" : ""} (up to ${window.limit}${touched.length > 1 ? " each" : ""}).`;
  }
  const text = encodeURIComponent(`${id ? "Saved" : "Created"} ${name}.${note}`);
  // With 2+ accounts, land on the merged folder in the combined list.
  if (seen.length > 0) return ctx.redirect(`/mail?folder=${encodeURIComponent(name)}&ok=${text}`, 303);
  return ctx.redirect(`${b}?folder=${folderId}&ok=${text}`, 303);
};
