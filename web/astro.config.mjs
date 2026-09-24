// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare({
    // No Cloudflare Images binding: images are served as-is.
    imageService: 'passthrough',
  }),
  // No KV-backed Astro sessions: auth state lives in Clerk's cookies.
  session: false,
});
