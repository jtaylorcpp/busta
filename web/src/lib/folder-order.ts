/**
 * Folder order is the sort order (designs/2026-09-25-folder-order). With
 * several accounts the folders are merged by name, so one order is written
 * to every account the user can open; each account keeps any folders the
 * order doesn't name after the rest.
 */
import { env } from "cloudflare:workers";
import type { FolderWithCounts } from "../../../src/mailbox-do";
import { listAccounts } from "./accounts";
import { openMailbox } from "./mail-data";

export async function applyFolderOrder(session: { userId: string; orgId: string }, address: string, names: string[]): Promise<void> {
  const accounts = await listAccounts(env, session.orgId);
  const addresses = new Set([address, ...accounts.map((a) => a.address)]);
  await Promise.all([...addresses].map(async (a) => {
    const access = await openMailbox(env, session, a);
    if (access.ok) await access.stub.reorderFolders(names);
  }));
}

/** This account's folder names in order, with one folder moved up or down. */
export async function namesWithMove(stub: { listFolders(): unknown }, id: string, direction: "up" | "down"): Promise<string[]> {
  const list = (await stub.listFolders()) as FolderWithCounts[];
  const i = list.findIndex((f) => f.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < list.length) [list[i], list[j]] = [list[j]!, list[i]!];
  return list.map((f) => f.name);
}
