import { escapeHtml } from "../mail";

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

/**
 * Renders a load failure where the widget would have been. Without this a
 * broken CDN, a blocked request, or a version mismatch all present as an empty
 * rectangle with the reason only in the console.
 */
export function clerkFallback(nodeId: string): string {
  return `function clerkFailed(e) {
    console.error("clerk-js failed", e);
    const el = document.getElementById(${JSON.stringify(nodeId)});
    if (el) {
      el.innerHTML = "<p><b>Sign-in is unavailable.</b></p><p>The authentication " +
        "widget could not be loaded. Check your connection and reload.</p>" +
        "<pre style='white-space:pre-wrap'></pre>";
      el.querySelector("pre").textContent = String(e && e.message || e);
    }
  }`;
}

export const STYLES = `
:root {
  --silver: #c0c0c0;
  --face:   #d4d0c8;
  --shadow: #808080;
  --dark:   #404040;
  --navy:   #000080;
  --navy2:  #1084d0;
  --paper:  #ffffff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 12px;
  background: var(--silver);
  color: #000;
  font: 13px "MS Sans Serif", Tahoma, Geneva, Verdana, sans-serif;
}
a { color: #0000ee; }
a:visited { color: #551a8b; }
a:hover { color: #ee0000; }

/* --- Win95 bevels ------------------------------------------------ */
.raised { border: 2px solid; border-color: #fff var(--dark) var(--dark) #fff; background: var(--face); }
.sunken { border: 2px solid; border-color: var(--dark) #fff #fff var(--dark); background: var(--paper); }

.window { max-width: 980px; margin: 0 auto 14px; }
.titlebar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 3px 4px; margin: 2px;
  background: linear-gradient(90deg, var(--navy), var(--navy2));
  color: #fff; font-weight: bold; letter-spacing: .02em;
}
.titlebar .buttons { display: flex; gap: 2px; }
.titlebar .buttons span {
  width: 16px; height: 14px; background: var(--face);
  border: 1px solid; border-color: #fff var(--dark) var(--dark) #fff;
  font: 10px/12px "MS Sans Serif", sans-serif; text-align: center; color: #000;
}
.window-body { padding: 10px; }

/* --- menu bar ---------------------------------------------------- */
.menubar {
  display: flex; gap: 2px; padding: 2px 4px; margin: 0 2px;
  border-bottom: 1px solid var(--shadow);
}
.menubar a { color: #000; text-decoration: none; padding: 2px 7px; }
.menubar a:hover { background: var(--navy); color: #fff; }
.menubar .spacer { flex: 1; }
.menubar .who { color: var(--dark); padding: 2px 4px; }
.menubar .account { display: flex; align-items: center; gap: 6px; }
.menubar .account #clerk-user { display: flex; align-items: center; }
.menubar a.signout { color: #000; text-decoration: none; padding: 2px 7px; }
.menubar a.signout:hover { background: #800000; color: #fff; }

/* --- inbox table -------------------------------------------------- */
table.mail { width: 100%; border-collapse: collapse; background: var(--paper); font-size: 12px; }
table.mail th {
  background: var(--face); text-align: left; padding: 3px 6px; font-weight: bold;
  border: 2px solid; border-color: #fff var(--dark) var(--dark) #fff;
  white-space: nowrap;
}
table.mail td { padding: 3px 6px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
table.mail tr:nth-child(even) td { background: #f4f4f4; }
table.mail tr:hover td { background: #000080; color: #fff; }
table.mail tr:hover td a, table.mail tr:hover td .snippet { color: #fff; }
table.mail tr.unread td { font-weight: bold; }
table.mail td a { text-decoration: none; }
table.mail td a:hover { text-decoration: underline; }
.snippet { color: var(--shadow); font-weight: normal; }
table.mail tr.pending td { background: #f4f0e0; color: var(--dark); }
.latched { color: var(--dark); }
.setup { font-size: 10px; padding: 0 4px; background: #806000; color: #fff; margin-left: 4px; }
.setup.failed { background: #a00; cursor: help; }
.col-date, .col-size { white-space: nowrap; text-align: right; color: var(--dark); }
.col-actions { white-space: nowrap; width: 76px; text-align: right; }
.rowform { display: inline; }
.iconbtn {
  font: 11px "MS Sans Serif", Tahoma, sans-serif; padding: 1px 4px; margin-left: 1px;
  background: var(--face); color: #000; cursor: pointer;
  border: 2px solid; border-color: #fff var(--dark) var(--dark) #fff;
}
.iconbtn:active { border-color: var(--dark) #fff #fff var(--dark); }
.iconbtn.danger { color: #a00; font-weight: bold; }
table.mail tr:hover td .iconbtn { color: #000; }
table.mail tr:hover td .iconbtn.danger { color: #a00; }
.badge-new {
  background: #ff0000; color: #fff; font-size: 9px; font-weight: bold;
  padding: 0 3px; margin-right: 4px; vertical-align: 1px;
}
.dir-out { color: #006400; font-weight: bold; }
.delivery {
  font-size: 9px; font-weight: bold; padding: 0 4px; margin-left: 4px;
  vertical-align: 1px; color: #fff; cursor: help;
}
.delivery.bounced, .delivery.failed { background: #a00; }
.delivery.queued { background: #806000; }
.badge-warn {
  background: #b8860b; color: #fff; font-size: 9px; font-weight: bold;
  padding: 0 4px; margin-right: 4px; vertical-align: 1px; cursor: help;
}

/* --- tag chips ---------------------------------------------------- */
.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 8px; }
.chips-label { font-size: 11px; color: var(--dark); margin-right: 2px; }
.chip {
  font-size: 11px; padding: 2px 8px; text-decoration: none; color: #000;
  background: var(--face);
  border: 2px solid; border-color: #fff var(--dark) var(--dark) #fff;
}
.chip:hover { color: #000; background: #e8e8e8; }
.chip.active { border-color: var(--dark) #fff #fff var(--dark); background: #b8b8b8; }
.chip b { font-weight: bold; }
.tag-chip {
  font-size: 10px; padding: 0 4px; background: #000080; color: #fff;
  font-weight: normal; vertical-align: 1px;
}
.agentbar {
  font-size: 11px; padding: 4px 8px; margin-bottom: 8px;
  background: #ece5f6; border: 2px solid; border-color: var(--dark) #fff #fff var(--dark);
}
.hint { font-size: 11px; color: var(--dark); margin: 10px 0 0; }

/* --- forms -------------------------------------------------------- */
input[type=text], input[type=email], textarea, select {
  font: 12px "Courier New", Courier, monospace;
  padding: 3px; width: 100%;
  border: 2px solid; border-color: var(--dark) #fff #fff var(--dark);
  background: var(--paper);
}
textarea { resize: vertical; min-height: 140px; line-height: 1.45; }
button, .btn {
  font: bold 12px "MS Sans Serif", Tahoma, sans-serif;
  padding: 4px 16px; cursor: pointer; color: #000;
  background: var(--face);
  border: 2px solid; border-color: #fff var(--dark) var(--dark) #fff;
  text-decoration: none; display: inline-block;
}
button:active, .btn:active { border-color: var(--dark) #fff #fff var(--dark); }
label { display: block; margin: 8px 0 3px; font-weight: bold; }

/* --- search bar --------------------------------------------------- */
.searchbar { display: flex; gap: 8px; align-items: center; }
.searchbar input[type=text] { flex: 1; }
.searchbar label.inline { display: flex; align-items: center; gap: 4px; margin: 0; white-space: nowrap; font-weight: normal; font-size: 11px; }
.searchbar input[type=checkbox] { width: auto; }
.filterbar {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  margin-top: 6px; padding: 5px 8px;
  border: 2px solid; border-color: var(--dark) #fff #fff var(--dark);
}
.filterbar label.inline { display: flex; align-items: center; gap: 4px; margin: 0; font-weight: normal; font-size: 11px; }
.filterbar input[type=text] { width: 170px; font-size: 11px; }
.filterbar select { width: auto; font-size: 11px; }
.filterbar input[type=checkbox] { width: auto; }

/* --- message view ------------------------------------------------- */
.headers { padding: 8px; margin-bottom: 10px; font-size: 12px; }
.headers dl { display: grid; grid-template-columns: 90px 1fr; gap: 2px 8px; margin: 0; }
.headers dt { font-weight: bold; color: var(--dark); }
.headers dd { margin: 0; word-break: break-word; }
.body-text {
  padding: 10px; margin-bottom: 10px; min-height: 120px;
  font: 13px/1.55 "Courier New", Courier, monospace; white-space: pre-wrap; word-break: break-word;
}
iframe.body-html {
  width: 100%; min-height: 220px; border: 2px solid;
  border-color: var(--dark) #fff #fff var(--dark); background: var(--paper);
  display: block; margin-bottom: 10px;
}
.notice.imgblock {
  background: #fffbe0; border: 2px solid; border-color: var(--dark) #fff #fff var(--dark);
  font-size: 11px;
}
.thread-item { margin-bottom: 8px; }
.thread-item .from-line { padding: 3px 6px; background: var(--face); border: 1px solid var(--shadow); font-size: 11px; }

/* --- attachments -------------------------------------------------- */
input[type=file] {
  font: 11px "MS Sans Serif", Tahoma, sans-serif; padding: 3px; width: 100%;
  border: 2px solid; border-color: var(--dark) #fff #fff var(--dark); background: var(--paper);
}
fieldset.reattach {
  margin: 10px 0 0; padding: 6px 10px 10px;
  border: 2px solid; border-color: var(--dark) #fff #fff var(--dark);
}
fieldset.reattach legend { font-size: 11px; font-weight: bold; padding: 0 4px; }
fieldset.reattach label.inline {
  display: flex; align-items: center; gap: 5px; margin: 3px 0;
  font-weight: normal; font-size: 11px;
}
fieldset.reattach input[type=checkbox] { width: auto; }

/* --- misc --------------------------------------------------------- */
.statusbar {
  display: flex; gap: 6px; margin: 2px; padding: 0;
}
.statusbar span {
  padding: 2px 6px; font-size: 11px; color: var(--dark);
  border: 1px solid; border-color: var(--shadow) #fff #fff var(--shadow);
}
.statusbar .grow { flex: 1; }
.notice { padding: 8px; margin-bottom: 10px; font-size: 12px; }
.notice.error { background: #ffe0e0; border: 2px solid; border-color: var(--dark) #fff #fff var(--dark); }
.notice.ok { background: #e0ffe0; border: 2px solid; border-color: var(--dark) #fff #fff var(--dark); }
.empty { padding: 30px; text-align: center; color: var(--shadow); font-style: italic; }
hr { border: none; border-top: 1px solid var(--shadow); border-bottom: 1px solid #fff; margin: 12px 0; }
code { font: 12px "Courier New", monospace; background: var(--paper); padding: 1px 4px; border: 1px solid var(--shadow); }
`;

export interface Chrome {
  title: string;
  /** Rendered into the menu bar; omit for signed-out pages. */
  who?: string;
  nav?: { href: string; label: string }[];
  status?: string[];
  head?: string;
  /**
   * Publishable key for the account control. Present on signed-in pages so
   * there is always a visible way to see who you are and sign out — without
   * it the only exit is editing the URL.
   */
  clerkKey?: string;
}

export function layout(chrome: Chrome, body: string): string {
  const nav = (chrome.nav ?? [])
    .map((n) => `<a href="${escapeHtml(n.href)}">${escapeHtml(n.label)}</a>`)
    .join("");

  const account = chrome.clerkKey
    ? `<span class="account">
    <span id="clerk-user"></span>
    <a class="signout" href="/sign-out" title="Sign out">Sign out</a>
  </span>
  ${clerkScripts(chrome.clerkKey)}
  ${CLERK_BOOTSTRAP}
  <script>
    window.addEventListener("load", async () => {
      // Progressive enhancement: the plain Sign out link already works, so a
      // blocked CDN degrades to a usable page rather than a trapped session.
      try {
        const clerk = await loadClerk();
        clerk.mountUserButton(document.getElementById("clerk-user"), {
          afterSignOutUrl: "/sign-in",
        });
      } catch (e) {
        console.warn("clerk-js unavailable", e);
      }
    });
  </script>`
    : `<span class="who">${escapeHtml(chrome.who ?? "")}</span>`;

  const menubar =
    chrome.who || nav
      ? `<div class="menubar">${nav}<span class="spacer"></span>${account}</div>`
      : "";

  const status = (chrome.status ?? []).length
    ? `<div class="statusbar">${(chrome.status ?? [])
        .map((s, i) => `<span class="${i === 0 ? "grow" : ""}">${escapeHtml(s)}</span>`)
        .join("")}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(chrome.title)}</title>
<style>${STYLES}</style>
${chrome.head ?? ""}
</head>
<body>
<div class="window raised">
  <div class="titlebar">
    <span>${escapeHtml(chrome.title)}</span>
    <span class="buttons"><span>_</span><span>□</span><span>×</span></span>
  </div>
  ${menubar}
  <div class="window-body">
${body}
  </div>
  ${status}
</div>
</body>
</html>`;
}

export function windowBox(title: string, body: string): string {
  return `<div class="raised" style="margin-bottom:12px">
  <div class="titlebar"><span>${escapeHtml(title)}</span></div>
  <div class="window-body">${body}</div>
</div>`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "2-digit" });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / 1024 / 1024).toFixed(1)} M`;
}
