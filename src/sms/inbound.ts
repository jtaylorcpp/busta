/**
 * POST /hooks/sms — a text to Busta's number (designs/2026-09-25-text-busta).
 *
 * Only Twilio can call this (X-Twilio-Signature over the exact URL), and each
 * MessageSid is handled once. Then, in order:
 *   STOP / START / HELP   carrier keywords (STOP turns every feature off)
 *   unknown number        one reply a day, then silence
 *   LINK                  a new link to the last email texted (12 h, 3 times)
 *   anything else         a question, if Ask by text is on
 * Every reply goes to the verified number on file, never to anyone else, so
 * a spoofed sender can't read an answer.
 */
import { phoneStub, tenantStub } from "../mail";
import type { TextingView } from "../tenant-do";
import { createLink } from "./links";
import { lineStillTrusted } from "./notify";
import { sendSms, toE164, twilioFake, validSignature } from "./twilio";

/** An empty TwiML reply: Busta answers through the API, not in the webhook response. */
const empty = () => new Response("<Response/>", { headers: { "content-type": "text/xml" } });

export async function smsWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);
  const url = `${(env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, "")}/hooks/sms`;
  // The local fake (development, no Twilio configured) has no token to sign with.
  if (!twilioFake(env) && !(await validSignature(env, url, params, request.headers.get("x-twilio-signature")))) {
    return new Response("Forbidden", { status: 403 });
  }
  const from = toE164(params.From ?? "");
  const sid = params.MessageSid ?? "";
  if (!from || !sid) return empty();
  const phone = phoneStub(env, from);
  if (!(await phone.firstDelivery(sid))) return empty();
  ctx.waitUntil(handle(env, from, (params.Body ?? "").trim()).catch((e) => console.error("sms inbound failed", String(e))));
  return empty();
}

async function handle(env: Env, from: string, body: string): Promise<void> {
  const word = body.toUpperCase().replace(/[^A-Z]/g, "");
  const phone = phoneStub(env, from);
  const owner = (await phone.owner()) as { userId: string; orgId: string } | null;

  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(word)) {
    // Twilio blocks further texts itself; turn everything off here too.
    if (owner) for (const f of ["notify", "subject", "links", "ask"] as const) await tenantStub(env, owner.orgId).setTextingFeature(owner.userId, f, false);
    return;
  }
  if (word === "START" || word === "UNSTOP") return; // features stay off until turned on again in settings
  if (word === "HELP" || word === "INFO") {
    await sendSms(env, from, "Busta: text a question about your mail, or LINK for a new link to your last email. STOP to stop all texts. Msg&data rates may apply.");
    return;
  }
  if (!owner) {
    if (await phone.mayReplyUnknown()) await sendSms(env, from, `This number isn't set up for Busta. Add it in Busta's Texting settings.`);
    return;
  }

  const tenant = tenantStub(env, owner.orgId);
  const v = (await tenant.texting(owner.userId)) as TextingView;
  if (!v.phone || v.phone !== from) return; // mapping is stale: say nothing
  if (v.paused) {
    await sendSms(env, from, `Busta texting is paused: ${v.paused} Re-verify your phone in Busta's Texting settings.`);
    return;
  }

  if (word === "LINK") {
    const last = (await tenant.lastNotified(owner.userId)) as { address: string; messageId: string; label: string; at: number; reissues: number } | null;
    if (!v.features.links) { await sendSms(env, from, "Links are off. Turn them on in Busta's Texting settings."); return; }
    if (!last || Date.now() - last.at > 12 * 3_600_000 || last.reissues >= 3) { await sendSms(env, from, "No recent email to link to."); return; }
    if (!(await lineStillTrusted(env, owner.orgId, v))) return;
    const link = await createLink(env, { kind: "email", orgId: owner.orgId, userId: owner.userId, address: last.address, messageId: last.messageId, label: last.label });
    await tenant.setLastNotified(owner.userId, { ...last, reissues: last.reissues + 1 });
    await sendSms(env, from, `New link: ${link}`);
    return;
  }

  if (!v.features.ask) {
    await sendSms(env, from, "Ask by text is off. Turn it on in Busta's Texting settings.");
    return;
  }
  if (!v.hasPin) return;
  if (!(await lineStillTrusted(env, owner.orgId, v))) return;
  if (!(await tenant.textingReserveAsk(owner.userId))) {
    await sendSms(env, from, "That's 30 questions today. Try again tomorrow.");
    return;
  }
  const question = body.slice(0, 500);
  const id = crypto.randomUUID();
  await tenant.logQuestion({ id, userId: owner.userId, question, status: "working" });
  await sendSms(env, from, "Looking…");
  await env.ASK.get(env.ASK.idFromName(id)).start({ id, orgId: owner.orgId, userId: owner.userId, phone: from, question });
}

