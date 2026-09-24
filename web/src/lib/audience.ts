/**
 * Works out who joined, left or moved between consecutive messages in a
 * thread, for the Signal-style dividers in the chat view.
 *
 * Sender and recipients swap on every reply, so From and To are one role
 * ("to"): Alice writing to us and us writing back to Alice changes nothing.
 * Reply-all also puts the previous sender in To, so a Cc'd person who
 * replies lands in To on the next message. Moves are therefore ignored for
 * the sender of either message; only additions and removals count for them.
 * Our own mailbox is never part of the audience.
 *
 * Bcc is only known on mail we sent, because a received message never shows
 * its Bcc. So Bcc is compared only against the last *outbound* message, and a
 * received message never reports a Bcc recipient as removed.
 *
 * A message whose thread placement is unverified (it joined through an
 * unsigned In-Reply-To) reports only its own sender joining, if new, and
 * does not change the audience the next message is compared against:
 * a spoofed message addressed only to us must not "remove" everyone else.
 */

export type Field = "to" | "cc" | "bcc";

export interface Envelope {
  from: string;
  to: string[];
  cc?: string[];
  /** Only meaningful when `outbound` is true. */
  bcc?: string[];
  outbound: boolean;
  unverified?: boolean;
}

export type AudienceChange =
  | { kind: "added"; address: string; field: Field }
  | { kind: "removed"; address: string; field: Field }
  | { kind: "moved"; address: string; from: Field; to: Field };

const norm = (a: string) => a.trim().toLowerCase();

function visible(env: Envelope, self: string): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const a of [env.from, ...env.to]) out.set(norm(a), "to");
  // Someone on both To and Cc is a direct recipient.
  for (const a of env.cc ?? []) if (!out.has(norm(a))) out.set(norm(a), "cc");
  out.delete(norm(self));
  return out;
}

function diff(
  prev: Map<string, Field>,
  next: Map<string, Field>,
  senders: ReadonlySet<string> = new Set(),
): AudienceChange[] {
  const changes: AudienceChange[] = [];
  for (const [address, field] of next) {
    const was = prev.get(address);
    if (!was) changes.push({ kind: "added", address, field });
    else if (was !== field && !senders.has(address)) changes.push({ kind: "moved", address, from: was, to: field });
  }
  for (const [address, field] of prev) {
    if (!next.has(address)) changes.push({ kind: "removed", address, field });
  }
  return changes;
}

/**
 * One entry per message: the changes that message introduced. The first
 * message sets the starting audience and always reports none.
 */
export function audienceChanges(thread: Envelope[], self: string): AudienceChange[][] {
  let prev: Map<string, Field> | undefined;
  let prevFrom = "";
  let lastBcc: Map<string, Field> | undefined;
  return thread.map((env) => {
    if (env.unverified && !env.outbound) {
      const sender = norm(env.from);
      return prev && !prev.has(sender) && sender !== norm(self)
        ? [{ kind: "added", address: sender, field: "to" }]
        : [];
    }
    const next = visible(env, self);
    const changes = prev ? diff(prev, next, new Set([norm(env.from), prevFrom])) : [];
    prevFrom = norm(env.from);
    if (env.outbound) {
      const bcc = new Map<string, Field>();
      for (const a of env.bcc ?? []) if (norm(a) !== norm(self)) bcc.set(norm(a), "bcc");
      // A Bcc'd address that also appears in To/Cc is reported by that field.
      for (const a of next.keys()) bcc.delete(a);
      if (lastBcc) changes.push(...diff(lastBcc, bcc));
      else for (const address of bcc.keys()) changes.push({ kind: "added", address, field: "bcc" });
      lastBcc = bcc;
    }
    prev = next;
    return changes;
  });
}
