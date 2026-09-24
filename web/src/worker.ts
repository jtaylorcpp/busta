/**
 * The one Worker behind busta.app, mid-migration from string-rendered pages
 * to Astro.
 *
 * Everything the old Worker exports is re-exported unchanged: inbound mail
 * (`email`), the Durable Object classes and the provisioning Workflow. The
 * DO classes must stay exported from this script under the same names, or
 * their stored data is orphaned.
 *
 * Web requests go to Astro only for paths it has taken over (ASTRO_ROUTES);
 * everything else still goes to the old router in ../../src. Move a page by
 * adding its path here and deleting its string renderer from src/ui/pages.ts.
 */
import { handle } from "@astrojs/cloudflare/handler";
import legacy from "../../src/index";

export { MailboxDO, MailboxProvisionWorkflow, TenantDO, ThreadDO } from "../../src/index";

/** Paths Astro owns in every environment, for any method. */
const ASTRO_ROUTES: RegExp[] = [/^\/sign-in\/?$/];

/**
 * Paths Astro renders for GET only. Their form posts (star, trash, reply, …)
 * and sub-resources (/body, /att/*) stay with the original handlers.
 */
const ASTRO_GET_ROUTES: RegExp[] = [
  /^\/$/, // home: redirect to your mailbox, or first-run setup / org picker
  /^\/mb\/[^/]+\/?$/, // mailbox list
  /^\/mb\/[^/]+\/[0-9a-f-]{36}\/?$/i, // thread
  /^\/mb\/[^/]+\/search(\/more)?\/?$/, // search + load-more partial
  /^\/mb\/[^/]+\/drafts(\/[0-9a-f-]{36})?\/?$/i, // drafts list + edit
  /^\/mb\/[^/]+\/compose\/?$/, // new / forward
  /^\/mb\/[^/]+\/recipients\/check\/?$/, // compose's bounce-list check
];

/** Paths Astro owns only in local development: the styleguide and mocks. */
const DEV_ONLY_ROUTES: RegExp[] = [/^\/design(\/|$)/];

function astroOwns(method: string, path: string, env: Env): boolean {
  if (ASTRO_ROUTES.some((r) => r.test(path))) return true;
  if ((method === "GET" || method === "HEAD") && ASTRO_GET_ROUTES.some((r) => r.test(path))) return true;
  return env.ENVIRONMENT === "development" && DEV_ONLY_ROUTES.some((r) => r.test(path));
}

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    return astroOwns(request.method, path, env) ? handle(request, env, ctx) : legacy.fetch(request, env, ctx);
  },
  email: legacy.email,
} satisfies ExportedHandler<Env>;
