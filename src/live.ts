/**
 * GET /mb/<address>/live — WebSocket upgrade for live page updates.
 *
 * Same gate as every page: a Clerk session, an active org, and the mailbox
 * owned by that org. Plus an Origin check: browsers send cookies on a
 * cross-site WebSocket handshake, so without it any site could open a socket
 * as the signed-in user (cross-site WebSocket hijacking). The socket itself
 * only carries "something changed" notices; pages refetch through the normal,
 * authenticated routes.
 */
import { authenticate } from "./auth";
import { authorizeMailbox } from "./index";

export async function liveSocket(request: Request, env: Env, rawAddress: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return new Response("Cross-origin WebSocket refused", { status: 403 });
  }

  const auth = await authenticate(request, env);
  // A socket can't follow Clerk's handshake redirect; the page will reconnect
  // after its next normal navigation refreshes the session.
  if (auth.kind !== "session" || !auth.session.orgId) return new Response("Sign in again", { status: 401 });

  const access = await authorizeMailbox(env, auth.session, rawAddress);
  if (!access.ok) return new Response(access.message, { status: access.status });

  return access.stub.fetch(request);
}
