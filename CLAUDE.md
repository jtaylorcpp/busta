# Busta — how we work

Busta (busta.app) is a multi-tenant email service: one Cloudflare Worker
(`web/src/worker.ts`) serving an Astro UI, with Durable Objects for mailboxes,
threads and tenants in `src/`. `web/CLAUDE.md` covers Astro itself.

## Every feature: mock → approve → archive → build → ship

1. **Mock it first, as a Claude artifact.** No feature code before the design
   is approved. Build the mock on the existing design: copy the tokens and app
   shell from the latest mockup in `designs/` so it looks like the real app.
   Use real data when there is some (the user's actual mail and rules), show
   light and dark, give each screen or state a tab, and put the decisions
   that need a yes in the "notes" cards. Share the link, then iterate on the
   same artifact (republish the same file) until the user approves.
2. **Archive the approved design** before building:
   - `designs/<YYYY-MM-DD>-<slug>/index.html`, a self-contained copy with a
     header comment naming the version, approval date and artifact link.
   - Add a row to the table in `designs/README.md` (date, design, what it
     covers, artifact link, where it's built).
   - Anything decided after approval goes under "Where the build differs
     from a mockup" in that README. The code is the source of truth.
3. **Build it** to match the mock, using the design tokens
   (`web/src/styles/tokens.css`) and existing components (`web/src/components/ui`).
   Interactivity goes in Preact islands (`web/src/components/islands`); pages
   should still work without JavaScript where they can. New Astro-owned
   paths must be added to `ASTRO_ROUTES` / `ASTRO_GET_ROUTES` in
   `web/src/worker.ts`, or the old router answers them.
4. **Test it.**
   - `npm run typecheck` (root) and `npx astro check` (in `web/`) must pass.
   - Locally: `npx astro dev --port 8787 --background` in `web/`, with
     `/__dev/claim` and `/__dev/inbound` to create mailboxes and mail. Local
     Clerk doesn't work, so tests use a **temporary** middleware override
     (`x-test-org` header or cookie) in `web/src/middleware.ts` and, for the
     old router, live sockets and form posts, in `authenticate()` in
     `src/auth.ts`. Save the real files first and restore them before committing. A
     test override must never be committed: grep for `TEMPORARY` / `x-test-`
     before every commit.
   - Workers AI only runs remotely, so AI features are verified in production.
     So does Gmail: Google's sign-in pages can't be driven from Chrome here,
     so the user clicks through consent. Watch production with
     `npx wrangler tail --format pretty`.
5. **Ship it.** Make small, discrete commits (archive the design, groundwork,
   the feature, each fix). Then `npm run deploy`, verify in production in real
   Chrome against the user's mailbox, and `git push` (origin `main`). Report
   what was verified, and what wasn't.

## Guardrails

- Ask before anything that sends email, or that changes the user's real data
  (their rules, folders, mail), unless they asked for exactly that.
- Never commit secrets. `.dev.vars` and `.env` are gitignored.
- Colors keep their meaning: red only for unread counts, amber for in flight
  or waiting, crimson only for a real error, green for success, violet for
  the agent.
