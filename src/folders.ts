/**
 * Filing received mail into a mailbox's folders.
 *
 * Order of precedence, cheapest first:
 *   1. a folder you picked by hand — never touched here
 *   2. a folder whose +address the mail was sent to (label match) — no AI
 *   3. the folders' plain-English rules, judged by Workers AI (typesafe/jev)
 *      via ThreadDO.classify. Below FOLDER_THRESHOLD the best guess is kept
 *      as a suggestion ("Unsure: Bank 48%") and the mail stays in Messages.
 */
import { mailboxStub, threadStub } from "./mail";
import type { FolderDecision, FolderWithCounts } from "./mailbox-do";
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

  let d: FolderDecision;
  try {
    const r = await threadStub(env, address, message.threadId).classify(
      message.id,
      ruled.map((f) => ({ id: f.id, name: f.name, rule: f.rule })),
    );
    const probs = topProbs(r.probabilities);
    if (!r.folderId) {
      d = { folderId: null, source: "rule", state: "none", confidence: r.probability, probs };
    } else if (r.probability >= FOLDER_THRESHOLD) {
      d = { folderId: r.folderId, source: "rule", state: "filed", confidence: r.probability, probs };
    } else {
      d = { folderId: null, source: "rule", state: "unsure", suggest: r.folderId, confidence: r.probability, probs };
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
