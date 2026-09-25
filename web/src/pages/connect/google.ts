/**
 * GET /connect/google?days=30&copy=1 — leave for Google's sign-in to connect
 * a Gmail account (designs/2026-09-24-connect-gmail, screens 5-6).
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { authUrl, googleMissing, pkceChallenge, randomToken } from "../../../../src/sources/google";
import { redirectUri, setTicket } from "../../lib/connect";

const DAYS = new Set([7, 30, 90, 365]);

export const GET: APIRoute = async (ctx) => {
  const { userId, orgId } = ctx.locals.auth();
  if (!userId) return ctx.redirect("/sign-in", 303);
  if (!orgId) return ctx.redirect("/", 303);
  if (googleMissing(env).length) return ctx.redirect(`/connect/gmail?error=${encodeURIComponent("Gmail isn't set up on this server yet.")}`, 303);

  const days = Number(ctx.url.searchParams.get("days"));
  const state = randomToken(16);
  const verifier = randomToken(48);
  await setTicket(ctx.cookies, env.THREAD_SECRET, {
    state, verifier, userId, orgId,
    days: DAYS.has(days) ? days : 30,
    copyFolders: ctx.url.searchParams.get("copy") === "1",
  }, ctx.url.protocol === "https:");
  return ctx.redirect(authUrl(env, {
    redirectUri: redirectUri(ctx.url),
    state,
    challenge: await pkceChallenge(verifier),
    loginHint: ctx.url.searchParams.get("account") ?? undefined,
  }), 302);
};
