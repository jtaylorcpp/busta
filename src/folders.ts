/**
 * Filing received mail into a mailbox's folders.
 *
 * Order of precedence, cheapest first:
 *   1. a folder you picked by hand — never touched here
 *   2. a folder whose +address the mail was sent to (label match) — no AI
 *   3. the folders' plain-English rules, each scored on its own by Workers AI
 *      (typesafe/jev) via ThreadDO.classifyEach, in folder order: the first
 *      folder at FOLDER_THRESHOLD wins. Below it, the best guess is kept as a
 *      suggestion ("Unsure: Bank 58%") and the mail stays in Messages.
 */
import { mailboxStub, threadStub } from "./mail";
import type { Folder, FolderDecision, FolderWithCounts, SortCandidate } from "./mailbox-do";
import { notifyFiled } from "./sms/notify";

/** Minimum probability for a rule to file a message on its own. */
export const FOLDER_THRESHOLD = 0.75;

/** Keep only the few most likely options, for the UI's probability bars. */
function topProbs(p: Record<string, number>, n = 3): Record<string, number> {
  return Object.fromEntries(Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, n));
}

/** Decide one message's folder and record it. Never throws: failures are recorded. */
export async function fileMessage(
  env: Env,
  address: string,
  message: { id: string; threadId: string; label: string | null },
  folders?: FolderWithCounts[],
  /** New mail arriving live: text the users who picked the folder it lands in. */
  opts: { notify?: boolean } = {},
): Promise<FolderDecision | null> {
  const mailbox = mailboxStub(env, address);
  const list = folders ?? ((await mailbox.listFolders()) as FolderWithCounts[]);
  if (list.length === 0) return null;

  const label = message.label?.toLowerCase() ?? null;
  const byAddress = label ? list.find((f) => f.plus_label === label) : undefined;
  if (byAddress) {
    const d: FolderDecision = { folderId: byAddress.id, source: "address", state: "filed", confidence: 1 };
    await mailbox.fileMessage(message.id, d);
    if (opts.notify) await notifyFiled(env, address, message.id, byAddress);
    return d;
  }

  const ruled = list.filter((f) => f.rule.trim().length > 0);
  if (ruled.length === 0) return null;
  if (!(await mailbox.markSorting(message.id))) return null; // filed by hand

  // Folder order is the sort order: each rule is scored on its own, and the
  // first folder (in the user's order) at the threshold takes the message.
  // Below it, the best guess is kept as "Unsure" if it's more likely than not.
  let d: FolderDecision;
  try {
    const scores = await threadStub(env, address, message.threadId).classifyEach(
      message.id,
      ruled.map((f) => ({ id: f.id, name: f.name, rule: f.rule })),
      FOLDER_THRESHOLD,
    );
    const probs = topProbs(scores);
    const first = ruled.find((f) => (scores[f.id] ?? 0) >= FOLDER_THRESHOLD);
    const [bestId, best] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (first) {
      d = { folderId: first.id, source: "rule", state: "filed", confidence: scores[first.id]!, probs };
    } else if (bestId && best >= 0.5) {
      d = { folderId: null, source: "rule", state: "unsure", suggest: bestId, confidence: best, probs };
    } else {
      d = { folderId: null, source: "rule", state: "none", confidence: best, probs };
    }
  } catch (error) {
    console.error("folder classify failed", { address, id: message.id, error: String(error) });
    d = { folderId: null, source: "rule", state: "failed" };
  }
  const filed = await mailbox.fileMessage(message.id, d);
  const folder = d.state === "filed" && d.folderId ? ruled.find((f) => f.id === d.folderId) : undefined;
  if (opts.notify && filed && folder) await notifyFiled(env, address, message.id, folder);
  return d;
}

/**
 * Re-sort recent received mail against the current folders, a few at a time.
 * Mail you filed by hand is skipped. Returns how many were processed.
 */
export async function sortRecent(
  env: Env,
  address: string,
  window: { days: number; limit: number },
): Promise<number> {
  const mailbox = mailboxStub(env, address);
  const folders = (await mailbox.listFolders()) as FolderWithCounts[];
  if (folders.length === 0) return 0;
  const rows = await mailbox.recentForSorting(window);
  const queue = [...rows];
  const workers = Array.from({ length: 6 }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      await fileMessage(env, address, { id: row.id, threadId: row.thread_id, label: row.label }, folders);
    }
  });
  await Promise.all(workers);
  await mailbox.markFoldersSorted(folders.map((f) => f.id));
  return rows.length;
}

/** The default window for "Sort mail I already have" and the rule tester. */
export const SORT_WINDOW = { days: 30, limit: 200 };

/**
 * Would this one message go in this folder, judged by its rule alone? The
 * rule tester and "Sort mail I already have" ask the same question.
 */
export async function judgeForFolder(
  env: Env,
  address: string,
  message: { id: string; thread_id: string },
  folder: { id: string; name: string; rule: string },
): Promise<{ in: boolean; p: number }> {
  const out = await threadStub(env, address, message.thread_id).classify(message.id, [folder]);
  const p = out.probabilities[folder.id] ?? (out.folderId ? out.probability : 0);
  return { in: out.folderId === folder.id && p >= FOLDER_THRESHOLD, p };
}

/** A rule test's verdicts, reused on save while the rule and window match. */
export interface TestedVerdicts {
  rule: string;
  days: number;
  limit: number;
  /** Message id → probability, for the ones that would go in. */
  in: Record<string, number>;
  out: string[];
}

/**
 * "Sort mail I already have" for a folder that was just created or had its
 * rule changed, over the places the user checked (folder ids; null is
 * Messages). Mail elsewhere was already sorted against the other rules, so
 * the only question for it is whether it goes in this folder: it moves only
 * if it does. The folder's own mail is sorted again against every rule, so
 * mail that no longer fits leaves. Everything moved can be undone.
 *
 * Verdicts from a rule test are used as they are (no model call); anything
 * the test didn't cover is judged in `background`. Returns what moved now,
 * by where it was ("messages" or a folder id), and how many are still being
 * checked.
 */
export async function sortInto(
  env: Env,
  address: string,
  folderId: string,
  opts: {
    places: (string | null)[];
    days: number;
    limit: number;
    tested?: TestedVerdicts | null;
    background: (work: Promise<unknown>) => void;
  },
): Promise<{ moved: Record<string, number>; checking: number }> {
  const mailbox = mailboxStub(env, address);
  const folder = (await mailbox.getFolder(folderId)) as Folder | null;
  const moved: Record<string, number> = {};
  if (!folder || !folder.rule.trim()) return { moved, checking: 0 };
  const rule = { id: folder.id, name: folder.name, rule: folder.rule };
  const places = new Set(opts.places);
  const rows = ((await mailbox.sortCandidates({ days: opts.days, limit: opts.limit })) as SortCandidate[])
    .filter((r) => places.has(r.place));
  const t = opts.tested;
  const tested = t && t.rule.trim() === folder.rule.trim() && t.days === opts.days && t.limit === opts.limit ? t : null;
  const outs = new Set(tested?.out ?? []);
  await mailbox.startSortUndo(folderId);

  const move = async (row: SortCandidate, p: number) => {
    await mailbox.rememberForUndo(folderId, row.id);
    const d: FolderDecision = { folderId, source: "rule", state: "filed", confidence: p, probs: { [folderId]: p } };
    if (await mailbox.fileMessage(row.id, d)) moved[row.place ?? "messages"] = (moved[row.place ?? "messages"] ?? 0) + 1;
  };

  const check: SortCandidate[] = []; // judged against this folder only
  const resort: SortCandidate[] = []; // this folder's own mail, against every rule
  for (const row of rows) {
    const p = tested?.in[row.id];
    if (row.place === folderId) {
      if (p === undefined) resort.push(row);
    } else if (p !== undefined) {
      await move(row, p);
    } else if (!outs.has(row.id)) {
      check.push(row);
    }
  }

  const later = async () => {
    const queue: (() => Promise<unknown>)[] = [
      ...check.map((row) => async () => {
        const v = await judgeForFolder(env, address, row, rule).catch(() => null);
        if (v?.in) await move(row, v.p);
      }),
      ...resort.map((row) => async () => {
        await mailbox.rememberForUndo(folderId, row.id);
        await fileMessage(env, address, { id: row.id, threadId: row.thread_id, label: row.label });
      }),
    ];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job();
    }));
    await mailbox.markFoldersSorted([folderId]);
  };
  if (check.length + resort.length > 0) opts.background(later().catch((e) => console.error("sortInto failed", address, String(e))));
  else await mailbox.markFoldersSorted([folderId]);
  return { moved, checking: check.length + resort.length };
}
