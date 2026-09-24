/**
 * Example mail for "Test this rule" when a mailbox has almost none of its own
 * (a new mailbox, or the Getting started guide). Each goes through the same
 * classifier real mail does, so the verdicts are honest; the UI marks them
 * "Sample" so they never pass for the user's own mail. A mix of mail people
 * tend to call important and mail they don't.
 */
import type { EmailForClassify } from "../../../src/classify";

export interface SampleMail extends EmailForClassify {
  id: string;
  fromName: string;
}

const to = "you@busta.app";

export const SAMPLE_MAIL: SampleMail[] = [
  {
    id: "sample-school", fromName: "Ms. Alvarez, Sutter Elementary", from: "m.alvarez@sutter-elementary.org", to, cc: "",
    subject: "Field trip permission slip due Friday",
    body: "Hi families, our class trip to the Discovery Museum is next Wednesday. Please sign and return the permission slip by Friday, along with $8 for the bus. Thank you! Ms. Alvarez",
  },
  {
    id: "sample-mom", fromName: "Mom", from: "linda.taylor@gmail.com", to, cc: "",
    subject: "Dinner Sunday?",
    body: "Dad is making his chili again. Can you all come around 5? Bring the kids. Love, Mom",
  },
  {
    id: "sample-lab", fromName: "Kaiser Permanente", from: "noreply@kp.org", to, cc: "",
    subject: "Your lab results are ready",
    body: "New test results are available in your medical record. Sign in to kp.org or the app to view them. Your doctor may add comments.",
  },
  {
    id: "sample-bill", fromName: "PG&E", from: "customerservice@pge.com", to, cc: "",
    subject: "Your bill is ready: $142.18 due Oct 9",
    body: "Your PG&E energy statement is ready. Amount due: $142.18. Due date: October 9. Pay online or set up AutoPay to avoid late fees.",
  },
  {
    id: "sample-visa", fromName: "Golden 1 Credit Union", from: "offers@golden1.com", to, cc: "",
    subject: "Pre-approved: Platinum Rewards Visa",
    body: "Good news! You're pre-approved for the Golden 1 Platinum Rewards Visa. Earn 3% back on dining with no annual fee. Apply in minutes.",
  },
  {
    id: "sample-shipped", fromName: "Target", from: "orders@target.com", to, cc: "",
    subject: "Your order has shipped",
    body: "Good news, your order #102-5541 is on its way: Kids' rain boots, size 2. Arriving Thursday. Track your package in the Target app.",
  },
  {
    id: "sample-linkedin", fromName: "LinkedIn", from: "notifications@linkedin.com", to, cc: "",
    subject: "You appeared in 12 searches this week",
    body: "See who's looking at your profile. Recruiters and people in your network searched for you 12 times this week. Upgrade to Premium to see all viewers.",
  },
  {
    id: "sample-news", fromName: "Morning Brew", from: "crew@morningbrew.com", to, cc: "",
    subject: "The 5-minute morning briefing",
    body: "Good morning. Markets rallied on Tuesday, a new phone launched, and we ranked the best fall snacks. Read the full newsletter in 5 minutes.",
  },
];

/** Below this many received messages, the tester uses SAMPLE_MAIL instead. */
export const SAMPLE_BELOW = 3;
