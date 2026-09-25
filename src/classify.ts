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

export async function classifyEmail(
  env: Env,
  email: EmailForClassify,
  folders: { id: string; name: string; rule: string }[],
): Promise<ClassifyResult> {
  // Option keys are positional so they are always valid identifiers; the
  // model sees the folder's name and rule as the description.
  const criteria: Record<string, string> = {};
  folders.forEach((f, i) => {
    criteria[`f${i}`] = f.rule ? `${f.name}: ${f.rule}` : f.name;
  });
  criteria.none = "Does not clearly belong in any of the other folders.";

  const response = (await env.AI.run("typesafe/jev" as never, {
    state: {
      ...email,
      // A bounded excerpt: enough to judge, and a predictable cost per message.
      body: email.body.replace(/\s+/g, " ").trim().slice(0, 4000),
    },
    questions: {
      folder: {
        type: "choice",
        instructions: "Which folder does this email belong in? Pick none unless it clearly fits a folder's description.",
        criteria,
      },
    },
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
  const answer = (wrapped.result ?? (response as JevResult)).answers?.folder;
  if (!answer?.choice) {
    // Shape only, never content: the response can echo the email.
    throw new Error(`classify: model returned no choice (keys: ${Object.keys((wrapped.result ?? response) as object).join(",").slice(0, 80)})`);
  }
  const keyToId = (key: string) => (key === "none" ? "none" : folders[Number(key.slice(1))]?.id ?? "none");
  const probabilities: Record<string, number> = {};
  for (const [key, p] of Object.entries(answer.probabilities ?? {})) probabilities[keyToId(key)] = p;
  const chosen = keyToId(answer.choice);
  return {
    folderId: chosen === "none" ? null : chosen,
    probability: answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0,
    confidence: answer.confidence ?? 0,
    probabilities,
  };
}
