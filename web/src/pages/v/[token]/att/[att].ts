/** /v/<token>/att/<id> — an attachment of the linked email, within its session. */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { attachmentResponse, loadLinkedMessage, openLink } from "../../../../lib/links";

export const GET: APIRoute = async (ctx) => {
  const record = await openLink(env, ctx.params.token!, ctx.cookies);
  if (record?.kind !== "email" || !record.address || !record.messageId) return new Response("Not found", { status: 404 });
  const linked = await loadLinkedMessage(env, record.orgId, record.address, record.messageId);
  return linked ? attachmentResponse(env, linked, decodeURIComponent(ctx.params.att!)) : new Response("Not found", { status: 404 });
};
