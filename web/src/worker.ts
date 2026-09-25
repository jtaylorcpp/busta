/**
 * The one Worker behind busta.app, mid-migration from string-rendered pages
 * to Astro.
 *
 * Everything the old Worker exports is re-exported unchanged: inbound mail
 * (`email`) and the Durable Object classes. The
 * DO classes must stay exported from this script under the same names, or
 * their stored data is orphaned.
 *
 * Web requests go to Astro only for paths it has taken over (ASTRO_ROUTES);
 * everything else still goes to the old router in ../../src. Move a page by
 * adding its path here and deleting its string renderer from src/ui/pages.ts.
 */
import { handle } from "@astrojs/cloudflare/handler";
import legacy from "../../src/index";
import { liveSocket } from "../../src/live";
import { gmailPush } from "../../src/sources/push";

export { ImportDO, MailboxDO, TenantDO, ThreadDO } from "../../src/index";

/** Paths Astro owns in every environment, for any method. */
const ASTRO_ROUTES: RegExp[] = [
  /^\/sign-in\/?$/,
  /^\/accounts(\/[a-z]+)?\/?$/, // accounts: settings page, show / hide, color, disconnect
  /^\/connect\/(gmail|google)\/?$/, // Connect Gmail: the page, then off to Google
  /^\/oauth\/google\/callback\/?$/, // back from Google
  /^\/mb\/[^/]+\/folders(\/.*)?$/, // folders: list, editor, save/delete/move/test
  /^\/mb\/[^/]+\/start(\/.*)?$/, // Getting started guide: steps + progress actions
  /^\/mb\/[^/]+\/[0-9a-f-]{36}\/folder(\/retry)?\/?$/i, // file a message by hand / retry sorting
  /^\/mb\/[^/]+\/[0-9a-f-]{36}\/why(\/save)?\/?$/i, // why not this folder: explain, save the new rule
];

/**
 * Paths Astro renders for GET only. Their form posts (star, trash, reply, …)
 * and sub-resources (/body, /att/*) stay with the original handlers.
 */
const ASTRO_GET_ROUTES: RegExp[] = [
  /^\/$/, // home: landing page when signed out; else your mailbox / setup / org picker
  /^\/llms\.txt$/, // the site as Markdown for language models
  /^\/privacy\/?$/, // privacy policy (public; registered with Google)
  /^\/mail\/?$/, // every shown account in one list
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
    // Live-update sockets go straight to the mailbox's Durable Object after
    // the auth + ownership + origin checks in src/live.ts.
    const live = path.match(/^\/mb\/([^/]+)\/live\/?$/);
    if (live && request.method === "GET") return liveSocket(request, env, live[1]!);
    // Gmail's Pub/Sub alerts: signed by Google, checked in src/sources/push.ts.
    if (path === "/hooks/gmail" && request.method === "POST") return gmailPush(request, env, ctx);
    return astroOwns(request.method, path, env) ? handle(request, env, ctx) : legacy.fetch(request, env, ctx);
  },
  email: legacy.email,
} satisfies ExportedHandler<Env>;
