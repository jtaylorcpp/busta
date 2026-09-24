/**
 * GET /llms.txt — the site as Markdown for language models (llms.txt
 * convention). Same text as the landing page's LLM view.
 */
import type { APIRoute } from "astro";
import { LLMS_MD } from "../lib/llms";

export const GET: APIRoute = () =>
  new Response(LLMS_MD, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-robots-tag": "noindex",
    },
  });
