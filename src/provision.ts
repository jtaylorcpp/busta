import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
// Separate module from WorkflowEntrypoint, and the distinction matters: only
// this error type stops the retry loop.
import { NonRetryableError } from "cloudflare:workflows";
import { normalizeAddress } from "./addressing";
import { mailboxStub, tenantStub } from "./mail";

/**
 * Mailbox provisioning as a durable workflow.
 *
 * Claiming an address writes to two systems: the mailbox Durable Object that
 * owns it, and the tenant's mailbox list. A failure between them leaves an
 * address that is owned but invisible, so each step is durable and
 * independently retryable, and the failure path marks the mailbox rather than
 * leaving it half-created.
 *
 * Inbound routing is deliberately NOT part of this. Mail reaches the Worker
 * through the zone's catch-all rule, which is configured once for the domain
 * and covers every address forever. The earlier design created one Email
 * Routing rule per mailbox, which was wrong twice over: Cloudflare caps a zone
 * at 200 routing rules, so it put a hard ceiling of ~200 mailboxes on a
 * multi-tenant product; and it made every signup depend on a successful call
 * to an external API, so an expired token or a transient 5xx turned account
 * creation into a visibly broken mailbox.
 *
 * With the catch-all in place, an address is owned the moment the Durable
 * Object says so. Unowned addresses are refused by the email handler at
 * ingest, which is where that decision belongs anyway — the routing layer
 * never knew about ownership, it only knew which strings had rules.
 */

/**
 * Workflow instance id for a mailbox.
 *
 * Instance ids are restricted to a name-safe charset, so an email address
 * cannot be one: `@` and `.` are both rejected with `instance.invalid_id`.
 *
 * Sanitising alone is not enough either. Collapsing punctuation would map
 * `a.b@busta.app` and `a-b@busta.app` onto the same id — two distinct
 * addresses whose second claim would be refused as a duplicate run. The hash
 * suffix keeps the id unique for every address; the readable prefix is kept
 * only so an instance can be recognised in the dashboard.
 *
 * Stable for a given address, because the retry path looks the instance up by
 * this id rather than storing it.
 */
export async function provisionInstanceId(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const hash = [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const readable = address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `mb-${readable}-${hash}`;
}

export interface ProvisionParams {
  orgId: string;
  address: string;
  localPart: string;
  label: string | null;
}

export interface ProvisionResult {
  address: string;
}

/**
 * Conditions that will never succeed on retry.
 *
 * Must be Workflows' own NonRetryableError, not a custom subclass: the engine
 * recognises this type specifically and stops. A plain Error is retried to the
 * step's limit no matter what the message says.
 */
class TerminalError extends NonRetryableError {}

export class MailboxProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(event: Readonly<WorkflowEvent<ProvisionParams>>, step: WorkflowStep) {
    const { orgId, address, localPart, label } = event.payload;
    const mailbox = mailboxStub(this.env, address);
    const tenant = tenantStub(this.env, orgId);

    // 1. Claim. No retries: the only failure mode is that someone else owns
    //    the address, and that will not change by trying again.
    await step.do("claim address", { retries: { limit: 0, delay: 0 } }, async () => {
      const result = await mailbox.claim(orgId, address);
      if (!result.claimed) {
        throw new TerminalError(`${address} is already owned by another organization`);
      }
      // Return plain values: a Durable Object RPC result carries a Disposable
      // brand, and a workflow step's return value must be serializable.
      return { claimed: result.claimed, ownerOrgId: result.ownerOrgId };
    });

    // 2. Record it immediately, marked as still provisioning, so the address
    //    is visible in the UI while the rest runs rather than appearing only
    //    on success.
    await step.do("register with tenant", async () => {
      await tenant.addMailbox(address, localPart, this.env.MAIL_DOMAIN, label, "provisioning");
      return { registered: true };
    });

    try {
      // 3. Nothing to configure upstream — the zone's catch-all already
      //    delivers every address to this Worker, so the mailbox is live as
      //    soon as it is owned and recorded.
      await step.do("mark ready", async () => {
        await tenant.setMailboxStatus(address, "ready");
        return { status: "ready" };
      });

      return { address } satisfies ProvisionResult;
    } catch (error) {
      // Mark the failure rather than deleting the mailbox. The claim stays
      // with this org, so the address cannot be taken from under them and a
      // retry will succeed once the cause is fixed. Silently vanishing is
      // worse than a visible broken state — and the latch means a failed
      // mailbox still cannot be opened and mistaken for a working one.
      const reason = error instanceof Error ? error.message : String(error);
      await step.do("record failure", async () => {
        await tenant.setMailboxStatus(address, "failed", reason.slice(0, 300));
        return { failed: true };
      });
      throw error;
    }
  }
}
