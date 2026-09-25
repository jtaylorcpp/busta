# Designs

Approved mockups, saved as self-contained HTML (open `index.html` in a
browser). Each was reviewed as a Claude artifact before any code was
written; the link is the live copy, the folder here is the snapshot the code
was built against.

| Date | Design | Covers | Published copy | Built in |
|---|---|---|---|---|
| 2026-09-23 | [UI palette & page mocks](2026-09-23-ui-pallet/index.html) (v5) | Color roles and tokens (light + dark), the Busta mark, and page mocks for sign-in, mailbox and the chat-style thread: audience-change dividers, blocked remote images, unverified placement, from-archive, forward, re-attach, the future agent draft | [artifact](https://claude.ai/artifact/DiagW8GAodGs4Lbh7fPyee) | `web/src/styles/tokens.css`, `web/src/components/ui/*`, thread and sign-in pages |
| 2026-09-23 | [Search, Drafts & Compose](2026-09-23-search-drafts-compose/index.html) (v2) | Search with filters and the load-more island states; drafts list; compose (new / forward / edit draft) with recipient and attachment chips; **Account** tab: the sidebar account menu that replaced the Mailboxes page, and the no-organization state | [artifact](https://claude.ai/artifact/BRR7hE4FJ3djCPJWkQetyM) | `web/src/pages/mb/[address]/{search,drafts,compose}*`, `web/src/components/islands/*`, `web/src/components/app/AccountMenu.astro`, `web/src/pages/index.astro` |
| 2026-09-24 | [Folders & Rules](2026-09-24-folders-rules/index.html) (v2) | The four bins (Messages, Sent, Drafts, Trash); folders nested under Messages; the folder editor with plain-English rules and "Test this rule"; folders list; row and thread filing states (Sorting…, Unsure, Couldn't sort, filed by rule / you / +address) | [artifact](https://claude.ai/artifact/LgeK2BDvK4JgS9qd2AkuUR) | `web/src/components/app/{MailboxNav,FolderChip,FolderRowActions,ThreadFolder,FolderEditor}.astro`, `web/src/pages/mb/[address]/folders/*`, `src/folders.ts` |
| 2026-09-24 | [Marketing page](2026-09-24-marketing/index.html) (v6) | The signed-out landing page: hero, three problems (sorting that works for you, not being the product, less digging) as vertical sections each with its own carousel, the waitlist call to action, and the Human \| LLM view switch whose LLM view is the Markdown served at `/llms.txt` | [artifact](https://claude.ai/artifact/KtLbkT2LsUPvDAKG7sUHNS) | `web/src/components/marketing/Marketing.astro`, `web/src/lib/llms.ts`, `web/src/pages/llms.txt.ts`, `web/src/pages/index.astro` |
| 2026-09-24 | [Getting Started](2026-09-24-getting-started/index.html) (v1) | The first-run guide on Messages: describe what matters to create **Must read**, test the rule on sample mail, send yourself a test and watch it arrive, see where it went, and the "You're set up" bar with next-folder ideas | [artifact](https://claude.ai/artifact/3RY2cpK4p5kcMEmAW5sDCZ) | `web/src/components/app/GettingStarted.astro`, `web/src/pages/mb/[address]/start/*`, `web/src/lib/sample-mail.ts`, `src/classify.ts`, `MailboxDO.guide()` |
| 2026-09-24 | [Why Not This Folder](2026-09-24-why-not-folder/index.html) (v2) | Why a message didn't land in a folder: score against the 75% line, the rule's closest sentences with reasons, the email words that mattered; add keywords with a before/after check on recent mail, Undo; **Tidy up** a rule into Goes in / Leaves out lists with a meaning check | [artifact](https://claude.ai/artifact/HtgcPCbWw8U4efEXSjSiZg) | `web/src/components/islands/{WhyNot,TidyPanel,RuleTidy}.tsx`, `web/src/styles/why.css`, `web/src/pages/mb/[address]/[id]/why*`, `folders/{compare,tidy}.ts`, `src/explain.ts` |
| 2026-09-24 | [Connect Gmail](2026-09-24-connect-gmail/index.html) (v3) | Gmail as a second account: one combined list across accounts with account colors, folders merged by name, rules that apply to one or both accounts, account checkboxes in the menu; Connect Gmail (Google sign-in, backfill, live sync, read/star/archive/trash both ways, replies through Gmail), Accounts settings and disconnect; **v3:** Archive bin synced with Gmail's Inbox, From menu for new mail, bring in older mail, disconnect keeping (read-only) or deleting Busta's copies, list ordered by time; how it works (fan-out and merge, Pub/Sub, history sync, import queue) | [artifact](https://claude.ai/artifact/Nmfcqf69NW87gMGucTJxbh) | `web/src/lib/accounts.ts`, `web/src/pages/mail/*`, `web/src/components/app/CombinedNav.astro`, `web/src/pages/{accounts,connect,oauth}/*`, `src/sources/*`, `MailboxDO` (gmail_*), `TenantDO` (kind, color, shown) |

`web/src/pages/design/` (development only, at `/design`) renders the live
components with sample data; it is the working styleguide, not a snapshot.

## Where the build differs from a mockup

Decided after the mockup was approved; the code is the source of truth.

- **Search highlights** are the primary tint, not amber (amber means in flight).
- **Previously bounced recipients** get a warning and can still be sent to; the
  Compose mockup shows "won't send".
- **Folder confidence** comes from the model's probabilities (typesafe/jev);
  there is no written "reason" text. Rule threshold: 75%.
- **Starred** is not a bin: it is a "Starred first" sort that pins starred mail.
- **Re-sorting on save** defaults to the last 7 days / 100 messages and is tunable.
- **Phone layout**: the account avatar sits in the top bar (as the Account tab
  shows); the menu opens as a bottom sheet.
- **Live updates** (new mail sliding in, the "N new messages" pill) were
  specified in conversation, not mocked.
- **Marketing "Copy Markdown" button** is `.copy-md`; in the mockup it is
  `.copy`, which collides with the section text column and draws it as a pill.
- **`[hidden]` always hides** (`base.css`); the mockup relied on the artifact
  host's rule, without which both the Human and LLM views show.
- **Getting started** only opens by itself for mailboxes created after it
  shipped; older ones open it from the account menu. Any mailbox with fewer
  than 3 received messages tests rules on the sample mail, in the folder
  editor too.
- **Why not / Tidy up**: keyword chips that aren't already in the suggested
  sentence are added after it as "Also: …" rather than rewriting the
  sentence. Check it and the meaning check use your 20 newest messages.
  "Edit, then use" is an Edit toggle on the tidied version.
- **Differing rules** show as a warning per account in the folder editor, not
  side by side with "Use for both".
- **Account colors stay unique**: picking a color another account has swaps
  the two.
- **Imports run from an import queue** (approved change to v3): one ImportDO
  per Gmail account captures the message ids to bring in and works through
  them newest to oldest on its own alarm; the mailbox's DO only does live sync.
- **From** is a menu on new messages only. Replies go from the account the
  thread is in, and forwards and drafts keep their account.
- **Disconnected Gmail, kept:** replying is off (and sending from it is
  refused), but archive, star and trash still work on Busta's copies.
- **Undo after Archive** is a banner at the top of the list, not a dark toast.
- **Google tokens live in a vault.** GmailVaultDO holds each account's tokens
  and makes every Gmail call; nothing can read a token back out. No
  application-level encryption (SOURCE_TOKEN_KEY was dropped); Cloudflare
  encrypts storage at rest.

