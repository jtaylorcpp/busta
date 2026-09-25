/**
 * POST /hooks/gmail — Gmail's new-mail alerts, pushed by Pub/Sub.
 *
 * The request must carry Google's signed token for our push service account
 * and this URL. The body only says "this account changed, around historyId";
 * the mailbox's alarm then asks Gmail what actually changed. So a forged or
 * replayed alert can at most cause an extra sync.
 *
 * Always answers 204 once verified, even for an account we don't know:
 * anything else makes Pub/Sub retry a message that will never succeed.
 */
import { normalizeAddress } from "../addressing";
import { mailboxStub } from "../mail";
import { verifyPushJwt } from "./google";

export async function gmailPush(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const audience = `${new URL(request.url).origin}/hooks/gmail`;
  if (!(await verifyPushJwt(env, request.headers.get("authorization"), audience))) {
    return new Response("Unauthorized", { status: 401 });
  }
  let address = "";
  try {
    const body = (await request.json()) as { message?: { data?: string } };
    const data = JSON.parse(atob(body.message?.data ?? "")) as { emailAddress?: string };
    address = normalizeAddress(data.emailAddress ?? "");
  } catch {
    return new Response(null, { status: 204 });
  }
  if (address) ctx.waitUntil(mailboxStub(env, address).gmailPushed().catch((e) => console.error("gmail push failed", address, String(e))));
  return new Response(null, { status: 204 });
}
