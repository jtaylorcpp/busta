import { clerkMiddleware } from "@clerk/astro/server";
import { defineMiddleware, sequence } from "astro:middleware";
import { LAST_MAILBOX_COOKIE } from "./lib/mail-data";

/**
 * Clerk session state for every Astro-rendered page (Astro.locals.auth()).
 * The old router in ../src authenticates separately with @clerk/backend; both
 * read the same Clerk cookies, so a session is shared across the two.
 */
const clerk = clerkMiddleware();

/**
 * Remember the last mailbox opened, so / can go straight back to it. Only a
 * hint: / checks it against the org's own mailbox list before using it.
 */
const rememberMailbox = defineMiddleware(async (ctx, next) => {
  const match = ctx.request.method === "GET" && ctx.url.pathname.match(/^\/mb\/([^/]+)/);
  if (match && ctx.locals.auth().userId) {
    ctx.cookies.set(LAST_MAILBOX_COOKIE, decodeURIComponent(match[1]!), {
      path: "/",
      httpOnly: true,
      secure: ctx.url.protocol === "https:",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return next();
});

export const onRequest = sequence(clerk, rememberMailbox);
