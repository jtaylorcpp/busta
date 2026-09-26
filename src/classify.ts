/**
 * The folder question put to Workers AI (typesafe/jev): given one email and
 * some folders, which folder does it belong in? Each folder's plain-English
 * rule is the description of a choice, plus a "none" option.
 *
 * ThreadDO calls this beside a stored message; the rule tester calls it with
 * built-in sample mail when a mailbox has none of its own yet.
 */

export interface EmailForClassify {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

export interface ClassifyResult {
  /** The chosen folder's id, or null for none. */
  folderId: string | null;
  probability: number;
  confidence: number;
  /** Probability of every option, keyed by folder id ("none" for none). */
  probabilities: Record<string, number>;
}

/** typesafe/jev's answer to our single "folder" choice question. */
interface JevResult {
  answers?: { folder?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } };
}
interface JevEnvelope {
  state?: string;
  result?: JevResult;
}

type Folders = { id: string; name: string; rule: string }[];
type JevAnswer = { choice?: string; confidence?: number; probabilities?: Record<string, number> };

/** The "which folder?" question: each folder's rule describes an option, plus "none". */
function folderQuestion(folders: Folders) {
  // Option keys are positional so they are always valid identifiers; the
  // model sees the folder's name and rule as the description.
  const criteria: Record<string, string> = {};
  folders.forEach((f, i) => {
    criteria[`f${i}`] = f.rule ? `${f.name}: ${f.rule}` : f.name;
  });
  criteria.none = "Does not clearly belong in any of the other folders.";
  return {
    type: "choice",
    instructions: "Which folder does this email belong in? Pick none unless it clearly fits a folder's description.",
    criteria,
  };
}

/** Ask typesafe/jev some questions about one email. Throws unless it completed. */
async function askJev(env: Env, email: EmailForClassify, questions: Record<string, unknown>): Promise<Record<string, JevAnswer>> {
  const response = (await env.AI.run("typesafe/jev" as never, {
    state: {
      ...email,
      // A bounded excerpt: enough to judge, and a predictable cost per message.
      body: email.body.replace(/\s+/g, " ").trim().slice(0, 4000),
    },
    questions,
  } as never, {
    // Third-party models must run through an AI Gateway (Unified Billing).
    // No prompt/response logging at the gateway: prompts are email text.
    gateway: { id: String(env.AI_GATEWAY_ID ?? "default"), collectLog: false },
  } as never)) as JevEnvelope | JevResult;

  // Through the AI binding the answer arrives wrapped as
  // { state: "Completed", result: { answers } }; the docs show the bare
  // { answers }. Accept both, and refuse anything that didn't complete.
  const wrapped = response as JevEnvelope;
  if (wrapped.state && wrapped.state !== "Completed") {
    throw new Error(`classify: model state ${wrapped.state}`);
  }
  const answers = ((wrapped.result ?? (response as JevResult)).answers ?? {}) as Record<string, JevAnswer>;
  for (const key of Object.keys(questions)) {
    if (!answers[key]?.choice) {
      // Shape only, never content: the response can echo the email.
      throw new Error(`classify: model returned no choice for ${key} (keys: ${Object.keys((wrapped.result ?? response) as object).join(",").slice(0, 80)})`);
    }
  }
  return answers;
}

export async function classifyEmail(env: Env, email: EmailForClassify, folders: Folders): Promise<ClassifyResult> {
  const answer = (await askJev(env, email, { folder: folderQuestion(folders) })).folder!;
  const keyToId = (key: string) => (key === "none" ? "none" : folders[Number(key.slice(1))]?.id ?? "none");
  const probabilities: Record<string, number> = {};
  for (const [key, p] of Object.entries(answer.probabilities ?? {})) probabilities[keyToId(key)] = p;
  const chosen = keyToId(answer.choice!);
  return {
    folderId: chosen === "none" ? null : chosen,
    probability: answer.probabilities?.[answer.choice!] ?? answer.confidence ?? 0,
    confidence: answer.confidence ?? 0,
    probabilities,
  };
}

/**
 * Each folder's rule scored on its own: the probability the email belongs
 * there, keyed by folder id, from the same question the rule tester asks for
 * one folder. Mail is sorted in the user's folder order and the first folder
 * at the threshold wins, so overlapping folders (School and Must read) no
 * longer split one vote.
 *
 * All the questions go to jev in one request. If that fails, it asks one
 * folder at a time, in order, and stops at the first that reaches
 * `threshold`; folders after it are left unscored.
 */
let loggedOneRequest = false; // once per isolate, so production shows which path runs

export async function classifyEach(env: Env, email: EmailForClassify, folders: Folders, threshold: number): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  const yes = (a: JevAnswer | undefined) => a?.probabilities?.f0 ?? (a?.choice === "f0" ? a.confidence ?? 0 : 0);
  if (folders.length > 1) {
    try {
      const questions = Object.fromEntries(folders.map((f, i) => [`q${i}`, folderQuestion([f])]));
      const answers = await askJev(env, email, questions);
      folders.forEach((f, i) => { scores[f.id] = yes(answers[`q${i}`]); });
      if (!loggedOneRequest) { loggedOneRequest = true; console.log(`classifyEach: ${folders.length} folders in one request`); }
      return scores;
    } catch (e) {
      console.warn("classifyEach: one request failed, asking per folder", String(e).slice(0, 160));
    }
  }
  for (const f of folders) {
    scores[f.id] = yes((await askJev(env, email, { folder: folderQuestion([f]) })).folder);
    if (scores[f.id]! >= threshold) break;
  }
  return scores;
}
