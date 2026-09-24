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
