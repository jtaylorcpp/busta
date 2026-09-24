import { createClerkClient } from "@clerk/backend";

export interface Session {
  userId: string;
  orgId: string | null;
  orgSlug: string | null;
  orgRole: string | null;
}

export type AuthResult =
  | { kind: "session"; session: Session; headers: Headers }
  | { kind: "signed-out"; headers: Headers }
  /** Clerk wants a browser round-trip; the response is already built. */
  | { kind: "redirect"; response: Response };

let cached: ReturnType<typeof createClerkClient> | null = null;

function clerk(env: Env) {
  if (!cached) {
    cached = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
  }
  return cached;
}

/**
 * Authenticate a request against Clerk.
 *
 * The shape here follows Clerk's own framework SDKs rather than the obvious
 * reading of the docs, because three things are easy to get wrong and all of
 * them produce the same miserable symptom — an endless sign-in loop:
 *
 *   1. A `Location` header means redirect, *whatever* the status says. It is
 *      not exclusive to the handshake state.
 *   2. Handshake with no `Location` is a real error. Returning an empty 200
 *      leaves the user on a blank page with nothing to act on.
 *   3. `state.headers` carries Set-Cookie even on success. Dropping it on the
 *      happy path means the refreshed session cookie is never written, so the
 *      next request handshakes again, forever.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const state = await clerk(env).authenticateRequest(request, {
    authorizedParties: [new URL(request.url).origin],
  });

  if (state.headers.get("location")) {
    return {
      kind: "redirect",
      response: new Response(null, { status: 307, headers: state.headers }),
    };
  }

  if (state.status === "handshake") {
    throw new Error(
      "Clerk returned handshake status with no redirect. This usually means " +
        "CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are from different Clerk " +
        "instances, or the request origin is not allowed for this instance.",
    );
  }

  const auth = state.toAuth();
  if (!auth || !auth.isAuthenticated || !("userId" in auth) || !auth.userId) {
    return { kind: "signed-out", headers: state.headers };
  }

  return {
    kind: "session",
    headers: state.headers,
    session: {
      userId: auth.userId,
      orgId: ("orgId" in auth ? auth.orgId : null) ?? null,
      orgSlug: ("orgSlug" in auth ? auth.orgSlug : null) ?? null,
      orgRole: ("orgRole" in auth ? auth.orgRole : null) ?? null,
    },
  };
}

/**
 * Copy Clerk's Set-Cookie headers onto our own response.
 *
 * Every other header from the auth state is Clerk's business, not ours —
 * copying them wholesale would clobber our content-type and cache-control.
 */
export function withAuthCookies(response: Response, headers: Headers): Response {
  const cookies = headers.getAll("set-cookie");
  if (cookies.length === 0) return response;

  const merged = new Headers(response.headers);
  for (const cookie of cookies) merged.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

/**
 * The user's Clerk username, which is also their mailbox name.
 *
 * Not read from the session token: `username` is not a default JWT claim, and
 * adding it to a custom claim would mean the address could be stale for the
 * life of a token. This is called once per tenant, on first sign-in only.
 */
export async function clerkUsername(env: Env, userId: string): Promise<string | null> {
  const user = await clerk(env).users.getUser(userId);
  return user.username ?? null;
}
