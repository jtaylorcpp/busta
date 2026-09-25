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
/** Bump when the prompts change, so cached explanations are asked again. */
export const PROMPT_VERSION = "3";

/** Words that usually start a new condition, used when a period is missing. */
const OPENERS = "Anything|Any|All|Messages|Mail|Emails?|Bills|Nothing|Not|Never|Only|Also";

/** A rule's sentences, as the UI numbers and highlights them. Bullets and headings become sentences too. */
export function ruleSentences(rule: string): string[] {
  return rule
    .split(new RegExp(`\\n+|(?<=[.!?])\\s+(?=[A-Z0-9"'(])|(?<=[a-z,])\\s+(?=(?:${OPENERS})\\b)`))
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((s) => s.length > 0 && !/^(goes in|leaves out|stays out)\s*:?$/i.test(s));
}

/** A short stable hash, to notice when a rule has changed since an answer was cached. */
export function ruleHash(rule: string): string {
  const input = `${PROMPT_VERSION}\n${rule}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export async function askJson(env: Env, system: string, user: string, schema: object, maxTokens = 900): Promise<unknown> {
  const out = (await env.AI.run(TEXT_MODEL as never, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: maxTokens,
    temperature: 0.2,
  } as never, {
    // No prompt/response logging at the gateway: prompts are email text.
    gateway: { id: String(env.AI_GATEWAY_ID ?? "default"), collectLog: false },
  } as never)) as { response?: unknown };
  const r = out?.response;
  if (r && typeof r === "object") return r;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  }
  // Never put the model's output in the error: it can quote the email.
  throw new Error(`text model returned no JSON (${typeof r}, ${typeof r === "string" ? r.length : 0} chars)`);
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
    "A classifier decided an email does not belong in one of the owner's folders. Explain why, using only the email and the folder's numbered rule sentences.",
    "Do not mention AI, models, probabilities or scores.",
    `The owner's own address is ${email.mailbox}. If the sender looks like the owner (same name, or another address of theirs), say so: people rarely mean themselves by "someone I know".`,
    "",
    "Fields:",
    "- summary: one sentence, under 30 words, saying why it didn't fit.",
    "- closest: the 1-3 rule sentences that came closest. index is the sentence number. verdict is near (almost fits) or no (doesn't fit). reason is a full sentence under 25 words saying what about THIS email kept that sentence from fitting.",
    "- others: one short sentence about the rest of the rule.",
    "- evidence: 1-4 specific words or short phrases copied exactly from the subject or body that the reasons rely on: names, places, topics. Never filler like \"I need\", \"please\" or \"hi\".",
    "- keywords: 2-5 short phrases the owner could add so emails like this go in. source is email (a word from the email), rule (a broader version of their own wording) or sender (about who sent it).",
    "- suggestion: one sentence written as a new line of the rule, in the owner's voice, starting like the rule's own sentences do (for example \"Anything about ...\" or \"Messages that ...\"). Specific enough not to pull in unrelated mail.",
    "",
    "Example for a different folder, Travel, rule 0. \"Flight and hotel confirmations.\" 1. \"Anything from my travel agent.\", email from calendar@work.com, subject \"Offsite in Denver\":",
    JSON.stringify({
      summary: "It's a work calendar invite for a trip, not a booking confirmation or a message from your travel agent.",
      closest: [
        { index: 0, verdict: "near", reason: "It's about a trip to Denver, but it's an invite, not a flight or hotel confirmation." },
        { index: 1, verdict: "no", reason: "It comes from your work calendar, not your travel agent." },
      ],
      others: "Nothing else in the rule applies.",
      evidence: ["Offsite", "Denver"],
      keywords: [{ text: "work trips", source: "rule" }, { text: "offsite", source: "email" }],
      suggestion: "Anything about work trips, like offsites, including calendar invites.",
    }),
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
    // A reason has to say something ("no" or "near" alone doesn't).
    .filter((c) => typeof c.reason === "string" && c.reason.trim().split(/\s+/).length >= 4)
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
  /** Meaningful words from the original that the rewrite no longer has. */
  missing: string[];
}

const STOP = new Set("about after also and any anything are but can could did does doesn't don't each emails etc for from have include included includes including into its just like mail messages more most not only other our should some such than that the their them then there these they this those very was were what when where which while who will with would your yours".split(" "));
/** Content words (4+ letters) of the original that the rewrite dropped. */
function droppedWords(original: string, rewrite: string): string[] {
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map((w) => w.replace(/'s$/, "")));
  const kept = words(rewrite);
  const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
  const keptStems = new Set([...kept].map(stem));
  return [...words(original)].filter((w) => !STOP.has(w) && !kept.has(w) && !keptStems.has(stem(w))).slice(0, 12);
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
    "Every qualifier must survive: names, \"including ...\", \"not a company\", \"or needs a reply\", \"from my bank\". Dropping one changes what gets filed. If a sentence has two conditions, keep both, as two items if that reads better.",
    "An exclusion that belongs to one condition (like \"from my bank, not its marketing\") stays inside that item; only rule-wide exclusions go in leavesOut, and leavesOut is often empty.",
    "Fix spelling and grammar, merge exact repeats, keep names and specific words, and keep the owner's voice (\"my\", \"I\").",
    "Each item is a short phrase in sentence case (capitalize only the first word and names), without a trailing period.",
    "Drop filler openers like \"Anything from\" or \"Messages about\" when the list heading already says it: \"From Liz, Tim or Cathy Taylor\", \"My doctor or pharmacy\". Group names and repeats. At most 14 items per list.",
  ].join("\n");
  const raw = (await askJson(env, system, `Folder: ${folder.name}\nRule:\n${folder.rule}`, TIDY_SCHEMA, 700)) as Record<string, unknown>;
  // Sentence case, keeping capitals only where the owner used them mid-sentence (names, "I").
  const proper = new Set(["I"]);
  for (const sentence of ruleSentences(folder.rule)) {
    for (const w of sentence.split(/\s+/).slice(1)) {
      const t = w.replace(/[^A-Za-z'-]/g, "");
      if (/^[A-Z]/.test(t)) proper.add(t);
    }
  }
  const sentenceCase = (x: string) =>
    x.split(" ").map((w, i) => {
      const t = w.replace(/[^A-Za-z'-]/g, "");
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
      return proper.has(t) ? w : w.toLowerCase();
    }).join(" ");
  const clean = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((x) => str(x, 200).replace(/[.;]+$/, ""))
      .filter(Boolean)
      .map(sentenceCase)
      .slice(0, 14);
  const goesIn = clean(raw.goesIn);
  const leavesOut = clean(raw.leavesOut);
  if (goesIn.length === 0) throw new Error("The rewrite came back empty. Try again.");
  const text = formatTidied(goesIn, leavesOut);
  return { goesIn, leavesOut, text, missing: droppedWords(folder.rule, text) };
}
