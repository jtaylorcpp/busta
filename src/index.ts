import { localPartFromUsername, replyToAddress, signThreadTag } from "./addressing";
import { verifyDownloadToken } from "./download";
import { checkPosture, mtaStsPolicy } from "./posture";
import { sanitizeEmailHtml } from "./sanitize";
import { authenticate, clerkUsername, type Session, withAuthCookies } from "./auth";
import type { MailboxDO } from "./mailbox-do";
import type { ThreadAttachment, ThreadMessage } from "./thread-do";
import {
  AttachmentError,
  attachmentBudget,
  FLAG,
  inlineThreshold,
  linkLifetimeMs,
  ingest,
  isSystemAddress,
  isValidLocalPart,
  mailboxStub,
  normalizeAddress,
  type OutboundAttachment,
  parseRecipient,
  parseRecipientList,
  RecipientError,
  sanitizeFilename,
  SYSTEM_LOCAL_PARTS,
  SYSTEM_ORG_ID,
  SuppressedRecipientError,
  send,
  tenantStub,
  threadStub,
} from "./mail";
import {
  chooseOrgPage,
  composePage,
  errorPage,
  inboxPage,
  draftsPage,
  mailboxesPage,
  messagePage,
  searchPage,
  signInPage,
} from "./ui/pages";
import { CLERK_BOOTSTRAP, clerkScripts, MULTI_MAILBOX } from "./ui/layout";

export { MailboxProvisionWorkflow } from "./provision";
import { provisionInstanceId } from "./provision";
export { MailboxDO } from "./mailbox-do";
export { ThreadDO } from "./thread-do";
export { TenantDO } from "./tenant-do";

const INBOX_PAGE_SIZE = 50;
const SEARCH_PAGE_SIZE = 25;
const MESSAGE_ACTIONS = new Set(["trash", "restore", "purge", "star", "unstar", "read", "unread"]);

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function redirect(location: string, flash?: { kind: "ok" | "error"; text: string }): Response {
  const url = flash ? `${location}${location.includes("?") ? "&" : "?"}${flash.kind}=${encodeURIComponent(flash.text)}` : location;
  return new Response(null, { status: 303, headers: { location: url } });
}

function flashFrom(url: URL): { kind: "ok" | "error"; text: string } | undefined {
  const ok = url.searchParams.get("ok");
  if (ok) return { kind: "ok", text: ok };
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", text: error };
  return undefined;
}

function orgLabel(session: Session): string {
  return session.orgSlug ?? session.orgId ?? "no-org";
}

/**
 * The single authorization gate: a mailbox is readable only by the org that
 * claimed it, as recorded inside the mailbox's own Durable Object.
 */
async function authorizeMailbox(env: Env, session: Session, rawAddress: string) {
  const address = parseRecipient(decodeURIComponent(rawAddress)).mailbox;
  const stub = mailboxStub(env, address);
  const owner = await stub.ownerOrgId();
  if (!owner) return { ok: false as const, status: 404, message: `No such mailbox: ${address}` };
  if (owner !== session.orgId) {
    // Deliberately identical to the not-found case: a 403 would confirm the
    // mailbox exists to an org that has no business knowing that.
    return { ok: false as const, status: 404, message: `No such mailbox: ${address}` };
  }
  return { ok: true as const, address, stub };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");

    // The one piece of email security that genuinely has to be served by an
    // application rather than published as a DNS record. Sending servers
    // fetch this over HTTPS at mta-sts.<domain> before trusting the TXT
    // record that advertises it.
    if (path === "/.well-known/mta-sts.txt") {
      // `wrangler types` narrows vars to their literal value, but this is a
      // deploy-time knob whose value changes without the types regenerating.
      const mode = String(env.MTA_STS_MODE ?? "testing");
      if (mode === "off") return new Response("Not found", { status: 404 });
      return new Response(
        mtaStsPolicy({
          mode: mode || "testing",
          mx: String(env.MTA_STS_MX ?? "*.mx.cloudflare.net").split(",").map((h) => h.trim()),
          maxAgeSeconds: Number(env.MTA_STS_MAX_AGE ?? 86400) || 86400,
        }),
        {
          headers: {
            // The media type is mandated by RFC 8461; senders reject anything
            // else, and a wrong type here silently disables the policy.
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }

    // Public: recipients of a large-attachment link are external mail users
    // with no session here. The signature is the entire authorization.
    if (path.startsWith("/d/")) {
      return handleDownload(request, env, decodeURIComponent(path.slice(3)));
    }

    if (path.startsWith("/__dev/")) return handleDev(request, env, path);

    if (path === "/sign-in") return html(signInPage(env.CLERK_PUBLISHABLE_KEY));
    if (path === "/sign-out") return handleSignOut(env);

    let auth;
    try {
      auth = await authenticate(request, env);
    } catch (err) {
      // A misconfigured Clerk instance is an operator problem, and the error
      // text says which one — surfacing it beats an unexplained blank page.
      const message = err instanceof Error ? err.message : String(err);
      console.error("clerk authentication failed", message);
      return html(errorPage(500, message), 500);
    }

    if (auth.kind === "redirect") return auth.response;
    if (auth.kind === "signed-out") {
      return withAuthCookies(redirect("/sign-in"), auth.headers);
    }

    const session = auth.session;
    if (!session.orgId) {
      return withAuthCookies(
        html(chooseOrgPage(env.CLERK_PUBLISHABLE_KEY, session.userId)),
        auth.headers,
      );
    }

    try {
      // Clerk's Set-Cookie must ride along on the real response too, or the
      // refreshed session is never persisted and every request re-handshakes.
      return withAuthCookies(await route(request, env, ctx, url, session), auth.headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("request failed", { path, message });
      return withAuthCookies(html(errorPage(500, message), 500), auth.headers);
    }
  },

  /** Inbound mail from Email Routing. */
  async email(message, env, _ctx): Promise<void> {
    // Reject oversize mail at the envelope, before buffering it. A 25 MiB
    // message read into memory to then be refused is wasted work.
    const maxInbound = Number(env.MAX_INBOUND_BYTES ?? 26_214_400);
    if (Number.isFinite(maxInbound) && message.rawSize > maxInbound) {
      message.setReject(`Message too large (limit ${Math.round(maxInbound / 1_048_576)} MB)`);
      return;
    }

    // `message.raw` is a single-use stream — buffer before anything reads it.
    const raw = await new Response(message.raw).arrayBuffer();

    let result;
    try {
      result = await ingest(
        env,
        { from: message.from, to: message.to, rawSize: message.rawSize },
        raw,
      );
    } catch (error) {
      // A 4xx-style temporary rejection makes the sender retry, which is
      // right: our storage being briefly unavailable is not their problem,
      // and silently dropping the message would lose it outright.
      console.error("ingest failed", error);
      message.setReject("Temporary failure storing message, please retry");
      return;
    }

    if (result.status === "rejected") {
      message.setReject(result.reason ?? "Mailbox unavailable");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
  session: Session,
): Promise<Response> {
  const path = url.pathname;
  const flash = flashFrom(url);

  // GET / — mailbox list for the active org
  if (path === "/" && request.method === "GET") {
    const tenant = tenantStub(env, session.orgId!);

    // A brand-new tenant gets their username as an address without asking.
    // Signing up and landing on an empty list reads as a broken account: the
    // username *is* the mailbox name here, so there is nothing to choose yet.
    const auto = await autoProvisionFirstMailbox(env, session);

    const [mailboxes, pending] = await Promise.all([tenant.listMailboxes(), tenant.hasPending()]);

    // Offer only what is genuinely still system-held, so the panel never
    // advertises a transfer that would be refused.
    const admins = (env.ADMIN_USER_IDS ?? "").split(",").map((i) => i.trim()).filter(Boolean);
    let adoptable: string[] = [];
    if (admins.includes(session.userId)) {
      const candidates = [...SYSTEM_LOCAL_PARTS].map((l) => `${l}@${env.MAIL_DOMAIN}`);
      const owners = await Promise.all(candidates.map((a) => mailboxStub(env, a).ownerOrgId()));
      adoptable = candidates.filter((_, i) => owners[i] === SYSTEM_ORG_ID);
    }

    return html(
      mailboxesPage({
        adoptable,
        orgLabel: orgLabel(session),
        userId: session.userId,
        clerkKey: env.CLERK_PUBLISHABLE_KEY,
        domain: env.MAIL_DOMAIN,
        mailboxes,
        pending,
        // A flash from the user's own last action outranks anything this
        // first-run path has to say about itself.
        notice: flash ?? auto ?? undefined,
      }),
    );
  }

  // POST /mailboxes — claim a new address
  if (path === "/mailboxes" && request.method === "POST") {
    // One login, one address. Refused at the route, not merely hidden in the
    // page: the form being absent stops nobody from sending this request.
    if (!MULTI_MAILBOX) {
      return html(errorPage(403, "Each account has a single mailbox."), 403);
    }
    return claimMailbox(request, env, session);
  }

  // Retry a failed setup. The instance id is the address, so provisioning is
  // idempotent — which also means a second create() is refused, and restarting
  // the existing instance is the only way back.
  // POST /mailboxes/<address>/adopt — take a system mailbox into your org.
  //
  // Gated on an explicit allowlist, not on "whoever asks first". These
  // addresses receive the domain's DMARC and TLS reports, which name every
  // source sending as this domain — handing them to any signed-in user would
  // leak the domain's own authentication telemetry. With ADMIN_USER_IDS unset,
  // nobody can adopt, which is the right default for a fresh deployment.
  const adoptMatch = path.match(/^\/mailboxes\/([^/]+)\/adopt$/);
  if (adoptMatch && request.method === "POST") {
    const admins = (env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!admins.includes(session.userId)) {
      return html(errorPage(403, "Not permitted."), 403);
    }

    const address = parseRecipient(decodeURIComponent(adoptMatch[1]!)).mailbox;
    if (!isSystemAddress(address, env.MAIL_DOMAIN)) {
      return redirect("/", { kind: "error", text: `${address} is not a system mailbox.` });
    }

    const result = await mailboxStub(env, address).transfer(SYSTEM_ORG_ID, session.orgId!);
    if (!result.transferred) {
      return redirect("/", {
        kind: "error",
        text:
          result.ownerOrgId === session.orgId
            ? `${address} is already yours.`
            : `${address} could not be transferred — it is owned by ${result.ownerOrgId ?? "nobody"}.`,
      });
    }

    const local = address.slice(0, address.indexOf("@"));
    await tenantStub(env, session.orgId!).addMailbox(address, local, env.MAIL_DOMAIN, "Reports");
    await tenantStub(env, SYSTEM_ORG_ID).removeMailbox(address);
    return redirect("/", { kind: "ok", text: `${address} is now yours.` });
  }

  const retryMatch = path.match(/^\/mailboxes\/([^/]+)\/retry$/);
  if (retryMatch && request.method === "POST") {
    const address = parseRecipient(decodeURIComponent(retryMatch[1]!)).mailbox;
    const owner = await mailboxStub(env, address).ownerOrgId();
    if (owner !== session.orgId) {
      return html(errorPage(404, `No such mailbox: ${address}`), 404);
    }
    try {
      const instance = await env.PROVISION.get(await provisionInstanceId(address));
      await instance.restart();
      await tenantStub(env, session.orgId!).setMailboxStatus(address, "provisioning", null);
      return redirect("/", { kind: "ok", text: `Retrying setup for ${address}…` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return redirect("/", { kind: "error", text: `Could not retry: ${message}` });
    }
  }

  const mbMatch = path.match(/^\/mb\/([^/]+)(?:\/(.*))?$/);
  if (mbMatch) {
    const access = await authorizeMailbox(env, session, mbMatch[1]!);
    if (!access.ok) return html(errorPage(access.status, access.message), access.status);

    const rest = mbMatch[2] ?? "";
    const { address, stub } = access;

    if (rest === "" && request.method === "GET") {
      if (await stub.backfillPending()) await stub.backfill();
      const label = url.searchParams.get("tag");
      const view = url.searchParams.get("view");
      const beforeParam = url.searchParams.get("before");
      const before = beforeParam ? Number(beforeParam) : undefined;

      // One extra row tells us whether another page exists without a count.
      const [rows, stats, labels, agent] = await Promise.all([
        stub.list(INBOX_PAGE_SIZE + 1, 0, {
          label: label ?? undefined,
          before,
          trash: view === "trash",
          starred: view === "starred",
        }),
        stub.stats(),
        stub.labels(),
        stub.agentConfig(),
      ]);
      const messages = rows.slice(0, INBOX_PAGE_SIZE);
      const nextBefore = rows.length > INBOX_PAGE_SIZE ? messages[messages.length - 1]!.seq : null;
      return html(
        inboxPage({
          address,
          orgLabel: orgLabel(session),
          userId: session.userId,
          clerkKey: env.CLERK_PUBLISHABLE_KEY,
          messages,
          unread: stats.unread,
          total: stats.total,
          threads: stats.threads,
          labels,
          agent,
          activeLabel: label,
          view: view === "trash" ? "trash" : view === "starred" ? "starred" : "inbox",
          nextBefore,
          trashed: stats.trashed,
          starredCount: stats.starred,
          notice: flash,
        }),
      );
    }

    if (rest === "search" && request.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const cursorParam = url.searchParams.get("cursor");
      const filters = {
        unreadOnly: url.searchParams.get("unread") === "1",
        sender: normalizeAddress(url.searchParams.get("from") ?? ""),
        label: url.searchParams.get("tag") ?? "",
        hasAttachments: url.searchParams.get("attach") === "1",
        hideBulk: url.searchParams.get("nobulk") === "1",
        hideAuto: url.searchParams.get("noauto") === "1",
      };

      // Flag filters are bitmask work on the index, so they compose with the
      // text query in one pass rather than post-filtering results.
      const flagsAll = filters.hasAttachments ? FLAG.hasAttachments : 0;
      const flagsNone =
        (filters.hideBulk ? FLAG.bulk : 0) | (filters.hideAuto ? FLAG.autoSubmitted : 0);

      const [page, labels] = await Promise.all([
        q
          ? stub.searchText({
              q,
              cursor: cursorParam ? Number(cursorParam) : null,
              limit: SEARCH_PAGE_SIZE,
              unreadOnly: filters.unreadOnly,
              sender: filters.sender || undefined,
              label: filters.label || undefined,
              flagsAll: flagsAll || undefined,
              flagsNone: flagsNone || undefined,
            })
          : Promise.resolve({ results: [], nextCursor: null, examined: 0, exhausted: true }),
        stub.labels(),
      ]);

      return html(
        searchPage({
          address,
          orgLabel: orgLabel(session),
          userId: session.userId,
          clerkKey: env.CLERK_PUBLISHABLE_KEY,
          query: q,
          results: page.results,
          nextCursor: page.nextCursor,
          examined: page.examined,
          exhausted: page.exhausted,
          filters,
          labels,
        }),
      );
    }

    if (rest === "drafts" && request.method === "GET") {
      const drafts = await stub.listDrafts();
      return html(
        draftsPage({
          address,
          orgLabel: orgLabel(session),
          userId: session.userId,
          clerkKey: env.CLERK_PUBLISHABLE_KEY,
          drafts,
          notice: flash,
        }),
      );
    }

    const draftMatch = rest.match(/^drafts\/([0-9a-f-]{36})(?:\/(delete))?$/i);
    if (draftMatch) {
      const draftId = draftMatch[1]!;

      if (draftMatch[2] === "delete" && request.method === "POST") {
        const keys = await stub.deleteDraft(draftId);
        await Promise.all(keys.map((key) => env.MAIL_ARCHIVE.delete(key)));
        return redirect(`${base(address)}/drafts`, { kind: "ok", text: "Draft discarded." });
      }

      if (request.method === "GET") {
        const draft = await stub.getDraft(draftId);
        if (!draft) return html(errorPage(404, "Draft not found"), 404);
        return html(
          composePage({
            address,
            orgLabel: orgLabel(session),
            userId: session.userId,
            clerkKey: env.CLERK_PUBLISHABLE_KEY,
            attachmentLimit: formatBytes(attachmentBudget(env)),
            inlineLimit: formatBytes(inlineThreshold(env)),
            linkDays: String(Math.round(linkLifetimeMs(env) / 86_400_000)),
            prefill: { to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body },
            draft,
            notice: flash,
          }),
        );
      }
    }

    if (rest === "compose") {
      if (request.method === "GET") {
        // Forward reuses compose rather than a parallel form: the only
        // differences are the prefilled body and the carried attachments.
        const forwardId = url.searchParams.get("forward");
        let prefill: { subject?: string; body?: string } | undefined;
        let forwardFrom: { messageId: string; attachments: ThreadAttachment[] } | undefined;

        if (forwardId) {
          const row = await stub.lookup(forwardId);
          const found = row ? await threadStub(env, address, row.thread_id).get(forwardId) : null;
          if (found) {
            const original = found.message;
            prefill = {
              subject: /^fwd:/i.test(original.subject)
                ? original.subject
                : `Fwd: ${original.subject}`,
              body: [
                "",
                "---------- Forwarded message ----------",
                `From: ${original.sender}`,
                `Date: ${new Date(original.received_at).toUTCString()}`,
                `Subject: ${original.subject}`,
                `To: ${original.recipient}`,
                "",
                original.body_text ?? "(no plain-text body)",
              ].join("\n"),
            };
            forwardFrom = { messageId: forwardId, attachments: found.attachments };
          }
        }

        return html(
          composePage({
            address,
            orgLabel: orgLabel(session),
            userId: session.userId,
            clerkKey: env.CLERK_PUBLISHABLE_KEY,
            attachmentLimit: formatBytes(attachmentBudget(env)),
            inlineLimit: formatBytes(inlineThreshold(env)),
            linkDays: String(Math.round(linkLifetimeMs(env) / 86_400_000)),
            prefill,
            forwardFrom,
            notice: flash,
          }),
        );
      }
      if (request.method === "POST") {
        // The forward source is a hidden field, so the POST can reload the
        // original's attachments from R2 without the browser re-uploading.
        const posted = request.clone();
        const form = await posted.formData();

        if (String(form.get("action")) === "save") {
          return saveDraftFromForm(request, env, address, stub);
        }

        const forwardFrom = String(form.get("forwardFrom") ?? "");
        let carried: ThreadAttachment[] = [];
        if (forwardFrom) {
          const row = await stub.lookup(forwardFrom);
          if (row) {
            const found = await threadStub(env, address, row.thread_id).get(forwardFrom);
            carried = found?.attachments ?? [];
          }
        }
        return sendFromForm(
          request,
          env,
          address,
          null,
          null,
          url.searchParams.get("tag"),
          carried,
        );
      }
    }

    const msgMatch = rest.match(
      /^([0-9a-f-]{36})(?:\/(body|reply|forward|trash|restore|purge|star|unstar|read|unread|att\/([^/]+)))?$/i,
    );
    if (msgMatch) {
      const messageId = msgMatch[1]!;
      const action = msgMatch[2];

      const indexed = stub.lookup(messageId);

      if (!action && request.method === "GET") {
        const row = await indexed;
        if (!row) return html(errorPage(404, "Message not found"), 404);

        const [found, thread] = await Promise.all([
          threadStub(env, address, row.thread_id).get(messageId),
          // The index already holds every row in this thread, so rendering the
          // conversation costs no extra Durable Object hop.
          stub.threadIndex(row.thread_id),
        ]);
        if (!found) return html(errorPage(404, "Message body not found"), 404);
        if (!row.read) await stub.markRead(messageId);

        return html(
          messagePage({
            address,
            orgLabel: orgLabel(session),
            userId: session.userId,
            clerkKey: env.CLERK_PUBLISHABLE_KEY,
            message: found.message,
            attachments: found.attachments,
            thread,
            threadId: row.thread_id,
            bodySource: found.bodySource,
            hasHtml: Boolean(found.message.body_html),
            showImages: url.searchParams.get("images") === "1",
            delivery: row.delivery_status
              ? {
                  status: row.delivery_status,
                  code: row.delivery_code,
                  detail: row.delivery_detail,
                }
              : null,
            notice: flash,
          }),
        );
      }

      // --- single-message actions -------------------------------------
      if (request.method === "POST" && action && MESSAGE_ACTIONS.has(action)) {
        const row = await indexed;
        if (!row) return html(errorPage(404, "Message not found"), 404);
        const backTo = `${base(address)}${row.deleted_at !== null ? "?view=trash" : ""}`;

        switch (action) {
          case "trash":
            stub.trash(messageId);
            return redirect(backTo, { kind: "ok", text: "Moved to Trash." });
          case "restore":
            stub.restore(messageId);
            return redirect(base(address), { kind: "ok", text: "Restored from Trash." });
          case "purge": {
            if (row.deleted_at === null) {
              // Purge is only reachable from Trash, so a stray POST cannot
              // destroy a live message in one step.
              return redirect(backTo, {
                kind: "error",
                text: "Move it to Trash before deleting permanently.",
              });
            }
            const keys = await threadStub(env, address, row.thread_id).remove(messageId);
            await Promise.all(keys.map((key) => env.MAIL_ARCHIVE.delete(key)));
            stub.unindex(messageId);
            return redirect(`${base(address)}?view=trash`, {
              kind: "ok",
              text: `Permanently deleted, including ${keys.length} stored file(s).`,
            });
          }
          case "star":
          case "unstar":
            stub.setStarred(messageId, action === "star");
            return redirect(backTo);
          case "read":
          case "unread":
            stub.setRead(messageId, action === "read");
            return redirect(backTo);
        }
      }

      if (action === "reply" && request.method === "POST") {
        const row = await indexed;
        if (!row) return html(errorPage(404, "Message not found"), 404);
        const found = await threadStub(env, address, row.thread_id).get(messageId);
        if (!found) return html(errorPage(404, "Message body not found"), 404);
        return sendFromForm(
          request,
          env,
          address,
          found.message,
          row.thread_id,
          row.label,
          found.attachments,
        );
      }

      if (action === "body" && request.method === "GET") {
        const row = await indexed;
        if (!row) return new Response("Not found", { status: 404 });
        const found = await threadStub(env, address, row.thread_id).get(messageId);
        if (!found?.message.body_html) return new Response("", { status: 204 });

        const allowRemoteImages = url.searchParams.get("images") === "1";
        const { html: safe } = await sanitizeEmailHtml(found.message.body_html, {
          allowRemoteImages,
          resolveCid: (contentId) => {
            const att = found.attachments.find((a) => a.content_id === contentId);
            return att ? `${base(address)}/${messageId}/att/${att.id}` : null;
          },
        });

        // Second layer. Even if the sanitizer missed something, this document
        // has no script, no framing rights, and — unless the reader asked for
        // images — no way to reach the network at all.
        const csp = [
          "default-src 'none'",
          allowRemoteImages ? "img-src https: data:" : "img-src data: 'self'",
          "style-src 'unsafe-inline'",
          "font-src data:",
          "form-action 'none'",
          "frame-ancestors 'self'",
          "base-uri 'none'",
        ].join("; ");

        return new Response(
          `<!doctype html><meta charset="utf-8">` +
            `<style>html,body{margin:0;padding:10px;font:13px/1.5 Arial,Helvetica,sans-serif;` +
            `word-break:break-word}img{max-width:100%;height:auto}` +
            `table{max-width:100%}</style>${safe}`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": csp,
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
              "cache-control": "no-store",
            },
          },
        );
      }

      const attId = msgMatch[3];
      if (attId && request.method === "GET") {
        const row = await indexed;
        if (!row) return html(errorPage(404, "Message not found"), 404);
        const found = await threadStub(env, address, row.thread_id).get(messageId);
        const att = found?.attachments.find((a) => a.id === decodeURIComponent(attId));
        if (!att) return html(errorPage(404, "Attachment not found"), 404);

        const object = await env.MAIL_ARCHIVE.get(att.r2_key);
        if (!object) return html(errorPage(404, "Attachment missing from archive"), 404);

        return new Response(object.body, {
          headers: {
            "content-type": att.mime_type ?? "application/octet-stream",
            "content-disposition": `attachment; filename="${att.filename.replace(/"/g, "")}"`,
            "cache-control": "private, max-age=3600",
          },
        });
      }
    }
  }

  return html(errorPage(404, `No route for ${path}`), 404);
}

/**
 * Give a new tenant the mailbox named after their username.
 *
 * Runs at most once per organization — `claimAutoProvision()` is the gate, and
 * it is atomic inside the Durable Object, so concurrent first page loads
 * cannot start two workflows.
 *
 * Returns a notice to show, or null when there is nothing to say. Nothing here
 * throws: a first sign-in must not fail to render because the address could
 * not be derived. Every failure ends with the user on their mailbox list, told
 * what happened, with the claim form right there.
 */
async function autoProvisionFirstMailbox(
  env: Env,
  session: Session,
): Promise<{ kind: "ok" | "error"; text: string } | null> {
  const tenant = tenantStub(env, session.orgId!);
  if (!(await tenant.claimAutoProvision())) {
    // Nothing to do now, but say why there is still no mailbox. Explaining
    // only once, on the request that happened to consume the claim, left
    // every later load looking like the feature simply had not run.
    const failure = await tenant.autoProvisionFailure();
    return failure ? { kind: "error", text: failure } : null;
  }

  let username: string | null;
  try {
    username = await clerkUsername(env, session.userId);
  } catch (error) {
    // Transient and not the user's doing: release the claim so the next page
    // load tries again rather than stranding them on the manual form.
    console.error("could not read username for auto-provision", error);
    await tenant.finishAutoProvision({ ok: false, retryable: true });
    return { kind: "error", text: "Could not reach Clerk to read your username. Reload to retry." };
  }

  const fail = async (text: string) => {
    await tenant.finishAutoProvision({ ok: false, reason: text });
    return { kind: "error" as const, text };
  };

  if (!username) {
    return fail(
      "Your account has no username, so there is no name for your address. " +
        "Set one in your account settings and reload, or claim an address below.",
    );
  }

  const derived = localPartFromUsername(username);
  if (!derived.ok) {
    const suffix = derived.suggestion ? ` Try "${derived.suggestion}" below.` : "";
    return fail(`Could not use your username: ${derived.reason}.${suffix}`);
  }

  const address = `${derived.localPart}@${env.MAIL_DOMAIN}`;

  // Clerk usernames are unique per instance, but that is a different registry
  // from mailbox ownership — an address claimed before this instance existed,
  // or by another org, is still taken. MailboxDO.claim() is the authority.
  const owner = await mailboxStub(env, address).ownerOrgId();
  if (owner && owner !== session.orgId) {
    return fail(`${address} is already taken — pick another address below.`);
  }

  try {
    await env.PROVISION.create({
      id: await provisionInstanceId(address),
      params: { orgId: session.orgId!, address, localPart: derived.localPart, label: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/exists/i.test(message)) {
      console.error("auto-provision failed to start", message);
      await tenant.finishAutoProvision({ ok: false, retryable: true });
      return { kind: "error", text: `Could not set up ${address}: ${message}. Reload to retry.` };
    }
  }

  await tenant.finishAutoProvision({ ok: true });
  return { kind: "ok", text: `Setting up your mailbox, ${address}…` };
}

async function claimMailbox(request: Request, env: Env, session: Session): Promise<Response> {
  const form = await request.formData();
  const local = String(form.get("local") ?? "").trim().toLowerCase();
  const label = String(form.get("label") ?? "").trim() || null;

  if (!isValidLocalPart(local)) {
    return redirect("/", {
      kind: "error",
      text: `"${local}" is not an available local-part (reserved, or invalid characters).`,
    });
  }

  const address = `${local}@${env.MAIL_DOMAIN}`;

  // Cheap pre-check purely for immediate feedback. It is not the authority —
  // the workflow's claim step is, and it is atomic. This only spares the user
  // a round trip through a workflow that was always going to fail.
  const owner = await mailboxStub(env, address).ownerOrgId();
  if (owner && owner !== session.orgId) {
    return redirect("/", { kind: "error", text: `${address} is already taken.` });
  }

  try {
    // The instance id is the address, so Cloudflare refuses a second
    // provisioning run for the same mailbox outright.
    await env.PROVISION.create({
      id: await provisionInstanceId(address),
      params: { orgId: session.orgId!, address, localPart: local, label },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/exists/i.test(message)) {
      return redirect("/", { kind: "error", text: `${address} is already being set up.` });
    }
    return redirect("/", { kind: "error", text: `Could not start setup: ${message}` });
  }

  return redirect("/", { kind: "ok", text: `Setting up ${address}…` });
}

/**
 * Persist a draft, staging any uploaded files in R2 so they survive the
 * browser being closed. Existing staged files are kept when a save carries no
 * new uploads, so editing the subject cannot silently drop attachments.
 */
async function saveDraftFromForm(
  request: Request,
  env: Env,
  address: string,
  stub: DurableObjectStub<MailboxDO>,
): Promise<Response> {
  const form = await request.formData();
  const draftId = String(form.get("draftId") ?? "") || crypto.randomUUID();

  const staged: ThreadAttachment[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string" || entry.size === 0) continue;
    const filename = sanitizeFilename(entry.name);
    const key = `drafts/${encodeURIComponent(address)}/${draftId}/${crypto.randomUUID()}-${encodeURIComponent(filename)}`;
    await env.MAIL_ARCHIVE.put(key, await entry.arrayBuffer(), {
      httpMetadata: { contentType: entry.type || "application/octet-stream" },
      customMetadata: { filename, mailbox: address },
    });
    staged.push({
      id: crypto.randomUUID(),
      message_id: draftId,
      filename,
      mime_type: entry.type || null,
      size: entry.size,
      r2_key: key,
      content_id: null,
    });
  }

  await stub.saveDraft({
    id: draftId,
    to: String(form.get("to") ?? ""),
    cc: String(form.get("cc") ?? ""),
    bcc: String(form.get("bcc") ?? ""),
    subject: String(form.get("subject") ?? ""),
    body: String(form.get("body") ?? ""),
    threadId: String(form.get("threadId") ?? "") || null,
    replyToId: String(form.get("replyToId") ?? "") || null,
    attachmentsJson: staged.length > 0 ? JSON.stringify(staged) : null,
  });

  return redirect(`${base(address)}/drafts`, { kind: "ok", text: "Draft saved." });
}

function base(address: string): string {
  return `/mb/${encodeURIComponent(address)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Collect uploaded files plus any attachments carried over from the message
 * being replied to. Re-attached files are read back out of R2 rather than
 * asking the browser to round-trip bytes it already has stored server-side.
 */
async function collectAttachments(
  env: Env,
  form: FormData,
  parentAttachments: ThreadAttachment[],
): Promise<OutboundAttachment[]> {
  const attachments: OutboundAttachment[] = [];

  for (const entry of form.getAll("files")) {
    if (typeof entry === "string" || entry.size === 0) continue;
    attachments.push({
      filename: entry.name,
      contentType: entry.type || "application/octet-stream",
      content: await entry.arrayBuffer(),
    });
  }

  const reattach = new Set(form.getAll("reattach").map(String));
  for (const att of parentAttachments) {
    if (!reattach.has(att.id)) continue;
    const object = await env.MAIL_ARCHIVE.get(att.r2_key);
    if (!object) continue; // archived copy is gone; skip rather than fail the send
    attachments.push({
      filename: att.filename,
      contentType: att.mime_type ?? "application/octet-stream",
      content: await object.arrayBuffer(),
    });
  }

  return attachments;
}

async function sendFromForm(
  request: Request,
  env: Env,
  address: string,
  parent: ThreadMessage | null,
  threadId: string | null,
  label: string | null,
  parentAttachments: ThreadAttachment[] = [],
): Promise<Response> {
  const form = await request.formData();
  const draftId = String(form.get("draftId") ?? "");
  const to = parseRecipientList(String(form.get("to") ?? ""));
  const cc = parseRecipientList(String(form.get("cc") ?? ""));
  const bcc = parseRecipientList(String(form.get("bcc") ?? ""));
  const subject = String(form.get("subject") ?? "").trim() || "(no subject)";
  const body = String(form.get("body") ?? "");
  const backTo = base(address);

  try {
    // A draft's staged files behave exactly like re-attached ones: read back
    // from R2 rather than re-uploaded.
    let staged: ThreadAttachment[] = [];
    if (draftId) {
      const draft = await mailboxStub(env, address).getDraft(draftId);
      if (draft?.attachments_json) {
        staged = JSON.parse(draft.attachments_json) as ThreadAttachment[];
        for (const att of staged) form.append("reattach", att.id);
      }
    }
    const attachments = await collectAttachments(env, form, [...parentAttachments, ...staged]);
    const result = await send(env, {
      from: address,
      to,
      cc,
      bcc,
      subject,
      text: body,
      inReplyTo: parent,
      threadId,
      label,
      attachments,
    });
    if (draftId) {
      // Only discard the draft once the send succeeded.
      const keys = await mailboxStub(env, address).deleteDraft(draftId);
      await Promise.all(keys.map((key) => env.MAIL_ARCHIVE.delete(key)));
    }

    const recipients = to.length + cc.length + bcc.length;
    return redirect(backTo, {
      kind: "ok",
      text:
        `Sent to ${recipients} recipient(s)` +
        (result.attachments > 0 ? ` with ${result.attachments} attachment(s)` : "") +
        (result.linked.length > 0 ? `, ${result.linked.length} as download link(s)` : "") +
        ".",
    });
  } catch (err) {
    // A bad recipient or oversize attachment is the user's problem to fix,
    // not a system failure — say exactly what is wrong instead of a generic
    // error that sends them to the logs.
    if (
      err instanceof AttachmentError ||
      err instanceof RecipientError ||
      err instanceof SuppressedRecipientError
    ) {
      return redirect(backTo, { kind: "error", text: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    // Surface the binding's own error code (E_SENDER_NOT_VERIFIED etc.) — it
    // is almost always a setup problem the operator needs to read verbatim.
    return redirect(backTo, { kind: "error", text: `Send failed: ${message}` });
  }
}

/**
 * Serve a signed attachment link.
 *
 * The R2 body is handed straight to the Response, so a multi-gigabyte object
 * streams through without ever being buffered in the Worker. Range and
 * conditional headers are passed to R2 so large downloads resume rather than
 * restarting.
 */
async function handleDownload(request: Request, env: Env, token: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const verdict = await verifyDownloadToken(env.THREAD_SECRET, token);
  if (!verdict.ok) {
    // Expiry is worth explaining; a bad signature is not worth confirming.
    const status = verdict.reason === "expired" ? 410 : 404;
    return html(
      errorPage(
        status,
        verdict.reason === "expired"
          ? "This download link has expired. Ask the sender for a new one."
          : "This download link is not valid.",
      ),
      status,
    );
  }

  const object = await env.MAIL_ARCHIVE.get(verdict.key, {
    range: request.headers,
    onlyIf: request.headers,
  });

  if (object === null) {
    return html(errorPage(404, "That file is no longer stored."), 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Signed and time-limited, so caches must not hold it for other viewers.
  headers.set("cache-control", "private, max-age=3600");
  headers.set(
    "content-disposition",
    `attachment; filename="${(object.customMetadata?.filename ?? "download").replace(/"/g, "")}"`,
  );

  // A conditional request that matched returns metadata with no body.
  if (!("body" in object)) return new Response(null, { status: 304, headers });

  // R2 populates `range` even for an unconditional GET, so 206 has to key off
  // the request actually asking for a range. An unsolicited 206 breaks some
  // clients and poisons cache semantics.
  const rangeRequested = request.headers.has("range");
  if (rangeRequested && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function handleSignOut(env: Env): Response {
  return html(
    `<!doctype html><meta charset="utf-8"><title>Signing out…</title>
${clerkScripts(env.CLERK_PUBLISHABLE_KEY)}
${CLERK_BOOTSTRAP}
<p>Signing out…</p>
<script>
  window.addEventListener("load", async () => {
    try {
      const clerk = await loadClerk();
      await clerk.signOut();
    } catch (e) {
      // Sign-out must not strand the user on this page. Clerk's cookies are
      // scoped to its own domain, so if the script cannot load there is
      // nothing this page can clear itself — go back to sign-in, which will
      // re-derive the real session state server-side.
      console.error("clerk-js failed during sign-out", e);
    }
    window.location.href = "/sign-in";
  });
</script>`,
  );
}

/** Dev-only endpoints. Disabled outside ENVIRONMENT=development. */
async function handleDev(request: Request, env: Env, path: string): Promise<Response> {
  if (env.ENVIRONMENT !== "development") return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Use POST", { status: 405 });

  if (path === "/__dev/claim") {
    const { orgId, local, label } = (await request.json()) as {
      orgId?: string;
      local?: string;
      label?: string;
    };
    if (!orgId || !local || !isValidLocalPart(local)) {
      return Response.json({ error: "orgId and a valid local are required" }, { status: 400 });
    }
    const address = `${local}@${env.MAIL_DOMAIN}`;
    const result = await mailboxStub(env, address).claim(orgId, address);
    if (result.claimed) {
      await tenantStub(env, orgId).addMailbox(address, local, env.MAIL_DOMAIN, label ?? null);
    }
    return Response.json({ address, ...result }, { status: result.claimed ? 201 : 409 });
  }

  if (path === "/__dev/inbound") return handleDevInbound(request, env);

  if (path === "/__dev/get") {
    const { address, id } = (await request.json()) as { address?: string; id?: string };
    if (!address || !id) return Response.json({ error: "address and id required" }, { status: 400 });
    const mailbox = mailboxStub(env, address);
    const row = await mailbox.lookup(id);
    if (!row) return Response.json({ error: "not indexed" }, { status: 404 });
    const found = await threadStub(env, address, row.thread_id).get(id);
    if (!found) return Response.json({ error: "no body in thread" }, { status: 404 });
    return Response.json({
      thread_id: row.thread_id,
      bodySource: found.bodySource,
      archived_at: found.message.archived_at,
      body_r2_key: found.message.body_r2_key,
      body_text: found.message.body_text,
      attachments: found.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        r2_key: a.r2_key,
      })),
    });
  }

  if (path === "/__dev/thread") {
    const { address, threadId } = (await request.json()) as {
      address?: string;
      threadId?: string;
    };
    if (!address || !threadId) {
      return Response.json({ error: "address and threadId required" }, { status: 400 });
    }
    const stub = threadStub(env, address, threadId);
    const [messages, schedule] = await Promise.all([stub.list(), stub.sweepSchedule()]);
    return Response.json({ threadId, schedule, count: messages.length, messages });
  }

  if (path === "/__dev/replytag") {
    const { address, threadId } = (await request.json()) as {
      address?: string;
      threadId?: string;
    };
    if (!address || !threadId) {
      return Response.json({ error: "address and threadId required" }, { status: 400 });
    }
    const tag = await signThreadTag(env.THREAD_SECRET, address, threadId);
    return Response.json({ tag, replyTo: replyToAddress(address, tag) });
  }

  if (path === "/__dev/agent") {
    const { address, ...patch } = (await request.json()) as {
      address?: string;
      enabled?: boolean;
      policy?: string | null;
      labels?: string[];
      autoSend?: boolean;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const stub = mailboxStub(env, address);
    const config =
      Object.keys(patch).length > 0 ? await stub.setAgentConfig(patch) : await stub.agentConfig();
    return Response.json({ address, config });
  }

  if (path === "/__dev/measure") {
    const { address, count = 1000, batch = 500, bodyChars = 2000 } = (await request.json()) as {
      address?: string;
      count?: number;
      batch?: number;
      bodyChars?: number;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });

    const stub = mailboxStub(env, address);
    const before = await stub.databaseSize();
    const startRows = (await stub.stats()).total;

    // Realistic worst case: full-length snippet, long sender and Message-ID,
    // every third message carrying a label.
    const LABELS = ["newsletter", "orders", "triage"];
    for (let written = 0; written < count; written += batch) {
      const size = Math.min(batch, count - written);
      const rows = Array.from({ length: size }, (_, i) => {
        const n = written + i;
        return {
          id: crypto.randomUUID(),
          threadId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
          direction: "in" as const,
          sender: `firstname.lastname${n}@some-longish-company-name.example.com`,
          recipient: address,
          subject: `Re: Quarterly procurement review and vendor pricing #${n}`,
          snippet:
            "Hi there, following up on the thread below about bulk pricing for the " +
            "next quarter. We would like to revise the quantities upward and ".slice(0, 70),
          messageId: `<${crypto.randomUUID()}@mail.some-longish-company-name.example.com>`,
          receivedAt: Date.now() - n * 60_000,
          size: 4096,
          attachmentCount: n % 5 === 0 ? 2 : 0,
          label: n % 3 === 0 ? LABELS[(n / 3) % LABELS.length]! : null,
          // Realistic body length, not a one-liner — full-text index cost is
          // dominated by body size, so a short fixture would flatter it.
          searchBody: (
            (n % 7 === 0
              ? `Please review the attached settlement agreement before Friday. Reference ${n}. `
              : `Following up on bulk pricing for next quarter. Reference ${n}. `) +
            "We have reviewed the proposal in detail and would like to discuss the " +
            "delivery schedule, payment terms, and warranty provisions before we " +
            "countersign anything. Our procurement team has flagged several items " +
            "in appendix B that need clarification, in particular the lead times " +
            "quoted for the extended configuration and the penalties attached to " +
            "late delivery. Please confirm whether the quoted figures include " +
            "freight and installation, and whether the maintenance window can be " +
            "moved to a weekend. "
          ).repeat(16).slice(0, bodyChars),
          metadata: {
            fromName: `Firstname Lastname ${n}`,
            toCount: 2,
            ccCount: 1,
            listId: n % 4 === 0 ? `vendor-announce.lists.example.com` : null,
            subjectKey: `quarterly procurement review and vendor pricing #${n}`,
            flags: 0b101010,
            auth: 0b010101,
            bodyChars: 2400,
          },
        };
      });
      await stub.bulkIndex(rows);
    }

    const after = await stub.databaseSize();
    const endRows = (await stub.stats()).total;
    const added = endRows - startRows;
    const bytesPerRow = added > 0 ? (after - before) / added : 0;
    const LIMIT = 10 * 1024 * 1024 * 1024;

    return Response.json({
      rowsAdded: added,
      totalRows: endRows,
      databaseSizeBefore: before,
      databaseSizeAfter: after,
      bytesPerRow: Math.round(bytesPerRow),
      limitBytes: LIMIT,
      estimatedCapacity: bytesPerRow > 0 ? Math.floor(LIMIT / bytesPerRow) : null,
    });
  }

  if (path === "/__dev/search") {
    const { address, ...query } = (await request.json()) as {
      address?: string;
      q?: string;
      cursor?: number | null;
      limit?: number;
      maxScan?: number;
      label?: string;
      unreadOnly?: boolean;
    };
    if (!address || !query.q) {
      return Response.json({ error: "address and q required" }, { status: 400 });
    }
    const page = await mailboxStub(env, address).searchText({ ...query, q: query.q });
    return Response.json({
      ...page,
      results: page.results.map((m) => ({
        seq: m.seq,
        subject: m.subject,
        sender: m.sender,
        label: m.label,
        received_at: m.received_at,
      })),
    });
  }

  if (path === "/__dev/fts") {
    // Is FTS5 compiled into Durable Object SQLite? Decides whether full-text
    // search is a virtual table here or an external index.
    const { address } = (await request.json()) as { address?: string };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    return Response.json(await mailboxStub(env, address).probeFts());
  }

  if (path === "/__dev/threadseed") {
    const { address, threadId, count = 500, bodyChars = 10000 } = (await request.json()) as {
      address?: string;
      threadId?: string;
      count?: number;
      bodyChars?: number;
    };
    if (!address || !threadId) {
      return Response.json({ error: "address and threadId required" }, { status: 400 });
    }
    const stub = threadStub(env, address, threadId);
    const filler =
      "We have reviewed the proposal in detail and would like to discuss the delivery " +
      "schedule, payment terms, and warranty provisions before we countersign. ";
    const before = await stub.databaseSize();

    for (let written = 0; written < count; written += 100) {
      const size = Math.min(100, count - written);
      await stub.bulkAppend(
        { mailbox: address, threadId },
        Array.from({ length: size }, (_, i) => {
          const n = written + i;
          const body = filler.repeat(Math.ceil(bodyChars / filler.length)).slice(0, bodyChars);
          return {
            id: crypto.randomUUID(),
            direction: "in" as const,
            sender: `sender${n}@example.net`,
            recipient: address,
            subject: `Message ${n}`,
            snippet: body.slice(0, 140),
            bodyText: body,
            bodyHtml: null,
            messageId: `<seed-${n}-${crypto.randomUUID()}@example.net>`,
            inReplyTo: null,
            references: null,
            receivedAt: Date.now() - n * 1000,
            size: bodyChars,
            r2Prefix: `mail/seed/${crypto.randomUUID()}`,
            r2RawKey: null,
          };
        }),
      );
    }

    const after = await stub.databaseSize();
    return Response.json({
      messages: await stub.count(),
      before,
      after,
      bytesPerMessage: Math.round((after - before) / count),
    });
  }

  if (path === "/__dev/sendfile") {
    // Exercises the real multipart path: same parsing and validation the
    // compose form uses, without needing Clerk.
    const form = await request.formData();
    const from = normalizeAddress(String(form.get("from") ?? ""));
    const to = parseRecipientList(String(form.get("to") ?? ""));
    const cc = parseRecipientList(String(form.get("cc") ?? ""));
    const bcc = parseRecipientList(String(form.get("bcc") ?? ""));
    if (!from || to.length === 0) {
      return Response.json({ error: "from and to required" }, { status: 400 });
    }

    // A parentId lets this exercise the reply path's re-attach behaviour.
    let parentAttachments: ThreadAttachment[] = [];
    const parentId = form.get("parentId");
    if (typeof parentId === "string" && parentId) {
      const row = await mailboxStub(env, from).lookup(parentId);
      if (row) {
        const found = await threadStub(env, from, row.thread_id).get(parentId);
        parentAttachments = found?.attachments ?? [];
      }
    }

    const attachments = await collectAttachments(env, form, parentAttachments);
    try {
      const result = await send(env, {
        from,
        to,
        cc,
        bcc,
        subject: String(form.get("subject") ?? "(no subject)"),
        text: String(form.get("body") ?? ""),
        attachments,
      });
      return Response.json({
        ...result,
        // Report the sanitized names actually stored, not the raw input.
        sent: attachments.map((a) => ({
          filename: sanitizeFilename(a.filename),
          type: a.contentType,
          bytes: a.content.byteLength,
        })),
      });
    } catch (err) {
      return Response.json(
        {
          error: err instanceof Error ? err.message : String(err),
          kind:
            err instanceof AttachmentError
              ? "attachment"
              : err instanceof RecipientError
                ? "recipient"
                : err instanceof SuppressedRecipientError
                  ? "suppressed"
                  : "send",
        },
        {
          status:
            err instanceof AttachmentError
              ? 413
              : err instanceof RecipientError || err instanceof SuppressedRecipientError
                ? 400
                : 502,
        },
      );
    }
  }

  if (path === "/__dev/posture") {
    const { domain } = (await request.json()) as { domain?: string };
    return Response.json(await checkPosture(domain || env.MAIL_DOMAIN));
  }

  if (path === "/__dev/outbox") {
    const { address, drain, dueNow } = (await request.json()) as {
      address?: string; drain?: boolean; dueNow?: boolean;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const stub = mailboxStub(env, address);
    if (dueNow) await stub.makeOutboxDue();
    const drained = drain ? await stub.drainOutbox() : null;
    return Response.json({ ...(drained ? { drained } : {}), stats: await stub.outboxStats() });
  }

  if (path === "/__dev/suppressions") {
    const { address, add, remove, reason } = (await request.json()) as {
      address?: string; add?: string; remove?: string; reason?: string;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const stub = mailboxStub(env, address);
    if (add) await stub.suppress(add, reason ?? "manual", null);
    if (remove) await stub.unsuppress(remove);
    return Response.json({ suppressions: await stub.listSuppressions() });
  }

  if (path === "/__dev/draft") {
    // Clone before reading: the handlers below consume the body themselves,
    // and a Request body can only be read once.
    const form = await request.clone().formData();
    const address = normalizeAddress(String(form.get("address") ?? ""));
    const op = String(form.get("op") ?? "save");
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const stub = mailboxStub(env, address);

    if (op === "list") {
      const drafts = await stub.listDrafts();
      return Response.json({
        count: drafts.length,
        drafts: drafts.map((d) => ({
          id: d.id,
          to: d.to,
          subject: d.subject,
          files: d.attachments_json
            ? (JSON.parse(d.attachments_json) as unknown[]).length
            : 0,
        })),
      });
    }
    if (op === "save") {
      await saveDraftFromForm(request, env, address, stub);
      const drafts = await stub.listDrafts();
      return Response.json({ saved: true, count: drafts.length });
    }
    if (op === "send") {
      const response = await sendFromForm(request, env, address, null, null, null, []);
      const location = response.headers.get("location") ?? "";
      return Response.json({
        sent: response.status === 303,
        flash: decodeURIComponent(location.split("=").slice(1).join("=")),
        draftsLeft: (await stub.listDrafts()).length,
      });
    }
    return Response.json({ error: "unknown op" }, { status: 400 });
  }

  if (path === "/__dev/action") {
    const { address, id, action } = (await request.json()) as {
      address?: string; id?: string; action?: string;
    };
    if (!address || !id || !action) {
      return Response.json({ error: "address, id, action required" }, { status: 400 });
    }
    const stub = mailboxStub(env, address);
    const row = await stub.lookup(id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });

    if (action === "trash") await stub.trash(id);
    else if (action === "restore") await stub.restore(id);
    else if (action === "star") await stub.setStarred(id, true);
    else if (action === "unstar") await stub.setStarred(id, false);
    else if (action === "unread") await stub.setRead(id, false);
    else if (action === "purge") {
      if (row.deleted_at === null) {
        return Response.json({ error: "must be in trash first" }, { status: 409 });
      }
      const keys = await threadStub(env, address, row.thread_id).remove(id);
      await Promise.all(keys.map((k) => env.MAIL_ARCHIVE.delete(k)));
      await stub.unindex(id);
      return Response.json({ purged: true, r2KeysDeleted: keys });
    } else return Response.json({ error: "unknown action" }, { status: 400 });

    return Response.json({ ok: true, ...(await stub.stats()) });
  }

  if (path === "/__dev/listview") {
    const { address, view, before, limit } = (await request.json()) as {
      address?: string; view?: string; before?: number; limit?: number;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const rows = await mailboxStub(env, address).list(limit ?? 5, 0, {
      before,
      trash: view === "trash",
      starred: view === "starred",
    });
    return Response.json({
      count: rows.length,
      messages: rows.map((m) => ({ seq: m.seq, subject: m.subject, starred: m.starred, read: m.read })),
    });
  }

  if (path === "/__dev/body") {
    const { address, id, images } = (await request.json()) as {
      address?: string;
      id?: string;
      images?: boolean;
    };
    if (!address || !id) return Response.json({ error: "address and id required" }, { status: 400 });
    const row = await mailboxStub(env, address).lookup(id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    const found = await threadStub(env, address, row.thread_id).get(id);
    if (!found?.message.body_html) return Response.json({ error: "no html body" }, { status: 404 });
    const result = await sanitizeEmailHtml(found.message.body_html, {
      allowRemoteImages: Boolean(images),
      resolveCid: (cid) => {
        const att = found.attachments.find((a) => a.content_id === cid);
        return att ? `/att/${att.id}` : null;
      },
    });
    return Response.json(result);
  }

  if (path === "/__dev/pressure") {
    const { address, threadId, relieve } = (await request.json()) as {
      address?: string;
      threadId?: string;
      relieve?: boolean;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });

    if (threadId) {
      const stub = threadStub(env, address, threadId);
      return Response.json({
        scope: "thread",
        pressure: await stub.pressure(),
        ...(relieve ? { relief: await stub.relieve() } : {}),
      });
    }

    const stub = mailboxStub(env, address);
    return Response.json({
      scope: "mailbox",
      pressure: await stub.pressure(),
      ...(relieve ? { relief: await stub.relieve() } : {}),
    });
  }

  if (path === "/__dev/reclaim") {
    const { address, threadId } = (await request.json()) as {
      address?: string;
      threadId?: string;
    };
    if (!address || !threadId) {
      return Response.json({ error: "address and threadId required" }, { status: 400 });
    }
    return Response.json(await threadStub(env, address, threadId).reclaim());
  }

  if (path === "/__dev/threadsize") {
    const { address, threadId } = (await request.json()) as {
      address?: string;
      threadId?: string;
    };
    if (!address || !threadId) {
      return Response.json({ error: "address and threadId required" }, { status: 400 });
    }
    const stub = threadStub(env, address, threadId);
    const [size, count] = await Promise.all([stub.databaseSize(), stub.count()]);
    return Response.json({ threadId, databaseSize: size, messages: count });
  }

  if (path === "/__dev/sweep") {
    const { address, threadId, olderThanDays } = (await request.json()) as {
      address?: string;
      threadId?: string;
      olderThanDays?: number;
    };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const cutoff = Date.now() - (olderThanDays ?? 0) * 86_400_000;

    // No threadId sweeps every thread in the mailbox.
    const mailbox = mailboxStub(env, address);
    const targets = threadId
      ? [threadId]
      : [...new Set((await mailbox.list(500, 0)).map((m) => m.thread_id))];

    let archived = 0;
    let bytes = 0;
    for (const target of targets) {
      const result = await threadStub(env, address, target).sweep(cutoff);
      archived += result.archived;
      bytes += result.bytes;
    }
    return Response.json({ address, cutoff, threads: targets.length, archived, bytes });
  }

  if (path === "/__dev/send") {
    const { from, to, subject, text, replyToStoredId } = (await request.json()) as {
      from?: string; to?: string; subject?: string; text?: string; replyToStoredId?: string;
    };
    if (!from || !to) return Response.json({ error: "from and to required" }, { status: 400 });
    const stub = mailboxStub(env, from);
    let parent: ThreadMessage | null = null;
    let threadId: string | null = null;
    if (replyToStoredId) {
      const row = await stub.lookup(replyToStoredId);
      if (row) {
        threadId = row.thread_id;
        parent = (await threadStub(env, from, row.thread_id).get(replyToStoredId))?.message ?? null;
      }
    }
    try {
      const result = await send(env, {
        from, to,
        subject: subject ?? "(no subject)",
        text: text ?? "",
        inReplyTo: parent,
        threadId,
      });
      return Response.json(result, { status: 201 });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (path === "/__dev/list") {
    const { address } = (await request.json()) as { address?: string };
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const stub = mailboxStub(env, address);
    if (await stub.backfillPending()) await stub.backfill();
    const [messages, stats, owner] = await Promise.all([
      stub.list(50, 0),
      stub.stats(),
      stub.ownerOrgId(),
    ]);
    return Response.json({ owner, stats, messages });
  }

  return new Response("Not found", { status: 404 });
}

/**
 * Local-only inbound injection, so the whole receive path can be exercised
 * before a domain is onboarded and MX records point anywhere.
 *
 *   curl -X POST localhost:8787/__dev/inbound \
 *     -H 'content-type: application/json' \
 *     -d '{"from":"alice@example.net","to":"sales@example.com","subject":"Hi","text":"Hello"}'
 */
async function handleDevInbound(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json()) as {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    inReplyTo?: string;
    /** Full MIME to inject verbatim, for exercising multipart/attachments. */
    raw?: string;
  };
  const from = normalizeAddress(payload.from ?? "sender@example.net");
  const to = normalizeAddress(payload.to ?? `postmaster@${env.MAIL_DOMAIN}`);
  const subject = payload.subject ?? "(no subject)";
  const text = payload.text ?? "";

  const raw = payload.raw ?? [
    `Message-ID: <${crypto.randomUUID()}@dev.local>`,
    ...(payload.inReplyTo ? [`In-Reply-To: ${payload.inReplyTo}`, `References: ${payload.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString()}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    text,
  ].join("\r\n");

  const buffer = new TextEncoder().encode(raw).buffer as ArrayBuffer;
  const result = await ingest(env, { from, to, rawSize: buffer.byteLength }, buffer);

  return Response.json(result, { status: result.status === "stored" ? 201 : 422 });
}
