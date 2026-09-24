import { escapeHtml } from "../mail";

/**
 * The only page the Worker still renders itself. Every other view is Astro
 * (web/). This one is served for errors on the routes that remain here —
 * form posts, attachments, and public download links, whose visitors are
 * outside recipients with no session. Self-contained on purpose: it uses the
 * Busta palette (light and dark) without depending on the Astro build.
 */
export function errorPage(status: number, message: string): string {
  const title = status === 404 ? "Not found" : status === 403 ? "Not allowed" : "Something went wrong";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Busta</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root { --bg:#F5F7FB; --surface:#FFFFFF; --border:#E1E6EE; --text:#1C2129; --muted:#5B6472; --primary:#1A5FD0; --on-primary:#FFFFFF; --error:#A8201A; --error-soft:#FCE8E6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111418; --surface:#1B1F26; --border:#2F353F; --text:#E7EAF0; --muted:#9BA4B2; --primary:#8AB2F7; --on-primary:#0A1A38; --error:#FF9B8F; --error-soft:#3B1A18; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 32px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 "Instrument Sans", "Segoe UI", system-ui, -apple-system, sans-serif; }
  main { width: min(100%, 440px); display: grid; gap: 16px; justify-items: start; }
  .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: var(--text); text-decoration: none; }
  .mark { width: 28px; height: 28px; border-radius: 8px; background: var(--primary); color: var(--on-primary); display: grid; place-items: center; font-size: 18px; }
  .card { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; display: grid; gap: 8px; }
  h1 { margin: 0; font-size: 20px; }
  .code { font: 500 12px/1 ui-monospace, "SFMono-Regular", Menlo, monospace; color: var(--muted); }
  p { margin: 0; color: var(--error); background: var(--error-soft); padding: 10px 12px; border-radius: 10px; overflow-wrap: anywhere; }
  a.btn { display: inline-block; padding: 9px 16px; border-radius: 999px; background: var(--primary); color: var(--on-primary); text-decoration: none; font-weight: 600; font-size: 14px; }
</style>
</head>
<body>
<main>
  <a class="brand" href="/"><span class="mark">b</span>Busta</a>
  <div class="card">
    <span class="code">HTTP ${status}</span>
    <h1>${title}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <a class="btn" href="/">Go to Busta</a>
</main>
</body>
</html>`;
}
