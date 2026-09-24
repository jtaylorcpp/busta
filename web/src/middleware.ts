import { clerkMiddleware } from "@clerk/astro/server";

/**
 * Clerk session state for every Astro-rendered page (Astro.locals.auth()).
 * The old router in ../src authenticates separately with @clerk/backend; both
 * read the same Clerk cookies, so a session is shared across the two.
 */
export const onRequest = clerkMiddleware();
