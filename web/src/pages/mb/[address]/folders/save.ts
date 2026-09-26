/**
 * POST /mb/<address>/folders/save — create or update a folder, then
 * optionally "Sort mail I already have" (src/folders.ts sortInto) over the
 * places checked under Where to look (`look`: "messages" or folder ids) and
 * the window (default 30 days / 200). A finished rule test comes along as
 * `tested` and is used as it is while the rule and window match; the rest is
 * judged in the background. Mail you filed by hand is never moved. Lands on
 * the folder with "N moved here" and Undo (?sorted=<folder id>).
 */
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { SORT_WINDOW, sortInto, type TestedVerdicts } from "../../../../../../src/folders";
import { gate } from "../../../../lib/actions";
import { mailboxStub } from "../../../../../../src/mail";
import { openMailbox } from "../../../../lib/mail-data";
import type { Folder, FolderWithCounts } from "../../../../../../src/mailbox-do";

/** The rule tester's verdicts, posted with the form; anything malformed is ignored. */
function parseTested(raw: FormDataEntryValue | null): TestedVerdicts | null {
  if (typeof raw !== "string" || !raw || raw.length > 60_000) return null;
  try {
    const t = JSON.parse(raw) as TestedVerdicts;
    if (typeof t.rule !== "string" || typeof t.days !== "number" || typeof t.limit !== "number" || !Array.isArray(t.out) || typeof t.in !== "object" || !t.in) return null;
    const ins = Object.entries(t.in).filter(([k, p]) => typeof k === "string" && typeof p === "number" && p >= 0 && p <= 1).slice(0, 500);
    return { rule: t.rule, days: t.days, limit: t.limit, in: Object.fromEntries(ins), out: t.out.filter((x) => typeof x === "string").slice(0, 500) };
  } catch {
    return null;
  }
}

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

  const before = id ? ((await g.stub.getFolder(id)) as Folder | null) : null;
  const folderId = (await g.stub.saveFolder({ id, name, rule, plusLabel: usePlus ? plus : null })) as string;

  // "Applies to" (2+ accounts): write the same folder and rule into every
  // checked account, and remove it from the ones that were unchecked. Each
  // account is authorized on its own; a folder is matched by its old name.
  const seen = f.getAll("also_seen").map(String);
  const checked = new Set(f.getAll("also").map(String));
  const origName = String(f.get("orig_name") ?? "").trim() || name;
  const { userId, orgId } = ctx.locals.auth();
  const touched: { address: string; folderId: string }[] = [{ address: g.address, folderId }];
  for (const other of seen) {
    if (other === g.address) continue;
    const access = await openMailbox(env, { userId: userId!, orgId: orgId! }, other);
    if (!access.ok) continue;
    const match = ((await access.stub.folderByName(origName)) as Folder | null) ?? (origName !== name ? ((await access.stub.folderByName(name)) as Folder | null) : null);
    if (checked.has(other)) {
      const otherId = (await access.stub.saveFolder({ id: match?.id, name, rule, plusLabel: match?.plus_label ?? null })) as string;
      touched.push({ address: access.address, folderId: otherId });
    } else if (match) {
      await access.stub.deleteFolder(match.id);
    }
  }

  let note = touched.length > 1 ? ` Saved to ${touched.length} accounts.` : "";
  let sorted = false;
  if (f.get("apply") === "1") {
    const window = { days: clamp(f.get("days"), SORT_WINDOW.days, 1, 365), limit: clamp(f.get("limit"), SORT_WINDOW.limit, 1, 500) };
    const look = new Set(f.getAll("look").map(String));
    // Its own mail is only sorted again when the rule changed.
    if (before && before.rule.trim() === rule) look.delete(folderId);
    const tested = parseTested(f.get("tested"));
    // Where to look is picked in this account; other accounts use the
    // folders with the same names.
    const lookNames = new Set(((await g.stub.listFolders()) as FolderWithCounts[]).filter((x) => look.has(x.id)).map((x) => x.name.trim().toLowerCase()));
    if (look.has(folderId)) lookNames.add(name.trim().toLowerCase());
    const moved: Record<string, number> = {};
    let checking = 0;
    for (const t of touched) {
      const places: (string | null)[] = look.has("messages") ? [null] : [];
      if (t.address === g.address) places.push(...[...look].filter((k) => k !== "messages"));
      else {
        const theirs = (await mailboxStub(env, t.address).listFolders()) as FolderWithCounts[];
        places.push(...theirs.filter((x) => lookNames.has(x.name.trim().toLowerCase())).map((x) => x.id));
      }
      if (places.length === 0) continue;
      const out = await sortInto(env, t.address, t.folderId, {
        places, ...window, tested: t.address === g.address ? tested : null, background: (w) => waitUntil(w),
      });
      for (const [k, n] of Object.entries(out.moved)) moved[t.address === g.address ? k : "other"] = (moved[t.address === g.address ? k : "other"] ?? 0) + n;
      checking += out.checking;
    }
    const names = new Map(((await g.stub.listFolders()) as FolderWithCounts[]).map((x) => [x.id, x.name]));
    const total = Object.values(moved).reduce((a, n) => a + n, 0);
    const from = Object.entries(moved).map(([k, n]) => `${n} from ${k === "messages" ? "Messages" : k === "other" ? "your other accounts" : names.get(k) ?? "a folder"}`);
    if (total > 0) note += ` ${total} moved here: ${from.join(", ")}.`;
    if (checking > 0) note += ` Checking ${checking} more email${checking === 1 ? "" : "s"} from the last ${window.days} day${window.days === 1 ? "" : "s"}.`;
    if (total === 0 && checking === 0) note += " No mail needed to move.";
    sorted = total + checking > 0;
  }
  const text = encodeURIComponent(`${id ? "Saved" : "Created"} ${name}.${note}`);
  // With 2+ accounts, land on the merged folder in the combined list.
  if (seen.length > 0) return ctx.redirect(`/mail?folder=${encodeURIComponent(name)}&ok=${text}`, 303);
  return ctx.redirect(`${b}?folder=${folderId}&ok=${text}${sorted ? `&sorted=${folderId}` : ""}`, 303);
};
