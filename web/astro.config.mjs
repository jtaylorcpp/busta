// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import clerk from '@clerk/astro';
import preact from '@astrojs/preact';
import { bustaAppearance } from './src/lib/clerk-appearance.ts';

// https://astro.build/config
export default defineConfig({
  // Every page is rendered on request. Prerendered pages would be served as
  // static assets ahead of the Worker, bypassing auth and the route table in
  // src/worker.ts.
  output: 'server',
  adapter: cloudflare({
    // The repo-root wrangler.jsonc stays the single deploy config: bindings,
    // Durable Object migrations, routes and vars all live there.
    configPath: '../wrangler.jsonc',
    // Share local DO/R2 state with the Worker's existing dev data.
    persistState: { path: '../.wrangler/state' },
    // No Cloudflare Images binding: images are served as-is.
    imageService: 'passthrough',
  }),
  integrations: [
    // Clerk's components and middleware. Reads PUBLIC_CLERK_PUBLISHABLE_KEY
    // and CLERK_SECRET_KEY from the Worker env at request time.
    clerk({
      appearance: bustaAppearance,
      signInUrl: '/sign-in',
    }),
    // Islands: small interactive pieces hydrated on the client (e.g. search's
    // load-more). Everything else ships no JavaScript.
    preact(),
  ],
  // No KV-backed Astro sessions: auth state lives in Clerk's cookies.
  session: false,
});