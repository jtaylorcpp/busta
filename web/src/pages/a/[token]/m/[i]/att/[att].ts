/** /a/<token>/m/<n>/att/<id> — an attachment of a cited email, within the answer's session. */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { attachmentResponse, loadLinkedMessage, openLink } from "../../../../../../lib/links";

export const GET: APIRoute = async (ctx) => {
  const record = await openLink(env, ctx.params.token!, ctx.cookies);
  const cite = record?.kind === "answer" ? record.cites?.[Number(ctx.params.i)] : undefined;
  if (!record || !cite) return new Response("Not found", { status: 404 });
  const linked = await loadLinkedMessage(env, record.orgId, cite.address, cite.messageId);
  return linked ? attachmentResponse(env, linked, decodeURIComponent(ctx.params.att!)) : new Response("Not found", { status: 404 });
};
