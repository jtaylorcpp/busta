/**
 * The Markdown version of the marketing site, served at /llms.txt and shown in
 * the page's LLM view. One source, so the two can never drift apart. Follows
 * the llms.txt convention: title, one-line summary, links, then detail.
 * Keep the claims here identical to the page: honest, no residency promise.
 */
export const LLMS_MD = `# Busta

> Email that files itself from one-sentence rules you write, on a mailbox that's yours: no ads, trackers blocked, never mined. Currently invite-only (waitlist).

## Get started
- [Join the waitlist](https://busta.app/sign-in): create an account (waitlist while invite-only)
- [Log in](https://busta.app/sign-in): existing accounts

## What it does

### Make your email work for you
The mail that matters, from your bank, school or doctor, is buried under sales and newsletters. Write one plain sentence per folder, test it on your own mail, and Busta files new mail as it arrives.
- Write a rule: one plain sentence says what belongs in a folder, and what doesn't.
- Test it on your mail before you save; nothing is filed during a test.
- New mail is filed as it arrives. When Busta isn't sure, the message stays in Messages for you to decide.
- Any folder works the same way: school, shopping, travel.

### Stop being the product
Free email pays for itself with what it learns about you. Busta keeps each mailbox in its own storage, blocks trackers and never mines your mail. You're the customer.
- Each mailbox lives in its own isolated storage on Cloudflare's network, placed near you when it's created. It isn't pooled with anyone else's.
- Tracking pixels are blocked, so senders can't see when or where you opened their email unless you load images.
- Your mail is never sold, mined for ads or used to profile you. There are no ads.
- A model reads your mail only to sort it into your folders. It's a zero-retention model, so it keeps nothing.

### Less digging
Traditional email makes you scroll through quoted chains and wonder who's on the thread. Conversations read like a chat, show who joined, and new mail arrives live with starred mail on top.
- Replies line up like a chat; quoted history folds away until you want it.
- A divider marks when someone is added to or removed from a conversation.
- New mail arrives without refreshing, and starred mail stays at the top.

## Routes

### Public (no account needed)
- \`/\`: this page (signed-in visitors are sent to their mailbox)
- \`/sign-in\`: sign in, or join the waitlist
- \`/sign-out\`: sign out
- \`/llms.txt\`: this document
- \`/d/{token}\`: download link for a large attachment someone sent you (signed, expires)
- \`/.well-known/mta-sts.txt\`: MTA-STS policy for mail servers (served on mta-sts.busta.app)

### Requires an account
\`{address}\` is your mailbox, e.g. you@busta.app, URL-encoded.
- \`/mb/{address}\`: Messages
- \`/mb/{address}?view=sent\` · \`?view=trash\`: Sent, Trash
- \`/mb/{address}?folder={folderId}\`: a folder
- \`/mb/{address}?unread=1\` · \`?sort=starred\`: Unread filter, Starred first
- \`/mb/{address}/{messageId}\`: a conversation
- \`/mb/{address}/search?q={query}\`: search
- \`/mb/{address}/drafts\` · \`/drafts/{draftId}\`: drafts
- \`/mb/{address}/compose\` · \`/compose?forward={messageId}\`: new message, forward
- \`/mb/{address}/folders\` · \`/folders/new\` · \`/folders/{folderId}\`: manage folders and rules

## FAQ

### Do I have to set up complicated filters?
No. You write a sentence, test it on your recent mail, and save.

### Is AI reading my mail?
Yes, to sort it. When mail arrives and you have folders, a zero-retention model decides which folder it belongs in, or none, and keeps nothing. You can always file mail by hand, and your choice sticks.

### How does Busta make money?
You'll pay for it, which is the point: you're the customer, not the product. It's free while we're on the waitlist, and we'll tell you the price before anything changes.`;
