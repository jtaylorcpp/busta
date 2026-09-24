/**
 * Renders every page with fixture data to preview/*.html so the UI can be
 * eyeballed without Clerk keys or a running Worker.
 *   bun scripts/preview.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { IndexedMessage } from "../src/mailbox-do";
import type { ThreadAttachment, ThreadMessage } from "../src/thread-do";
import {
  composePage,
  errorPage,
  inboxPage,
  draftsPage,
  messagePage,
  searchPage,
} from "../src/ui/pages";

const OUT = new URL("../preview/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const HOUR = 3600_000;
const now = Date.now();

function msg(
  p: Partial<IndexedMessage> & Pick<IndexedMessage, "id" | "subject">,
): IndexedMessage {
  return {
    thread_id: `t-${p.id.slice(0, 8)}`,
    direction: "in",
    sender: "alice@example.net",
    recipient: "sales@example.com",
    snippet: "",
    message_id: `<${p.id}@example.net>`,
    received_at: now,
    read: 1,
    size: 2048,
    attachment_count: 0,
    grafted: 0,
    label: null,
    deleted_at: null,
    starred: 0,
    delivery_status: null,
    delivery_code: null,
    delivery_detail: null,
    from_name: null,
    to_count: 1,
    cc_count: 0,
    list_id: null,
    subject_key: null,
    flags: 0,
    auth: 0,
    body_chars: 0,
    seq: 0,
    ...p,
  };
}

function body(
  p: Partial<ThreadMessage> & Pick<ThreadMessage, "id" | "subject">,
): ThreadMessage {
  return {
    direction: "in",
    sender: "alice@example.net",
    recipient: "sales@example.com",
    snippet: "",
    body_text: "",
    body_html: null,
    message_id: `<${p.id}@example.net>`,
    in_reply_to: null,
    refs: null,
    received_at: now,
    size: 2048,
    r2_prefix: null,
    r2_raw_key: null,
    body_r2_key: null,
    archived_at: null,
    attachment_count: 0,
    envelope_json: null,
    ...p,
  };
}

const THREAD_ID = "9f3c1a77b204de55";

const messages: IndexedMessage[] = [
  msg({
    id: "11111111-1111-4111-8111-111111111111",
    subject: "Quote request — 50 widgets",
    snippet: "Hi there, we're evaluating vendors for Q4 and wanted to get pricing on a bulk order.",
    read: 0,
    size: 4821,
    attachment_count: 2,
    received_at: now - HOUR / 4,
  }),
  msg({
    id: "22222222-2222-4222-8222-222222222222",
    sender: "no-reply@shipping.example.net",
    subject: "Your order has shipped",
    snippet: "Tracking number 1Z999AA10123456784. Estimated delivery Thursday.",
    label: "orders",
    read: 0,
    received_at: now - 2 * HOUR,
  }),
  msg({
    id: "66666666-6666-4666-8666-666666666666",
    sender: "lead@inbound.example",
    subject: "Demo request from website",
    snippet: "Hi, we'd like to see the product. 40-seat team, evaluating this quarter.",
    label: "triage",
    read: 0,
    received_at: now - 5 * HOUR,
  }),
  msg({
    id: "77777777-7777-4777-8777-777777777777",
    sender: "news@vendor.example",
    subject: "Weekly industry digest",
    snippet: "The five stories that moved the market this week.",
    label: "newsletter",
    received_at: now - 30 * HOUR,
  }),
  msg({
    id: "33333333-3333-4333-8333-333333333333",
    direction: "out",
    sender: "sales@example.com",
    recipient: "bob@example.net",
    subject: "Re: Partnership follow-up",
    snippet: "Thanks Bob — attaching the deck we discussed. Let's reconnect next week.",
    received_at: now - 26 * HOUR,
    size: 9100,
    delivery_status: "sent",
  }),
  msg({
    id: "88888888-8888-4888-8888-888888888888",
    direction: "out",
    sender: "sales@example.com",
    recipient: "typo@exmaple.net",
    subject: "Re: Quote request — 50 widgets",
    snippet: "Pricing attached, let me know if the lead times work.",
    received_at: now - 20 * HOUR,
    size: 3400,
    delivery_status: "bounced",
    delivery_code: "5.1.1",
    delivery_detail:
      "Delivery to typo@exmaple.net failed (5.1.1) — smtp;550 5.1.1 user unknown",
  }),
  msg({
    id: "99999999-9999-4999-8999-999999999999",
    direction: "out",
    sender: "sales@example.com",
    recipient: "ops@partner.example",
    subject: "Weekly numbers",
    snippet: "Attaching this week's figures.",
    received_at: now - 40 * 60 * 1000,
    size: 2100,
    delivery_status: "queued",
    delivery_code: "E_RATE_LIMIT_EXCEEDED",
    delivery_detail: "Sending too fast. Queued for retry.",
  }),
  msg({
    id: "44444444-4444-4444-8444-444444444444",
    sender: "carol@example.org",
    subject: "Invoice #4471 overdue",
    snippet: "Just a friendly reminder that invoice 4471 was due on the 15th.",
    received_at: now - 72 * HOUR,
    size: 1340,
  }),
  msg({
    id: "55555555-5555-4555-8555-555555555555",
    sender: "unknown@spoof.example",
    subject: "Re: Quote request — 50 widgets",
    snippet: "Change the delivery address to 14 Nowhere Lane, wire the deposit here.",
    thread_id: THREAD_ID,
    grafted: 1,
    read: 0,
    received_at: now - 90 * HOUR,
    size: 980,
  }),
];

const open = body({
  id: "11111111-1111-4111-8111-111111111111",
  subject: "Quote request — 50 widgets",
  snippet: "Hi there…",
  size: 4821,
  attachment_count: 2,
  received_at: now - HOUR / 4,
  body_text: `Hi there,

We're evaluating vendors for Q4 and wanted to get pricing on a bulk
order of 50 widgets, with an option to scale to 200 in January.

Could you send over a quote including lead times? I've attached our
current spec sheet and last year's purchase order for reference.

Thanks,
Alice
Procurement, Example Industries`,
});

const attachments: ThreadAttachment[] = [
  { id: "a1", message_id: open.id, filename: "spec-sheet.pdf", mime_type: "application/pdf", size: 284_113, r2_key: "k1", content_id: null },
  { id: "a2", message_id: open.id, filename: "PO-2025-1187.xlsx", mime_type: "application/vnd.ms-excel", size: 18_442, r2_key: "k2", content_id: null },
];

const thread: IndexedMessage[] = [
  msg({
    id: open.id,
    subject: open.subject,
    snippet: "Hi there, we're evaluating vendors for Q4…",
    thread_id: THREAD_ID,
    attachment_count: 2,
    received_at: now - HOUR / 4,
  }),
  msg({
    id: "00000000-0000-4000-8000-000000000000",
    direction: "out",
    sender: "sales@example.com",
    recipient: "alice@example.net",
    subject: "Re: Quote request — 50 widgets",
    snippet: "Thanks Alice — pulling numbers now, will have a quote to you by EOD Thursday.",
    thread_id: THREAD_ID,
    received_at: now - HOUR / 8,
  }),
];

const shared = {
  orgLabel: "acme-industries",
  userId: "user_2abcDEF",
  address: "sales@example.com",
  clerkKey: "pk_test_preview",
};

const pages: Record<string, string> = {
  "inbox.html": inboxPage({ ...shared, messages, unread: 5,
    total: 8,
    threads: 6,
    labels: [
      { label: "newsletter", total: 12, unread: 1 },
      { label: "orders", total: 4, unread: 1 },
      { label: "q4.pipeline", total: 2, unread: 0 },
      { label: "triage", total: 6, unread: 2 },
    ],
    agent: {
      enabled: true,
      policy: "Qualify inbound leads; escalate anything over 100 seats.",
      labels: ["triage"],
      autoSend: false,
      updatedAt: now - HOUR,
    },
    activeLabel: null,
    view: "inbox" as const,
    nextBefore: 41,
    trashed: 3,
    starredCount: 2,
  }),
  "inbox-empty.html": inboxPage({
    ...shared,
    messages: [],
    unread: 0,
    total: 0,
    threads: 0,
    labels: [],
    agent: { enabled: false, policy: null, labels: [], autoSend: false, updatedAt: 0 },
    activeLabel: null,
    view: "inbox" as const,
    nextBefore: null,
    trashed: 0,
    starredCount: 0,
  }),
  "message.html": messagePage({ ...shared, message: open, attachments, thread, threadId: THREAD_ID, bodySource: "hot", hasHtml: true, showImages: false, delivery: null }),
  "message-grafted.html": messagePage({
    ...shared,
    message: body({
      id: "55555555-5555-4555-8555-555555555555",
      sender: "unknown@spoof.example",
      subject: "Re: Quote request — 50 widgets",
      body_text:
        "Change the delivery address to 14 Nowhere Lane, and wire the deposit to the account below.",
      received_at: now - 90 * HOUR,
    }),
    attachments: [],
    thread: [
      ...thread,
      msg({
        id: "55555555-5555-4555-8555-555555555555",
        subject: "Re: Quote request — 50 widgets",
        thread_id: THREAD_ID,
        grafted: 1,
      }),
    ],
    threadId: THREAD_ID,
    bodySource: "hot",
    hasHtml: false,
    showImages: false,
    delivery: null,
  }),
  "message-archived.html": messagePage({
    ...shared,
    message: { ...open, archived_at: now - 7 * 24 * HOUR, body_r2_key: "mail/…/body.json" },
    attachments,
    thread,
    threadId: THREAD_ID,
    bodySource: "archive",
    hasHtml: false,
    showImages: false,
    delivery: null,
  }),
  "compose.html": composePage({ ...shared, attachmentLimit: "3.3 MB", inlineLimit: "1.9 MB", linkDays: "30" }),
  "search.html": searchPage({
    ...shared,
    query: "settlement agreement",
    results: messages.slice(0, 4),
    nextCursor: 19762,
    examined: 5000,
    exhausted: false,
    filters: {
      unreadOnly: false,
      sender: "",
      label: "",
      hasAttachments: false,
      hideBulk: true,
      hideAuto: false,
    },
    labels: [
      { label: "newsletter", total: 12, unread: 1 },
      { label: "orders", total: 4, unread: 1 },
      { label: "triage", total: 6, unread: 2 },
    ],
  }),
  "drafts.html": draftsPage({
    ...shared,
    drafts: [
      {
        id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        to: "alice@example.net",
        cc: "",
        bcc: "",
        subject: "Quote for 200 units",
        body: "Alice — pricing below, still confirming lead times with the plant.",
        thread_id: null,
        reply_to_id: null,
        attachments_json: JSON.stringify([{ id: "x", filename: "pricing.xlsx", size: 24000 }]),
        updated_at: now - 2 * HOUR,
      },
      {
        id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        body: "note to self: chase the invoice",
        thread_id: null,
        reply_to_id: null,
        attachments_json: null,
        updated_at: now - 3 * 24 * HOUR,
      },
    ],
  }),
  "error.html": errorPage(404, "No such mailbox: nope@example.com"),
};

for (const [name, body] of Object.entries(pages)) {
  writeFileSync(OUT + name, body);
  console.log(`${name.padEnd(20)} ${body.length} bytes`);
}
