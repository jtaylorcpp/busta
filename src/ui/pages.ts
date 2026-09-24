import { escapeHtml } from "../mail";
import type { AgentConfig, Draft, IndexedMessage } from "../mailbox-do";
import type { BodySource, ThreadAttachment, ThreadMessage } from "../thread-do";
import type { TenantMailbox } from "../tenant-do";
import {
  CLERK_BOOTSTRAP,
  MULTI_MAILBOX,
  clerkFallback,
  clerkScripts,
  formatDate,
  formatSize,
  layout,
  windowBox,
} from "./layout";

const BODY_SOURCE_LABEL: Record<BodySource, string> = {
  hot: "Local copy",
  archive: "Retrieved from R2 archive",
  raw: "Rebuilt from archived MIME",
};

function clerkHead(publishableKey: string): string {
  return `${clerkScripts(publishableKey)}
${CLERK_BOOTSTRAP}`;
}

/**
 * Signed in, but no organization is active. Tenancy is org-scoped, so there is
 * nothing to show until one is selected or created.
 */
export function chooseOrgPage(publishableKey: string, userId: string): string {
  return layout(
    {
      title: "CloudMail 95 — Select Organization",
      who: userId,
      head: clerkHead(publishableKey),
      status: ["No organization selected"],
    },
    `<p style="margin-top:0">Every mailbox belongs to an organization. Pick one, or create a new one.</p>
<hr>
<div id="clerk-org" class="sunken" style="padding:10px;min-height:360px"></div>
<p><a class="btn" href="/sign-out">Sign out</a></p>
<script>
  ${clerkFallback("clerk-org")}
  window.addEventListener("load", async () => {
    try {
      const clerk = await loadClerk();
      clerk.mountOrganizationList(document.getElementById("clerk-org"), {
        afterSelectOrganizationUrl: "/",
        afterCreateOrganizationUrl: "/",
        hidePersonal: true,
      });
    } catch (e) { clerkFailed(e); }
  });
</script>`,
  );
}

export function mailboxesPage(opts: {
  orgLabel: string;
  userId: string;
  clerkKey: string;
  domain: string;
  mailboxes: TenantMailbox[];
  /** Any mailbox still provisioning — the page refreshes itself until none are. */
  pending: boolean;
  /**
   * System report mailboxes this user is permitted to take over. Empty for
   * everyone who is not on the admin allowlist, so the panel simply does not
   * exist for ordinary users rather than appearing and refusing.
   */
  adoptable?: string[];
  notice?: { kind: "ok" | "error"; text: string };
}): string {
  // A mailbox is latched until provisioning finishes. Letting someone open a
  // half-provisioned address would show an empty, perfectly normal-looking
  // inbox whose ownership is not yet settled.
  const rows = opts.mailboxes.length
    ? opts.mailboxes
        .map((m) => {
          const ready = m.status === "ready";
          const name = ready
            ? `<a href="/mb/${encodeURIComponent(m.address)}"><b>${escapeHtml(m.address)}</b></a>`
            : `<b class="latched">${escapeHtml(m.address)}</b>`;
          const state =
            m.status === "provisioning"
              ? `<span class="setup">\u23F3 Setting up\u2026</span>`
              : m.status === "failed"
                ? `<span class="setup failed" title="${escapeHtml(
                    m.failure ?? "",
                  )}">\u2716 Setup failed</span>
       <form method="post" action="/mailboxes/${encodeURIComponent(
         m.address,
       )}/retry" class="rowform"><button type="submit" class="iconbtn" title="Retry setup">\u21BB</button></form>`
                : "";
          return `<tr${ready ? "" : ' class="pending"'}>
  <td>${name} ${state}</td>
  <td>${escapeHtml(m.label ?? "")}${
    m.status === "failed" && m.failure
      ? `<div class="snippet">${escapeHtml(m.failure)}</div>`
      : ""
  }</td>
  <td class="col-date">${ready ? formatDate(m.created_at) : ""}</td>
</tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="empty">${
        opts.notice?.kind === "error"
          ? // The notice above already says what went wrong; repeating it here
            // would be noise, but a bare "no mailboxes" reads like the app
            // never tried.
            "Your mailbox could not be set up automatically \u2014 see above."
          : MULTI_MAILBOX
            ? "No mailboxes yet. Claim one below."
            : "Your mailbox is being set up\u2026"
      }</td></tr>`;

  const notice = opts.notice
    ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}</div>`
    : "";

  return layout(
    {
      title: `CloudMail 95 — ${opts.orgLabel}`,
      who: `${opts.userId} @ ${opts.orgLabel}`,
      clerkKey: opts.clerkKey,
      nav: [{ href: "/", label: "Mailboxes" }],
      status: [
        `${opts.mailboxes.length} mailbox(es)`,
        opts.pending ? "setting up\u2026" : "all ready",
        opts.domain,
      ],
      // Poll only while something is actually in flight, rather than
      // reloading a settled page forever.
      head: opts.pending ? `<meta http-equiv="refresh" content="4">` : undefined,
    },
    `${notice}
<table class="mail">
  <thead><tr><th style="width:45%">Address</th><th>Label</th><th class="col-date">Created</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${
  (opts.adoptable ?? []).length
    ? `<hr>
${windowBox(
  "System mailboxes",
  `<p style="margin-top:0">These receive the reports this domain's own DNS asks for
  \u2014 DMARC aggregate reports and TLS negotiation failures. They are held by the
  system until someone takes them.</p>` +
    (opts.adoptable ?? [])
      .map(
        (a) => `<form method="post" action="/mailboxes/${encodeURIComponent(a)}/adopt">
  <b>${escapeHtml(a)}</b>
  <button type="submit">Transfer to me</button>
</form>`,
      )
      .join(""),
)}`
    : ""
}${
  MULTI_MAILBOX
    ? `<hr>
${windowBox(
  "Claim a mailbox",
  `<form method="post" action="/mailboxes">
  <label for="local">Address</label>
  <div style="display:flex;align-items:center;gap:6px">
    <input type="text" id="local" name="local" placeholder="sales" required
           pattern="[a-z0-9][a-z0-9._-]{0,62}" autocomplete="off" style="flex:1">
    <b style="white-space:nowrap">@${escapeHtml(opts.domain)}</b>
  </div>
  <label for="label">Label (optional)</label>
  <input type="text" id="label" name="label" placeholder="Sales team" autocomplete="off">
  <p><button type="submit">Claim mailbox</button></p>
</form>`,
)}`
    : ""
}`,
  );
}

/**
 * Per-row controls. Each is a POST form because these change state, and a
 * GET link would let a prefetcher or crawler trash someone's mail.
 */
/** Outbound-only delivery state. Silence means it went out cleanly. */
function deliveryChip(m: IndexedMessage): string {
  if (m.direction !== "out" || !m.delivery_status || m.delivery_status === "sent") return "";
  const label: Record<string, string> = {
    bounced: "\u2716 BOUNCED",
    failed: "\u2716 FAILED",
    queued: "\u27F3 QUEUED",
  };
  const title = [m.delivery_code, m.delivery_detail].filter(Boolean).join(" \u2014 ");
  return ` <span class="delivery ${escapeHtml(m.delivery_status)}" title="${escapeHtml(title)}">${
    label[m.delivery_status] ?? m.delivery_status
  }</span>`;
}

function rowActions(
  address: string,
  m: IndexedMessage,
  view: "inbox" | "trash" | "starred",
): string {
  const to = `/mb/${encodeURIComponent(address)}/${m.id}`;
  const button = (action: string, glyph: string, title: string, danger = false) =>
    `<form method="post" action="${to}/${action}" class="rowform"><button type="submit" class="iconbtn${
      danger ? " danger" : ""
    }" title="${escapeHtml(title)}">${glyph}</button></form>`;

  if (view === "trash") {
    return (
      button("restore", "\u21A9", "Restore to inbox") +
      button("purge", "\u2715", "Delete permanently", true)
    );
  }

  return (
    button(m.starred ? "unstar" : "star", m.starred ? "\u2605" : "\u2606", m.starred ? "Unstar" : "Star") +
    button(m.read ? "unread" : "read", m.read ? "\u25CF" : "\u25CB", m.read ? "Mark unread" : "Mark read") +
    button("trash", "\u{1F5D1}", "Move to Trash")
  );
}

export function inboxPage(opts: {
  address: string;
  orgLabel: string;
  userId: string;
  clerkKey: string;
  messages: IndexedMessage[];
  unread: number;
  total: number;
  threads: number;
  labels: { label: string; total: number; unread: number }[];
  agent: AgentConfig;
  activeLabel: string | null;
  view: "inbox" | "trash" | "starred";
  nextBefore: number | null;
  trashed: number;
  starredCount: number;
  notice?: { kind: "ok" | "error"; text: string };
}): string {
  const rows = opts.messages.length
    ? opts.messages
        .map((m) => {
          const outbound = m.direction === "out";
          const counterparty = outbound ? `To: ${m.recipient}` : m.sender;
          return `<tr class="${m.read ? "" : "unread"}">
  <td style="width:26%">${outbound ? '<span class="dir-out">&rarr;</span> ' : ""}${escapeHtml(counterparty)}</td>
  <td><a href="/mb/${encodeURIComponent(opts.address)}/${m.id}">${
    m.read ? "" : '<span class="badge-new">NEW</span>'
  }${
    m.grafted ? '<span class="badge-warn" title="Joined this thread via unsigned In-Reply-To">?</span> ' : ""
  }${escapeHtml(m.subject)}</a>${deliveryChip(m)}${
    m.label ? ` <span class="tag-chip">+${escapeHtml(m.label)}</span>` : ""
  }
      <span class="snippet"> &mdash; ${escapeHtml(m.snippet)}</span>
      ${m.attachment_count > 0 ? `<span class="snippet">\u{1F4CE} ${m.attachment_count}</span>` : ""}</td>
  <td class="col-date" style="width:9%">${formatDate(m.received_at)}</td>
  <td class="col-size" style="width:7%">${formatSize(m.size)}</td>
  <td class="col-actions">${rowActions(opts.address, m, opts.view)}</td>
</tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">${
        opts.view === "trash"
          ? "Trash is empty."
          : opts.view === "starred"
            ? "Nothing starred yet."
            : "No messages. The internet is quiet today."
      }</td></tr>`;

  const base = `/mb/${encodeURIComponent(opts.address)}`;
  const chip = (href: string, text: string, active: boolean, count?: number) =>
    `<a class="chip${active ? " active" : ""}" href="${href}">${escapeHtml(text)}${
      count === undefined ? "" : ` <b>${count}</b>`
    }</a>`;

  const viewParams = (extra: Record<string, string> = {}) => {
    const search = new URLSearchParams();
    if (opts.view !== "inbox") search.set("view", opts.view);
    if (opts.activeLabel) search.set("tag", opts.activeLabel);
    for (const [k, v] of Object.entries(extra)) search.set(k, v);
    const query = search.toString();
    return `${base}${query ? `?${query}` : ""}`;
  };

  const views = `<div class="chips">
  <span class="chips-label">View:</span>
  ${chip(base, "Inbox", opts.view === "inbox", opts.total)}
  ${chip(`${base}?view=starred`, "\u2605 Starred", opts.view === "starred", opts.starredCount)}
  ${chip(`${base}?view=trash`, "\u{1F5D1} Trash", opts.view === "trash", opts.trashed)}
</div>`;

  const pager =
    opts.nextBefore !== null
      ? `<p><a class="btn" href="${viewParams({ before: String(opts.nextBefore) })}">Older &darr;</a>
         <span class="hint">continuing below #${opts.nextBefore}</span></p>`
      : opts.messages.length > 0
        ? `<p class="hint">End of ${opts.view}.</p>`
        : "";

  const filters = opts.labels.length
    ? `<div class="chips">
  <span class="chips-label">Folders:</span>
  ${chip(base, "All", !opts.activeLabel)}
  ${opts.labels
    .map((l) =>
      chip(`${base}?tag=${encodeURIComponent(l.label)}`, `+${l.label}`, opts.activeLabel === l.label, l.total),
    )
    .join("")}
</div>`
    : "";

  // The agent belongs to the address, so it is a property of the mailbox
  // rather than something anyone addresses.
  const agentBar = opts.agent.enabled
    ? `<div class="agentbar">\u{1F916} <b>Agent on</b> for ${escapeHtml(opts.address)}${
        opts.agent.labels.length
          ? ` — acting on ${opts.agent.labels.map((l) => `+${escapeHtml(l)}`).join(", ")}`
          : " — acting on all mail"
      }${opts.agent.autoSend ? " · auto-send" : " · drafts held for review"}</div>`
    : "";

  const notice = opts.notice
    ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}</div>`
    : "";

  return layout(
    {
      title: `Inbox — ${opts.address}`,
      who: `${opts.userId} @ ${opts.orgLabel}`,
      clerkKey: opts.clerkKey,
      nav: [
        { href: "/", label: "Mailboxes" },
        { href: `/mb/${encodeURIComponent(opts.address)}`, label: "Inbox" },
        { href: `/mb/${encodeURIComponent(opts.address)}/search`, label: "Search" },
        { href: `/mb/${encodeURIComponent(opts.address)}/drafts`, label: "Drafts" },
        { href: `/mb/${encodeURIComponent(opts.address)}/compose`, label: "Compose" },
      ],
      status: [
        opts.unread > 0
          ? `You have ${opts.unread} new message(s)!`
          : "No new messages.",
        opts.activeLabel ? `folder +${opts.activeLabel}` : `${opts.total} total`,
        `${opts.threads} thread(s)`,
      ],
    },
    `${notice}${agentBar}${views}${filters}
<table class="mail">
  <thead>
    <tr><th>From / To</th><th>Subject</th><th class="col-date">Date</th><th class="col-size">Size</th><th class="col-actions"></th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
${pager}
<p class="hint">Hand out <code>${escapeHtml(opts.address.split("@")[0] ?? "")}+anything@${escapeHtml(
      opts.address.split("@")[1] ?? "",
    )}</code> — mail to it lands here and gets its own folder automatically.</p>`,
  );
}

export function messagePage(opts: {
  address: string;
  orgLabel: string;
  userId: string;
  clerkKey: string;
  message: ThreadMessage;
  attachments: ThreadAttachment[];
  thread: IndexedMessage[];
  threadId: string;
  bodySource: BodySource;
  hasHtml: boolean;
  showImages: boolean;
  delivery?: { status: string; code: string | null; detail: string | null } | null;
  notice?: { kind: "ok" | "error"; text: string };
}): string {
  const m = opts.message;
  const base = `/mb/${encodeURIComponent(opts.address)}`;

  const attachments = opts.attachments.length
    ? `<hr><p><b>Attachments:</b> ${opts.attachments
        .map(
          (a) =>
            `<a href="${base}/${m.id}/att/${a.id}">${escapeHtml(a.filename)}</a> (${formatSize(a.size)})`,
        )
        .join(" &middot; ")}</p>`
    : "";

  const earlier = opts.thread.filter((t) => t.id !== m.id);
  const threadBlock = earlier.length
    ? windowBox(
        `Thread (${opts.thread.length} messages)`,
        earlier
          .map(
            (t) => `<div class="thread-item">
  <div class="from-line">${t.direction === "out" ? "&rarr; " : ""}<b>${escapeHtml(
    t.direction === "out" ? t.recipient : t.sender,
  )}</b> &middot; ${formatDate(t.received_at)} &middot; <a href="${base}/${t.id}">${escapeHtml(t.subject)}</a></div>
  <div class="sunken" style="padding:6px;font:12px/1.5 'Courier New',monospace;white-space:pre-wrap">${escapeHtml(
    t.snippet,
  )}</div>
</div>`,
          )
          .join(""),
      )
    : "";

  const grafted = opts.thread.find((t) => t.id === m.id)?.grafted === 1;
  const replySubject = m.subject.match(/^re:/i) ? m.subject : `Re: ${m.subject}`;
  const replyTo = m.direction === "out" ? m.recipient : m.sender;
  const quoted = (m.body_text ?? "")
    .split("\n")
    .map((line: string) => `> ${line}`)
    .join("\n");

  const notice = opts.notice
    ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}</div>`
    : "";

  return layout(
    {
      title: m.subject,
      who: `${opts.userId} @ ${opts.orgLabel}`,
      clerkKey: opts.clerkKey,
      nav: [
        { href: "/", label: "Mailboxes" },
        { href: base, label: "Inbox" },
        { href: `${base}/search`, label: "Search" },
        { href: `${base}/drafts`, label: "Drafts" },
        { href: `${base}/compose`, label: "Compose" },
      ],
      status: [
        opts.address,
        `thread ${opts.threadId}`,
        formatSize(m.size),
        BODY_SOURCE_LABEL[opts.bodySource],
      ],
    },
    `${notice}
${
    m.direction === "out" && opts.delivery && opts.delivery.status !== "sent"
      ? `<div class="notice ${opts.delivery.status === "queued" ? "ok" : "error"}" style="font-size:11px">
  <b>${
    opts.delivery.status === "bounced"
      ? "This message bounced."
      : opts.delivery.status === "queued"
        ? "Not sent yet — queued for retry."
        : "This message was not delivered."
  }</b>
  ${escapeHtml([opts.delivery.code, opts.delivery.detail].filter(Boolean).join(" \u2014 "))}
</div>`
      : ""
  }
<div class="headers sunken">
  <dl>
    <dt>From:</dt><dd>${escapeHtml(m.sender)}</dd>
    <dt>To:</dt><dd>${escapeHtml(m.recipient)}</dd>
    <dt>Subject:</dt><dd><b>${escapeHtml(m.subject)}</b></dd>
    <dt>Date:</dt><dd>${new Date(m.received_at).toUTCString()}</dd>
  </dl>
</div>
${
    grafted
      ? `<div class="notice error" style="font-size:11px">⚠ This message joined the conversation using an unsigned <code>In-Reply-To</code> header, which the sender controls. Treat its placement in this thread as unverified.</div>`
      : ""
  }${
    opts.bodySource === "hot"
      ? ""
      : `<div class="notice ok" style="font-size:11px">📼 This message was retrieved from the R2 archive${
          opts.bodySource === "raw" ? " by re-parsing its original MIME" : ""
        }.</div>`
  }
${
    opts.hasHtml
      ? `${
          opts.showImages
            ? ""
            : `<div class="notice imgblock">\u{1F6E1} Remote images are blocked \u2014 they tell the sender when and where you opened this.
         <a href="${base}/${m.id}?images=1">Load images</a></div>`
        }
<iframe class="body-html sunken" src="${base}/${m.id}/body${
          opts.showImages ? "?images=1" : ""
        }" sandbox title="Message body" loading="lazy"></iframe>
<script>
  // Grow the frame to its content so the message is not trapped in a scroller.
  document.querySelector("iframe.body-html").addEventListener("load", function () {
    try {
      var d = this.contentDocument;
      this.style.height = Math.min(d.documentElement.scrollHeight + 24, 4000) + "px";
    } catch (e) { /* cross-origin; leave the default height */ }
  });
</script>`
      : `<div class="body-text sunken">${escapeHtml(m.body_text ?? "(no body)")}</div>`
  }
${attachments}
<hr>
${windowBox(
  "Reply",
  `<form method="post" action="${base}/${m.id}/reply" enctype="multipart/form-data">
  <label for="to">To</label>
  <input type="text" id="to" name="to" value="${escapeHtml(replyTo)}" required>
  <label for="cc">Cc</label>
  <input type="text" id="cc" name="cc" placeholder="optional">
  <label for="subject">Subject</label>
  <input type="text" id="subject" name="subject" value="${escapeHtml(replySubject)}" required>
  <label for="body">Message</label>
  <textarea id="body" name="body" required>

On ${new Date(m.received_at).toUTCString()}, ${escapeHtml(m.sender)} wrote:
${escapeHtml(quoted)}</textarea>
  <label for="files">Attach files</label>
  <input type="file" id="files" name="files" multiple>
  <p class="hint">Large files become expiring download links instead of attachments.</p>
  ${
    opts.attachments.length > 0
      ? `<fieldset class="reattach">
    <legend>Include from the original</legend>
    ${opts.attachments
      .map(
        (a) => `<label class="inline"><input type="checkbox" name="reattach" value="${escapeHtml(
          a.id,
        )}"> ${escapeHtml(a.filename)} <span class="snippet">(${formatSize(a.size)})</span></label>`,
      )
      .join("")}
  </fieldset>`
      : ""
  }
  <p><button type="submit">Send reply</button>
     <a class="btn" href="${base}/compose?forward=${escapeHtml(m.id)}">Forward</a>
     <a class="btn" href="${base}">Back to inbox</a></p>
</form>`,
)}
${threadBlock}`,
  );
}

export interface SearchFilters {
  unreadOnly: boolean;
  sender: string;
  label: string;
  hasAttachments: boolean;
  hideBulk: boolean;
  hideAuto: boolean;
}

export function searchPage(opts: {
  address: string;
  orgLabel: string;
  userId: string;
  clerkKey: string;
  query: string;
  results: IndexedMessage[];
  nextCursor: number | null;
  examined: number;
  exhausted: boolean;
  filters: SearchFilters;
  labels: { label: string; total: number; unread: number }[];
}): string {
  const base = `/mb/${encodeURIComponent(opts.address)}`;
  const rows = opts.results
    .map(
      (m) => `<tr class="${m.read ? "" : "unread"}">
  <td style="width:26%">${m.direction === "out" ? '<span class="dir-out">&rarr;</span> ' : ""}${escapeHtml(
    m.direction === "out" ? `To: ${m.recipient}` : m.sender,
  )}</td>
  <td><a href="${base}/${m.id}">${escapeHtml(m.subject)}</a>${
    m.label ? ` <span class="tag-chip">+${escapeHtml(m.label)}</span>` : ""
  }
      <span class="snippet"> &mdash; ${escapeHtml(m.snippet)}</span></td>
  <td class="col-date" style="width:9%">${formatDate(m.received_at)}</td>
  <td class="col-size" style="width:7%">${formatSize(m.size)}</td>
</tr>`,
    )
    .join("");

  const params = (cursor: number | null) => {
    const search = new URLSearchParams({ q: opts.query });
    const f = opts.filters;
    if (f.unreadOnly) search.set("unread", "1");
    if (f.sender) search.set("from", f.sender);
    if (f.label) search.set("tag", f.label);
    if (f.hasAttachments) search.set("attach", "1");
    if (f.hideBulk) search.set("nobulk", "1");
    if (f.hideAuto) search.set("noauto", "1");
    if (cursor !== null) search.set("cursor", String(cursor));
    return `${base}/search?${search.toString()}`;
  };

  // The page is built to be appended to, not replaced: each request returns
  // the next slice plus the cursor to resume from.
  const more =
    opts.nextCursor !== null
      ? `<p><a class="btn" href="${params(opts.nextCursor)}">Load more &darr;</a>
         <span class="hint">resuming below #${opts.nextCursor}</span></p>`
      : opts.results.length > 0
        ? `<p class="hint">End of results.</p>`
        : "";

  const body = opts.query
    ? opts.results.length > 0
      ? `<table class="mail">
  <thead><tr><th>From / To</th><th>Subject</th><th class="col-date">Date</th><th class="col-size">Size</th></tr></thead>
  <tbody>${rows}</tbody>
</table>${more}`
      : `<div class="empty">No matches${
          opts.exhausted ? "" : " in the range searched so far"
        }.</div>${more}`
    : `<div class="empty">Enter a search term. Matching walks newest&nbsp;&rarr;&nbsp;oldest, a page at a time.</div>`;

  return layout(
    {
      title: `Search — ${opts.address}`,
      who: `${opts.userId} @ ${opts.orgLabel}`,
      clerkKey: opts.clerkKey,
      nav: [
        { href: "/", label: "Mailboxes" },
        { href: base, label: "Inbox" },
        { href: `${base}/search`, label: "Search" },
        { href: `${base}/drafts`, label: "Drafts" },
        { href: `${base}/compose`, label: "Compose" },
      ],
      status: [
        opts.query ? `"${opts.query}"` : "No query",
        `${opts.results.length} shown`,
        `${opts.examined} scanned`,
        opts.exhausted ? "complete" : "more available",
      ],
    },
    `<form method="get" action="${base}/search">
  <div class="searchbar">
    <input type="text" name="q" value="${escapeHtml(opts.query)}" placeholder="settlement agreement" autofocus>
    <button type="submit">Search</button>
  </div>
  <div class="filterbar">
    <label class="inline">from
      <input type="text" name="from" value="${escapeHtml(opts.filters.sender)}" placeholder="anyone@example.com"></label>
    <label class="inline">folder
      <select name="tag">
        <option value="">any</option>
        ${opts.labels
          .map(
            (l) =>
              `<option value="${escapeHtml(l.label)}"${
                opts.filters.label === l.label ? " selected" : ""
              }>+${escapeHtml(l.label)} (${l.total})</option>`,
          )
          .join("")}
      </select></label>
    <label class="inline"><input type="checkbox" name="unread" value="1"${
      opts.filters.unreadOnly ? " checked" : ""
    }> unread</label>
    <label class="inline"><input type="checkbox" name="attach" value="1"${
      opts.filters.hasAttachments ? " checked" : ""
    }> has files</label>
    <label class="inline"><input type="checkbox" name="nobulk" value="1"${
      opts.filters.hideBulk ? " checked" : ""
    }> no newsletters</label>
    <label class="inline"><input type="checkbox" name="noauto" value="1"${
      opts.filters.hideAuto ? " checked" : ""
    }> no auto-replies</label>
  </div>
</form>
<hr>
${body}`,
  );
}

export function composePage(opts: {
  address: string;
  orgLabel: string;
  userId: string;
  clerkKey: string;
  attachmentLimit: string;
  inlineLimit: string;
  linkDays: string;
  prefill?: { to?: string; cc?: string; subject?: string; body?: string };
  /** Set when editing an existing draft, so saving updates rather than forks. */
  draft?: Draft | null;
  /** Attachments carried over from a message being forwarded. */
  forwardFrom?: { messageId: string; attachments: ThreadAttachment[] };
  notice?: { kind: "ok" | "error"; text: string };
}): string {
  const base = `/mb/${encodeURIComponent(opts.address)}`;
  const notice = opts.notice
    ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}</div>`
    : "";

  return layout(
    {
      title: `Compose — ${opts.address}`,
      who: `${opts.userId} @ ${opts.orgLabel}`,
      clerkKey: opts.clerkKey,
      nav: [
        { href: "/", label: "Mailboxes" },
        { href: base, label: "Inbox" },
        { href: `${base}/search`, label: "Search" },
        { href: `${base}/drafts`, label: "Drafts" },
        { href: `${base}/compose`, label: "Compose" },
      ],
      status: [`Sending as ${opts.address}`],
    },
    `${notice}
<form method="post" action="${base}/compose" enctype="multipart/form-data">
  <label for="to">To</label>
  <input type="text" id="to" name="to" value="${escapeHtml(opts.prefill?.to ?? "")}"
         placeholder="someone@example.com, another@example.com" required>
  <label for="cc">Cc</label>
  <input type="text" id="cc" name="cc" value="${escapeHtml(opts.prefill?.cc ?? "")}" placeholder="optional">
  <label for="bcc">Bcc</label>
  <input type="text" id="bcc" name="bcc" placeholder="optional \u2014 hidden from other recipients">
  <label for="subject">Subject</label>
  <input type="text" id="subject" name="subject" value="${escapeHtml(
    opts.prefill?.subject ?? "",
  )}" required>
  <label for="body">Message</label>
  <textarea id="body" name="body" required>${escapeHtml(opts.prefill?.body ?? "")}</textarea>
  <label for="files">Attach files</label>
  <input type="file" id="files" name="files" multiple>
  ${
    opts.forwardFrom && opts.forwardFrom.attachments.length > 0
      ? `<fieldset class="reattach">
    <legend>Forward these attachments</legend>
    ${opts.forwardFrom.attachments
      .map(
        (a) => `<label class="inline"><input type="checkbox" name="reattach" value="${escapeHtml(
          a.id,
        )}" checked> ${escapeHtml(a.filename)} <span class="snippet">(${formatSize(a.size)})</span></label>`,
      )
      .join("")}
  </fieldset>
  <input type="hidden" name="forwardFrom" value="${escapeHtml(opts.forwardFrom.messageId)}">`
      : ""
  }
  <p class="hint">Files up to ${escapeHtml(opts.inlineLimit)} ride along with the message.
     Anything larger is stored and sent as a download link that expires in ${escapeHtml(
       opts.linkDays,
     )} days &mdash; receiving mail servers cap attachments well below Cloudflare's 5&nbsp;MB.</p>
  ${
    opts.draft
      ? `<input type="hidden" name="draftId" value="${escapeHtml(opts.draft.id)}">
  <input type="hidden" name="threadId" value="${escapeHtml(opts.draft.thread_id ?? "")}">
  ${
    opts.draft.attachments_json
      ? `<fieldset class="reattach"><legend>Saved with this draft</legend>${(
          JSON.parse(opts.draft.attachments_json) as ThreadAttachment[]
        )
          .map(
            (a) =>
              `<label class="inline">\u{1F4CE} ${escapeHtml(a.filename)} <span class="snippet">(${formatSize(
                a.size,
              )})</span></label>`,
          )
          .join("")}</fieldset>`
      : ""
  }`
      : ""
  }
  <p><button type="submit" name="action" value="send">Send</button>
     <button type="submit" name="action" value="save" formnovalidate>Save draft</button>
     <a class="btn" href="${base}">Cancel</a></p>
</form>`,
  );
}

export function draftsPage(opts: {
  address: string;
  orgLabel: string;
  userId: string;
  clerkKey: string;
  drafts: Draft[];
  notice?: { kind: "ok" | "error"; text: string };
}): string {
  const base = `/mb/${encodeURIComponent(opts.address)}`;

  const rows = opts.drafts.length
    ? opts.drafts
        .map((d) => {
          const files = d.attachments_json
            ? (JSON.parse(d.attachments_json) as ThreadAttachment[]).length
            : 0;
          return `<tr>
  <td style="width:26%">${escapeHtml(d.to || "(no recipient)")}</td>
  <td><a href="${base}/drafts/${d.id}">${escapeHtml(d.subject || "(no subject)")}</a>
      <span class="snippet"> &mdash; ${escapeHtml(d.body.replace(/\s+/g, " ").slice(0, 100))}</span>
      ${files > 0 ? `<span class="snippet">\u{1F4CE} ${files}</span>` : ""}</td>
  <td class="col-date" style="width:9%">${formatDate(d.updated_at)}</td>
  <td class="col-actions"><form method="post" action="${base}/drafts/${d.id}/delete" class="rowform">
      <button type="submit" class="iconbtn danger" title="Discard draft">&#10005;</button></form></td>
</tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="empty">No drafts.</td></tr>`;

  const notice = opts.notice
    ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}</div>`
    : "";

  return layout(
    {
      title: `Drafts — ${opts.address}`,
      who: `${opts.userId} @ ${opts.orgLabel}`,
      clerkKey: opts.clerkKey,
      nav: [
        { href: "/", label: "Mailboxes" },
        { href: base, label: "Inbox" },
        { href: `${base}/search`, label: "Search" },
        { href: `${base}/drafts`, label: "Drafts" },
        { href: `${base}/compose`, label: "Compose" },
      ],
      status: [`${opts.drafts.length} draft(s)`, opts.address],
    },
    `${notice}
<table class="mail">
  <thead><tr><th>To</th><th>Subject</th><th class="col-date">Saved</th><th class="col-actions"></th></tr></thead>
  <tbody>${rows}</tbody>
</table>`,
  );
}

export function errorPage(status: number, message: string): string {
  return layout(
    { title: `Error ${status}`, status: [`HTTP ${status}`] },
    `<div class="notice error"><b>Error ${status}</b><br>${escapeHtml(message)}</div>
<p><a class="btn" href="/">Back to mailboxes</a></p>`,
  );
}
