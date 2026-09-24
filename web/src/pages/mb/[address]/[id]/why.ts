/**
 * POST /mb/<address>/<id>/why — JSON {folderId, fresh?} → why this message
 * isn't in that folder: the folder's score (from the filing model), the
 * rule's closest sentences with reasons, the email words that mattered, and
 * keywords + a sentence to add (from a text model; see src/explain.ts).
 * Cached on the message until the rule changes.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { threadStub } from "../../../../../../src/mail";
import { FOLDER_THRESHOLD } from "../../../../../../src/folders";
import { ruleSentences } from "../../../../../../src/explain";
import type { Folder, IndexedMessage } from "../../../../../../src/mailbox-do";
import { gate } from "../../../../lib/actions";

export const POST: APIRoute = async (ctx) => {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { folderId, fresh } = (await ctx.request.json()) as { folderId?: string; fresh?: boolean };
  const m = (await g.stub.lookup(ctx.params.id!)) as IndexedMessage | null;
  if (!m || m.direction !== "in") return Response.json({ error: "Message not found." }, { status: 404 });
  const folder = folderId ? ((await g.stub.getFolder(folderId)) as Folder | null) : null;
  if (!folder) return Response.json({ error: "That folder no longer exists." }, { status: 404 });
  if (!folder.rule.trim()) return Response.json({ error: `${folder.name} has no rule to explain. It only catches its +address.` }, { status: 400 });

  const thread = threadStub(env, g.address, m.thread_id);
  const probs = m.folder_probs ? (JSON.parse(m.folder_probs) as Record<string, number>) : {};
  let score: number | null = probs[folder.id] ?? (m.folder_suggest === folder.id ? m.folder_confidence : null);
  try {
    // Not among the stored top scores: score this folder alone.
    if (score === null) score = (await thread.classify(m.id, [folder])).probabilities[folder.id] ?? 0;
    const { explanation, email } = await thread.explain(m.id, g.address, folder, score, !!fresh);
    return Response.json(
      {
        folder: { id: folder.id, name: folder.name, rule: folder.rule, sentences: ruleSentences(folder.rule) },
        score,
        none: probs.none ?? null,
        threshold: FOLDER_THRESHOLD,
        filedHere: m.folder_id === folder.id,
        explanation,
        email,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error("explain failed", { id: m.id, error: String(e) });
    return Response.json({ error: "Couldn't explain this one right now. Try again in a moment." }, { status: 502 });
  }
};
