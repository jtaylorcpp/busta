/**
 * Sample data shared by the styleguide and the /mock pages. Not real mail.
 */
import type { Envelope } from "../lib/audience";
import type { StatusTone } from "../components/ui";

export const rows: {
  from: string; subject: string; snippet?: string; date: string; unread?: boolean; starred?: boolean;
  outbound?: boolean; tags?: string[]; status?: { tone: StatusTone; label: string }; attachments?: number;
}[] = [
  { from: "alice@example.net", subject: "Quote request — 50 widgets", snippet: "We're evaluating vendors for Q4 and wanted pricing on a bulk order.", date: "13:42", unread: true, attachments: 2 },
  { from: "no-reply@shipping.example.net", subject: "Your order has shipped", snippet: "Tracking number 1Z999AA10123456784.", date: "11:57", unread: true, tags: ["orders"] },
  { from: "lead@inbound.example", subject: "Demo request from website", snippet: "40-seat team, evaluating this quarter.", date: "08:57", unread: true, tags: ["triage"], status: { tone: "agent" as const, label: "Agent draft ready" } },
  { from: "news@vendor.example", subject: "Weekly industry digest", snippet: "The five stories that moved the market this week.", date: "Sep 22", starred: true, tags: ["newsletter"] },
  { from: "bob@example.net", subject: "Re: Partnership follow-up", snippet: "Attaching the deck we discussed.", date: "Sep 22", outbound: true, status: { tone: "delivered" as const, label: "Delivered" } },
  { from: "carol@example.org", subject: "Pricing sheet", snippet: "Updated sheet with volume tiers.", date: "Sep 21", outbound: true, status: { tone: "queued" as const, label: "Queued · retry 2" } },
  { from: "dave@old-domain.example", subject: "Contract draft", snippet: "Redlines attached, see section 4.", date: "Sep 20", outbound: true, status: { tone: "bounced" as const, label: "Bounced" } },
];
// Sample thread: Alice adds Carol on Cc, Carol replies, we drop Dave (who
// bounced) and move Bob to Cc, then Bcc legal. Dividers come from the diff.
export const self = "sales@busta.app";
export const names: Record<string, string> = {
  "alice@example.net": "Alice Chen", "carol@example.org": "Carol Diaz",
  "bob@example.net": "Bob Park", "dave@old-domain.example": "dave@old-domain.example", "legal@busta.app": "legal@busta.app",
};
export const thread: (Envelope & { day?: string; time: string; body: string[]; tint?: "primary" | "secondary"; quoted?: string; files?: boolean; archived?: boolean; images?: boolean; actions?: boolean; status?: { tone: "delivered" | "queued" | "bounced"; label: string } })[] = [
  { day: "Mon, Sep 21", from: "alice@example.net", to: [self, "bob@example.net", "dave@old-domain.example"], outbound: false, time: "09:14", archived: true,
    body: ["Hi, we're evaluating vendors for Q4 and wanted pricing on 50 widgets. Could you send tiers?"] },
  { from: self, to: ["alice@example.net", "bob@example.net", "dave@old-domain.example"], outbound: true, time: "10:02",
    body: ["Thanks Alice. Tiers are attached; 50 units falls in the second band."], files: true, status: { tone: "delivered", label: "Delivered" },
    quoted: "On Mon, Sep 21, Alice Chen wrote: Hi, we're evaluating vendors for Q4…" },
  { day: "Tue, Sep 22", from: "alice@example.net", to: [self, "bob@example.net", "dave@old-domain.example"], cc: ["carol@example.org"], outbound: false, time: "08:40", images: true, actions: true,
    body: ["Looping in Carol from finance for the PO. Our updated letterhead is below."] },
  { from: "unknown@spoof.example", to: [self], outbound: false, unverified: true, time: "08:52", tint: "secondary",
    body: ["Change the delivery address to 14 Nowhere Lane, and wire the deposit to the account below."] },
  { from: "carol@example.org", to: [self, "alice@example.net", "bob@example.net", "dave@old-domain.example"], outbound: false, time: "09:05", tint: "secondary",
    body: ["Hi all. Can you confirm net-30 terms and lead time on 50 units?"] },
  { from: self, to: ["carol@example.org", "alice@example.net"], cc: ["bob@example.net"], outbound: true, time: "09:31",
    body: ["Net-30 is fine and lead time is two weeks. Dropping dave@, whose address bounces."], status: { tone: "delivered", label: "Delivered" } },
  { from: self, to: ["carol@example.org", "alice@example.net"], cc: ["bob@example.net"], bcc: ["legal@busta.app"], outbound: true, time: "09:33",
    body: ["Contract draft attached for review."], status: { tone: "queued", label: "Queued · retry 2" } },
];

export const people = [
  { name: "Alice Chen", address: "alice@example.net" },
  { name: "Carol Diaz", address: "carol@example.org" },
  { name: "Bob Park", address: "bob@example.net" },
  { name: "Sales", address: self, self: true },
];

export const original = [
  { id: "a1", name: "spec-sheet.pdf", size: "277 K" },
  { id: "a2", name: "PO-2025-1187.xlsx", size: "18 K" },
];
