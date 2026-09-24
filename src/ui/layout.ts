import { escapeHtml } from "../mail";

/*
 * What remains of the Worker-rendered UI: the single-mailbox switch and the
 * pinned Clerk bundles used by the sign-out page. Everything visual is Astro.
 */

/**
 * Whether an organization may hold more than one mailbox.
 *
 * Off: one login, one address, provisioned from the username at sign-up.
 *
 * Deliberately a single switch read by BOTH the page and the route that
 * accepts claims. Hiding the form alone would leave `POST /mailboxes` open to
 * anyone willing to send the request by hand — a policy that only exists in
 * the markup is not a policy. Flip this to restore the feature.
 */
export const MULTI_MAILBOX = false;

/**
 * clerk-js is two bundles, not one.
 *
 * As of clerk-js 6, `clerk.browser.js` is the headless core only — ~300 KB of
 * session and API machinery with no rendering in it at all. Every widget lives
 * in a separate package, `@clerk/ui`, whose browser build registers itself on
 * `window.__internal_ClerkUICtor`. The core never looks at that global: it
 * wires up components only from the `clerkUICtor` option passed to
 * `Clerk.load()`.
 *
 * Load the core alone and everything authenticates correctly — `Clerk.load()`
 * resolves, the session is real — and then every `mount*()` call throws
 * "Clerk was not loaded with Ui components", leaving a blank box where the
 * sign-in form should be. The failure is entirely at render time, which is why
 * it survives any check that only asks whether the script and the key loaded.
 *
 * Both versions are pinned exactly. The floating `@6` range is precisely how
 * this broke: the UI split landed inside the major, so a range that was correct
 * when written silently stopped rendering. Bump these together, and load the
 * page afterwards — a typecheck cannot see this class of break.
 */
export const CLERK_CDN = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.33.0/dist/clerk.browser.js";
export const CLERK_UI_CDN = "https://cdn.jsdelivr.net/npm/@clerk/ui@1.34.0/dist/ui.browser.js";

/**
 * Script tags for both bundles. `async` is safe here because nothing runs off
 * them directly — `loadClerk()` below waits for both to arrive.
 */
export function clerkScripts(publishableKey: string): string {
  return `<script src="${CLERK_CDN}" data-clerk-publishable-key="${escapeHtml(
    publishableKey,
  )}" crossorigin="anonymous" async></script>
<script src="${CLERK_UI_CDN}" crossorigin="anonymous" async></script>`;
}

/**
 * Defines `loadClerk()`: resolves once Clerk is loaded *with* its UI, so the
 * caller can mount immediately. Every page uses this rather than calling
 * `Clerk.load()` directly, so the UI constructor cannot be forgotten on one
 * page and remembered on the others.
 */
export const CLERK_BOOTSTRAP = `<script>
  async function loadClerk() {
    // Both tags are async, so neither global is guaranteed by any one event.
    // Poll briefly rather than racing them.
    const deadline = Date.now() + 15000;
    while (!(window.Clerk && window.__internal_ClerkUICtor)) {
      if (Date.now() > deadline) {
        throw new Error(
          "clerk-js did not load within 15s (Clerk=" + !!window.Clerk +
          ", ClerkUI=" + !!window.__internal_ClerkUICtor + ")"
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!window.Clerk.loaded) {
      await window.Clerk.load({ clerkUICtor: window.__internal_ClerkUICtor });
    }
    return window.Clerk;
  }
</script>`;
