/**
 * Words about folder rules, from a Workers AI text model: why a message
 * didn't land in a folder, and a tidier rewrite of a rule
 * (designs/2026-09-24-why-not-folder).
 *
 * The scores always come from the filing model (typesafe/jev, src/classify.ts),
 * which only returns numbers. This model reads the same email and rule and
 * explains; it never changes a score or files anything.
 */
import type { EmailForClassify } from "./classify";

/** Text model with a JSON mode. One place to change it. */
export const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A rule's sentences, as the UI numbers and highlights them. Bullets and headings become sentences too. */
export function ruleSentences(rule: string): string[] {
  return rule
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((s) => s.length > 0 && !/^(goes in|leaves out|stays out)\s*:?$/i.test(s));
}

/** A short stable hash, to notice when a rule has changed since an answer was cached. */
export function ruleHash(rule: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < rule.length; i++) h = Math.imul(h ^ rule.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

async function askJson(env: Env, system: string, user: string, schema: object, maxTokens = 900): Promise<unknown> {
  const out = (await env.AI.run(TEXT_MODEL as never, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: maxTokens,
    temperature: 0.2,
  } as never, {
    gateway: { id: String(env.AI_GATEWAY_ID ?? "default") },
  } as never)) as { response?: unknown };
  const r = out?.response;
  if (r && typeof r === "object") return r;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  }
  throw new Error(`text model returned no JSON: ${JSON.stringify(out).slice(0, 300)}`);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---- why not this folder -------------------------------------------------

export interface Explanation {
  /** One plain sentence: why it didn't go in. */
  summary: string;
  /** The rule's closest sentences, by index into ruleSentences(rule). */
  closest: { index: number; verdict: "match" | "near" | "no"; reason: string }[];
  /** One line on the rest of the rule. */
  others: string;
  /** Words or phrases from the email the reasoning relied on (verbatim). */
  evidence: string[];
  /** Keywords you might add, and where each came from. */
  keywords: { text: string; source: "email" | "rule" | "sender" }[];
  /** A sentence to add to the rule so mail like this goes in. */
  suggestion: string;
}

const EXPLAIN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    closest: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          verdict: { type: "string", enum: ["match", "near", "no"] },
          reason: { type: "string" },
        },
        required: ["index", "verdict", "reason"],
      },
    },
    others: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    keywords: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, source: { type: "string", enum: ["email", "rule", "sender"] } },
        required: ["text", "source"],
      },
    },
    suggestion: { type: "string" },
  },
  required: ["summary", "closest", "others", "evidence", "keywords", "suggestion"],
};

export async function explainFolder(
  env: Env,
  email: EmailForClassify & { mailbox: string },
  folder: { name: string; rule: string },
  score: number | null,
): Promise<Explanation> {
  const sentences = ruleSentences(folder.rule);
  const body = email.body.replace(/\s+/g, " ").trim().slice(0, 2500);
  const system = [
    "You explain an email filing decision to the mailbox owner, in plain, friendly English, speaking to them as \"you\".",
    "A classifier decided an email does not belong in one of the owner's folders. Explain why, using only the email and the folder's rule.",
    "Be concrete and short: each reason is one sentence under 25 words. Do not mention AI, models, probabilities or scores.",
    `The owner's own address is ${email.mailbox}. If the sender looks like the owner themselves (same name or their other address), say so: people rarely mean themselves by "someone I know".`,
    "closest: the 1-3 rule sentences that came closest, by their number, each with verdict near (almost fits) or no (doesn't fit), and why it didn't fit this email.",
    "evidence: 1-5 short words or phrases copied exactly from the email's subject or body that the reasons rely on.",
    "keywords: 2-5 short phrases the owner could add to the rule so emails like this one go in. source is email (a word from the email), rule (a broadening of their own wording) or sender (about who sent it).",
    "suggestion: one sentence, in the owner's voice, to add to the rule so emails like this one go in without pulling in unrelated mail.",
  ].join("\n");
  const user = [
    `Folder: ${folder.name}`,
    "Rule sentences:",
    ...sentences.map((s, i) => `${i}. ${s}`),
    score === null ? "" : `The classifier gave it ${Math.round(score * 100)}% for this folder; it files at 75%.`,
    "",
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `Body: ${body || "(empty)"}`,
  ].join("\n");

  const raw = (await askJson(env, system, user, EXPLAIN_SCHEMA)) as Record<string, unknown>;
  const haystack = `${email.subject}\n${body}`.toLowerCase();
  const closest = (Array.isArray(raw.closest) ? raw.closest : [])
    .map((c) => c as Record<string, unknown>)
    .filter((c) => Number.isInteger(c.index) && (c.index as number) >= 0 && (c.index as number) < sentences.length)
    .slice(0, 3)
    .map((c) => ({
      index: c.index as number,
      verdict: (["match", "near", "no"].includes(c.verdict as string) ? c.verdict : "no") as "match" | "near" | "no",
      reason: str(c.reason, 240),
    }));
  return {
    summary: str(raw.summary, 300),
    closest,
    others: str(raw.others, 240),
    // Only words that are really in the email can be highlighted.
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map((e) => str(e, 60))
      .filter((e) => e && haystack.includes(e.toLowerCase()))
      .slice(0, 5),
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => k as Record<string, unknown>)
      .map((k) => ({ text: str(k.text, 60), source: (["email", "rule", "sender"].includes(k.source as string) ? k.source : "email") as "email" | "rule" | "sender" }))
      .filter((k) => k.text)
      .slice(0, 5),
    suggestion: str(raw.suggestion, 300),
  };
}

// ---- tidy up ---------------------------------------------------------------

export interface Tidied {
  goesIn: string[];
  leavesOut: string[];
  /** The rule as it would be saved. */
  text: string;
}

const TIDY_SCHEMA = {
  type: "object",
  properties: {
    goesIn: { type: "array", items: { type: "string" } },
    leavesOut: { type: "array", items: { type: "string" } },
  },
  required: ["goesIn", "leavesOut"],
};

export function formatTidied(goesIn: string[], leavesOut: string[]): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return leavesOut.length ? `Goes in:\n${list(goesIn)}\n\nLeaves out:\n${list(leavesOut)}` : `Goes in:\n${list(goesIn)}`;
}

export async function tidyRule(env: Env, folder: { name: string; rule: string }): Promise<Tidied> {
  const system = [
    "You tidy up a plain-English email filing rule so a person can read it at a glance.",
    "Rewrite it as two short lists: goesIn (what belongs in the folder) and leavesOut (what the rule explicitly excludes).",
    "Keep every condition exactly as broad or narrow as written. Do not add conditions, examples or exclusions that are not in the rule.",
    "An exclusion that belongs to one condition (like \"from my bank, not its marketing\") stays inside that item; only rule-wide exclusions go in leavesOut, and leavesOut is often empty.",
    "Fix spelling and grammar, merge exact repeats, keep names and specific words, and keep the owner's voice (\"my\", \"I\").",
    "Each item is a short phrase without a trailing period. At most 10 items per list.",
  ].join("\n");
  const raw = (await askJson(env, system, `Folder: ${folder.name}\nRule:\n${folder.rule}`, TIDY_SCHEMA, 700)) as Record<string, unknown>;
  const clean = (v: unknown) =>
    (Array.isArray(v) ? v : []).map((x) => str(x, 200).replace(/[.;]+$/, "")).filter(Boolean).slice(0, 10);
  const goesIn = clean(raw.goesIn);
  const leavesOut = clean(raw.leavesOut);
  if (goesIn.length === 0) throw new Error("The rewrite came back empty. Try again.");
  return { goesIn, leavesOut, text: formatTidied(goesIn, leavesOut) };
}
