import { DurableObject } from "cloudflare:workers";

/**
 * One per phone number (E.164): which Busta user and org it belongs to, so an
 * incoming text can be routed. Written only after Twilio Verify confirms the
 * code. The newest verification wins: if a number moves to a new owner (a
 * recycled number, say), the old mapping is replaced and returned so the
 * caller can switch texting off for the previous owner.
 */
export interface PhoneOwner { userId: string; orgId: string; verifiedAt: number }

export class PhoneDO extends DurableObject<Env> {
  owner(): PhoneOwner | null {
    const raw = this.ctx.storage.kv.get<string>("owner");
    return raw ? (JSON.parse(raw) as PhoneOwner) : null;
  }

  /** Point this number at a user; returns the previous owner if it was someone else. */
  claim(owner: PhoneOwner): PhoneOwner | null {
    const prev = this.owner();
    this.ctx.storage.kv.put("owner", JSON.stringify(owner));
    return prev && (prev.userId !== owner.userId || prev.orgId !== owner.orgId) ? prev : null;
  }

  /** Forget the mapping, but only if it still belongs to this user. */
  release(userId: string): void {
    if (this.owner()?.userId === userId) this.ctx.storage.kv.delete("owner");
  }
}
