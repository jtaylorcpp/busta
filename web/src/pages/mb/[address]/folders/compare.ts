/**
 * POST /mb/<address>/folders/compare — JSON {name, before, after, include?}
 * → how two versions of a folder's rule judge your 20 newest received
 * messages (plus `include`, a message id, first): [{id, from, subject,
 * before: {in, p}, after: {in, p}, changed}]. Read-only. Used by "Check it"
 * after adding keywords and by Tidy up's "Does it still mean the same?".
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { threadStub } from "../../../../../../src/mail";
import { FOLDER_THRESHOLD } from "../../../../../../src/folders";
import type { IndexedMessage } from "../../../../../../src/mailbox-do";
import { gate } from "../../../../lib/actions";

const RECENT = 20;

/** Run tasks a few at a time. */
async function pool<T>(tasks: (() => Promise<T>)[], size = 8): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    for (let i = next++; i < tasks.length; i = next++) out[i] = await tasks[i]!();
  }));
  return out;
}

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { name, before, after, include } = (await ctx.request.json()) as { name?: string; before?: string; after?: string; include?: string };
  if (!before?.trim() || !after?.trim()) return Response.json({ error: "Both versions of the rule are needed." }, { status: 400 });
  const recent = (await g.stub.recentReceived(RECENT)) as IndexedMessage[];
  const first = include ? ((await g.stub.lookup(include)) as IndexedMessage | null) : null;
  const rows = [...(first ? [first] : []), ...recent.filter((r) => r.id !== first?.id)].slice(0, RECENT + 1);
  const label = (name ?? "").trim() || "This folder";
  const score = async (m: IndexedMessage, rule: string) => {
    const out = await threadStub(env, g.address, m.thread_id).classify(m.id, [{ id: "test", name: label, rule: rule.slice(0, 2000) }]);
    const p = out.probabilities.test ?? (out.folderId ? out.probability : 0);
    return { in: out.folderId === "test" && p >= FOLDER_THRESHOLD, p };
  };
  const results = await pool(rows.map((m) => async () => {
    const base = { id: m.id, from: m.from_name || m.sender, subject: m.subject, date: m.received_at, this: m.id === first?.id };
    try {
      const [b, a] = await Promise.all([score(m, before), score(m, after)]);
      return { ...base, before: b, after: a, changed: b.in !== a.in };
    } catch (e) {
      return { ...base, error: String(e).slice(0, 200) };
    }
  }));
  return Response.json({ threshold: FOLDER_THRESHOLD, results }, { headers: { "cache-control": "no-store" } });
};
