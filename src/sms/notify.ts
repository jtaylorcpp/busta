/**
 * "Texts about new mail" (designs/2026-09-25-text-busta): when a new message
 * is filed by rule into a folder a user picked, text them, right away.
 *
 * Guards, from the threat model:
 *   - Only mail that passes DMARC as seen by our own receiving server, so a
 *     spoofed "bank" email can't turn into a text from Busta's number (T22).
 *   - Never security mail: codes, reset links, sign-in alerts (T1).
 *   - Sender and subject only if the user opted in, stripped of URLs and
 *     phone numbers (T5, T14); a link only if links are on.
 *   - At most 20 texts an hour per user (T21).
 *   - Before a link goes out, the SIM/carrier is checked (at most every 6
 *     hours); a change pauses texting until the user re-verifies (T1, T9).
 */
import { mailboxStub, tenantStub } from "../mail";
import { decodeAuth } from "../metadata";
import type { Folder, IndexedMessage } from "../mailbox-do";
import type { TextingView } from "../tenant-do";
import { createLink } from "./links";
import { lookupLine, sendSms } from "./twilio";

const LINE_CHECK_MS = 6 * 3_600_000;

/** Codes, reset links, sign-in and security alerts: never texted, never searched by text. */
export function isSecurityMail(subject: string, snippet: string): boolean {
  const s = `${subject}\n${snippet}`.toLowerCase();
  return /verification code|security code|one[- ]time (pass)?code|\botp\b|passcode|login code|sign[- ]?in code|2-step|two[- ]factor|\b2fa\b|reset (your )?password|password reset|forgot (your )?password|new sign[- ]?in|sign[- ]?in attempt|login attempt|new device|security alert|unusual (activity|sign)|confirm (your )?(email|account)|magic link|log in to your account/.test(s);
}

/** No links or phone numbers from an email's own text in a text from Busta. */
export function scrub(text: string, max: number): string {
  const t = text
    .replace(/https?:\/\/\S+|www\.\S+|\b[\w-]+\.(com|net|org|io|app|co|us|info|biz)(\/\S*)?/gi, "[link]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Is the phone still the one that was verified? Checks carrier (and SIM swap
 * where the carrier shares it) at most every 6 hours; pauses texting on a change.
 */
export async function lineStillTrusted(env: Env, orgId: string, v: TextingView): Promise<boolean> {
  const tenant = tenantStub(env, orgId);
  const last = (await tenant.textingLineCheckedAt(v.userId)) as number | null;
  if (last && Date.now() - last < LINE_CHECK_MS) return true;
  try {
    const line = await lookupLine(env, v.phone!);
    await tenant.markTextingLineChecked(v.userId);
    const swapped = (line.simSwappedAt !== null && v.verifiedAt !== null && line.simSwappedAt > v.verifiedAt) || line.simSwappedRecently === true;
    const ported = v.carrier !== null && line.carrier !== null && line.carrier !== v.carrier;
    if (swapped || ported) {
      await tenant.pauseTexting(v.userId, swapped ? "Your phone's SIM changed." : "Your number moved to another carrier.");
      return false;
    }
    return true;
  } catch (e) {
    // Lookup down: don't block a notification on it; the next one retries.
    console.error("texting: line check failed", String(e));
    return true;
  }
}

/** Text the users who asked for this folder. Never throws. */
export async function notifyFiled(env: Env, address: string, messageId: string, folder: Folder): Promise<void> {
  try {
    const mailbox = mailboxStub(env, address);
    const orgId = (await mailbox.ownerOrgId()) as string | null;
    if (!orgId) return;
    const row = (await mailbox.lookup(messageId)) as IndexedMessage | null;
    if (!row || row.direction !== "in" || row.deleted_at !== null) return;
    if (decodeAuth(row.auth).dmarc !== "pass") return;
    if (isSecurityMail(row.subject, row.snippet)) return;

    const key = folder.name.trim().replace(/\s+/g, " ").toLowerCase();
    const users = (await tenantStub(env, orgId).textingForFolder(key)) as TextingView[];
    for (const v of users) {
      if (!v.phone) continue;
      const tenant = tenantStub(env, orgId);
      let link = "";
      if (v.features.links) {
        if (!(await lineStillTrusted(env, orgId, v))) continue;
        const who = row.from_name || row.sender;
        const label = v.features.subject ? `${scrub(who, 40)}: ${scrub(row.subject || "(no subject)", 80)}` : `An email in ${folder.name}`;
        link = ` ${await createLink(env, { kind: "email", orgId, userId: v.userId, address, messageId, label })}`;
      }
      const head = v.features.subject
        ? `${folder.name} · ${scrub(row.from_name || row.sender, 30)}: ${scrub(row.subject || "(no subject)", 160 - link.length - folder.name.length - 40)}`
        : `New email in ${folder.name}`;
      if (!(await tenant.textingReserveSend(v.userId))) continue;
      await sendSms(env, v.phone, `${head}${link}`);
    }
  } catch (e) {
    console.error("texting: notify failed", String(e));
  }
}
