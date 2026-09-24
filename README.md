# CloudMail 95

A multi-tenant email server on Cloudflare. Durable Object per mailbox, R2 for
backup, Clerk for auth, and an inbox that looks like it was built in 1996.

```
             ┌────────────────────── inbound ──────────────────────┐
   MX ──▶ Email Routing ──▶ Worker email() ──▶ postal-mime parse
                                                    │
                          ┌─────────────────────────┴──────────────┐
                          ▼                                        ▼
              MailboxDO (per address)                  ThreadDO (per conversation)
              index · ownership · read state           messages · hot bodies
              Message-ID → thread map                  agent state · own alarm
                          │                                        │
                          └──────────────▶ R2 ◀───────────────────┘
                              raw .eml · attachments · body.json

             ┌───────────────────── outbound ─────────────────────┐
   Browser ──▶ Worker fetch() ──▶ env.EMAIL.send() ──▶ recipient
                                        │       Reply-To: sales+<thread>.<sig>@domain
                                        └──▶ sent copy → ThreadDO + index + R2
```

## Durable Objects

| Object | Keyed by | Holds |
|---|---|---|
| `TenantDO` | Clerk `org_id` | the list of mailboxes the org owns |
| `MailboxDO` | address (`sales@example.com`) | `owner_org_id`, message index, read state, Message-ID → thread map |
| `ThreadDO` | `{address}\|{threadId}` | the conversation: messages, hot bodies, attachment metadata, agent state, its own alarm |

## The agent

There is **one generalized email agent implementation, instantiated per mailbox
address** — the same shape as Cloudflare's address-based resolver, where the
address picks the instance.

Nothing is addressed *as* an agent. Mail to `sales@example.com` is already mail
to that mailbox's agent; the address identifies the tenant and the instance,
and the thread identifies the conversation. An earlier draft of this reserved
`sales+a.<agent>.<instance>@` for agent routing — that was cut, because it
re-encoded information the address and thread already carry.

An agent that needs to behave differently for different mail reads the **user
label** instead:

```
sales+triage@example.com      → label "triage"     → agent qualifies leads
sales+newsletter@example.com  → label "newsletter" → agent ignores it
```

Same specialization, no reserved namespace, and the user controls it.

| Lives on | What |
|---|---|
| `MailboxDO.agentConfig()` | `enabled`, `policy`, `labels`, `autoSend` — the agent instance for this address |
| `MailboxDO.agentHandles(label)` | whether the agent acts on a given message |
| `ThreadDO.agentState()` | per-conversation working state (drafts, tool state) |
| `ThreadDO.scheduleFollowUp()` | conversation-scoped alarms |

`labels: []` means the agent acts on all mail to the address; a non-empty list
scopes it to those folders. **No agent runs yet** — this is the wiring and the
policy surface, not an implementation.

**Why per thread, not per message.** Cloudflare's Agents SDK routes email to an
agent instance chosen by address (`Agent+id@domain`), by a signed reply tag, or
catch-all — never one instance per message. A thread is the unit an agent
reasons over: it needs conversation history, its own alarm for follow-ups, and
somewhere to keep tool state. Messages are immutable records; R2 already stores
those. So the DO count tracks conversations, not volume.

The mailbox index is deliberately body-free. Listing an inbox is one hop with
no hydration, and rendering a whole thread costs no extra hop either, because
every row in the conversation is already in the index.

Authorization reads `owner_org_id` from the mailbox's **own** DO, never from the
tenant's list — so a stale or tampered tenant record can't grant access to
someone else's mail. A mailbox owned by another org returns `404`, not `403`:
a 403 would confirm the address exists to an org with no business knowing.

Claiming is race-free because a Durable Object is single-threaded — the
`claim()` check-and-write is atomic by construction.

## Sub-addressing

`sales+anything@example.com` lands in the `sales@example.com` mailbox. Nothing
is pre-registered: a folder exists because someone mailed it.

The system needs part of that space for thread routing, so it takes **one
namespace** rather than the whole thing. A tag is system-owned only when its
first dot-separated segment is `t`:

| Address | Classified as | Effect |
|---|---|---|
| `sales+newsletter@` | label `newsletter` | filed under a folder, filterable |
| `sales+q4.pipeline@` | label `q4.pipeline` | `q4` is not reserved — still a label |
| `sales+tuesday@` | label `tuesday` | starts with `t` but has no dot — still a label |
| `sales+a.triage@` | label `a.triage` | `a` is not reserved either — still a label |
| `sales+t.<thread>.<sig>@` | **thread token** | pins the reply to a conversation |

A malformed or unsigned `t.` tag resolves to *nothing* — it does not degrade
into a label, so the namespace cannot be squatted.

Labels are recorded on the message index at ingest, which gives the inbox
folder chips (`?tag=newsletter`) for free, and a reply keeps the label of the
conversation it belongs to.

## Thread routing and the reply tag

Outbound mail sets `Reply-To: sales+t.<threadId>.<sig>@domain`, where `sig` is
an HMAC over `mailbox|threadId` keyed by `THREAD_SECRET`. A reply to that
address is pinned to the thread with no trust in anything the sender wrote.

This matters. `In-Reply-To` and `References` are attacker-controlled: anyone who
learns a Message-ID can graft a message onto an existing conversation — the
classic "change the wire instructions" attack, arriving inside a thread the
reader already trusts. Cloudflare hit the same class of bug and **removed**
their header-based resolver outright:

```ts
/**
 * @deprecated REMOVED due to security vulnerability (IDOR via spoofed headers).
 * @throws Always throws an error with migration guidance.
 */
declare function createHeaderBasedEmailResolver<Env>(): EmailResolver<Env>;
```

A mail server can't require signed tags — correspondents who have never been
emailed by you have no tag, and RFC threading is how the rest of the world
works. So this keeps the fallback and **marks** it: a message that joined an
existing thread on unsigned headers is stored with `grafted = 1`, shown with a
`?` badge in the inbox, and carries a warning banner when opened. A tampered
signature does not fall back — it starts a new thread.

Inbound delivery is idempotent on `Message-ID` (synthesised from a SHA-256 of
the raw bytes when absent), so Email Routing retries never double-deliver.

## Capacity

A Durable Object holds **10 GB**. The mailbox index is one row per message, so
that ceiling is the inbox limit. All figures below are **measured** with
`sql.databaseSize` over synthetic corpora, not estimated — the harness is
`/__dev/measure`, and bytes-per-row stayed flat from 1k to 61k rows.

| Configuration | Bytes/row | Messages per mailbox |
|---|---:|---:|
| Index only, no metadata, no search | 925 | **~11.6M** |
| + filterable metadata | 1,226 | ~8.8M |
| + full-text, subject/sender/snippet only (`SEARCH_BODY_CHARS=0`) | 1,539 | ~7.0M |
| + full-text over 500 body chars | 2,480 | ~4.3M |
| + full-text over 2,000 body chars *(default)* | 6,025 | **~1.8M** |
| + full-text over 4,000 body chars | 6,848 | ~1.6M |
| + full-text over 8,000 body chars | 11,557 | ~0.9M |

FTS5 costs roughly **2.4 bytes per indexed character**, which makes
`SEARCH_BODY_CHARS` by far the biggest lever on capacity. Tune it in
`wrangler.jsonc`.

**There is no limit on the number of Durable Objects.** Cloudflare: "You can
create and run as many separate Durable Objects as you want within a given
Durable Object namespace." Only *classes* are capped (500 on Workers Paid, and
this app uses three). An object hibernates ~10 seconds after going idle and then
costs storage only; SQLite storage per account is unlimited on Workers Paid.

Two things this ceiling is *not*:

- **A limit on stored mail.** Bodies, attachments and raw MIME live in R2,
  which is effectively unbounded. Hitting the index ceiling means the mailbox
  can no longer *list and search* more messages, not that mail is lost.
- **A per-account limit.** It is per mailbox address. Ten mailboxes is ten
  independent 10 GB budgets, and SQLite storage per account is unlimited on
  Workers Paid.

## Search

FTS5 virtual tables **are** available inside Durable Objects (probed, not
assumed — `/__dev/fts`), so search is native rather than an external index.

Search walks the index **newest first, a page at a time**. FTS5 rowids are the
message arrival sequence, so descending rowid is both chronological and the
order FTS5 traverses natively — that is what makes a cursor cheap instead of
requiring a sort of the entire match set.

```
POST /__dev/search {"address":"…","q":"settlement agreement","limit":10}
  → { results: [...], nextCursor: 19937, examined: 5000, exhausted: false }

POST /__dev/search {"…","cursor":19937}
  → { results: [...], nextCursor: 19867, … }
```

Each call inspects a bounded slice of the sequence space (`SEARCH_WINDOW`,
5,000) and stops as soon as the page is full, so a page costs work
proportional to what it returns. With a selective structured filter it keeps
stepping through windows until the page fills or the scan budget is spent.

- `nextCursor` is the sequence to resume **strictly below**.
- A short page with a non-null cursor means *budget spent, call again* — only
  `exhausted: true` means history ran out.
- Re-indexing a redelivered message keeps its original sequence, so a live
  cursor is never invalidated and results never reorder.

Structured filters compose with the text query **in the same pass** — they are
SQL predicates and bitmask tests on the index, not post-filtering of results.
Exposed in the UI: sender, folder, unread, has-attachments, no-newsletters,
no-auto-replies. Also available on `searchText()`: `listId`, `subjectKey`, and
arbitrary `flagsAll`/`flagsNone` bitmasks.

**Coverage is complete.** Walking to exhaustion over a 5,000-message mailbox
returned all 715 expected matches, zero duplicates, strictly descending, having
examined 5,002 sequence numbers — one pass over the index, no re-scanning.
Adding a folder filter returned exactly the 80 messages that satisfy both
predicates, a strict subset of the unfiltered set.

**Search survives tiering.** The full-text index lives on the mailbox and is
written at ingest, so it is independent of where the body ends up. A message
whose body has been archived to R2 is still found by a term that appears only
in that body — verified, not assumed.

User input is never passed to FTS5 raw — every term is tokenised and quoted,
so an apostrophe, a stray `NEAR(`, or `foo" OR 1=1 --` is matched literally
instead of parsed as query syntax.

## Metadata

Captured at ingest, because re-deriving it later means re-parsing millions of
archived messages. Nothing here is the only copy — raw MIME in R2 makes every
field backfillable — so this is a cost optimisation, not a durability one.

On the **mailbox index** (scarce, one row per message): `from_name`,
`to_count`, `cc_count`, `list_id`, `subject_key` (subject with the whole
`Re:`/`Fwd:` stack peeled), `body_chars`, plus two packed integers —
`flags` (auto-submitted, reply, forward, attachments, HTML, multi-recipient,
bulk, calendar, high-importance) and `auth` (SPF/DKIM/DMARC verdicts from
`Authentication-Results`). A dozen booleans cost 8 bytes this way.

On **ThreadDO** (one object per conversation, far fewer rows): the full
recipient lists, `Reply-To`, `Return-Path`, `Delivered-To`, and the complete
header array as JSON.

## Reading HTML mail

Most real mail is HTML, so the reading pane renders it — behind **two
independent layers**, because email HTML is hostile input from anyone.

1. **Allowlist sanitizer** (`src/sanitize.ts`, built on HTMLRewriter). Named
   tags survive with filtered attributes; everything else keeps only its text.
   `script`/`iframe`/`object`/`form`/`svg` and friends are removed with their
   contents. Every `on*` handler is stripped. `href`/`src` must be
   `http(s):` or `mailto:` after whitespace and control characters are
   removed, so `java&#9;script:` does not survive. Style declarations
   containing `url(`, `expression(`, `@import`, `behavior:` or
   `position:fixed` are dropped.
2. **Isolation.** The result is served from `/mb/:address/:id/body` into a
   `sandbox`ed iframe under `default-src 'none'`, so a miss in layer 1 still
   has no script, no framing rights, and no network.

Verified against a deliberately hostile message — 15 of 15 checks, including
tab-smuggled `javascript:`, `onerror`, conditional comments, and a phishing
form, with the legitimate content and links preserved.

**Remote images are blocked by default** and replaced with a transparent
pixel. They are tracking beacons: loading one tells the sender that the
message was opened, when, and from which IP. A banner offers one-click
loading, which re-sanitizes from source with `img-src https:` allowed.

Inline `cid:` images resolve against the message's own attachments, so
embedded images work without any remote fetch.

## Attachments

Inbound attachments are decoded by postal-mime and written to R2 at ingest;
only metadata (filename, size, MIME type, key) goes in SQLite. Outbound works
the same way, and the compose and reply forms accept file uploads.

A reply can also **re-attach files from the message it answers** — the
checkboxes read the bytes back out of R2 rather than asking the browser to
round-trip data it already stored server-side. Verified byte-identical through
the full path: inbound MIME → parse → R2 → re-attach → send → R2.

### Large files become links, not errors

Cloudflare caps a message at 5 MiB, and that is the *encoded* size — MIME
base64 inflates bytes by 4/3. **Streaming does not get around this.** The
generated runtime types are explicit that an attachment takes
`content: string | ArrayBuffer | ArrayBufferView`, with no `ReadableStream`,
and the cap is on the size of the message rather than on how the Worker holds
the bytes. Even if it were lifted, receiving servers cap lower: Gmail 25 MB,
Outlook 20 MB, many corporate gateways 10 MB.

So oversize files are not rejected. Each attachment is routed by size:

| Condition | Delivery |
|---|---|
| File ≤ `INLINE_ATTACHMENT_BYTES` (2 MB) and total ≤ `MAX_ATTACHMENT_BYTES` (3.5 MB) | MIME attachment |
| Anything else | stored in R2, sent as a signed expiring link |

The mail gets a link block in both the text and HTML parts:

```
--
Large file available for download until Wed, 21 Oct 2026 02:23:01 GMT:
  huge.bin (11.4 MB)
  https://mail.example.com/d/eyJrIjoibWFpbC9zYWxlcy…
```

**The token is the authorization.** Recipients are external mail users who
cannot authenticate here, so `/d/:token` is public and the HMAC is the only
protection. The token is self-contained — R2 key plus expiry, signed — so
verification needs no lookup and no state, and the payload is verified *before*
it is parsed. Measured behaviour:

| Request | Result |
|---|---|
| valid token, full GET | `200`, streams the whole object |
| valid token, `Range:` | `206` + `Content-Range`, resumable |
| tampered signature | `404` |
| payload with no signature | `404` |
| forged R2 key, fake signature | `404` |
| validly signed but expired | `410` with an explanation |

Expiry is worth explaining; a bad signature is not worth confirming, so those
collapse to 404.

The R2 body is handed straight to the `Response`, so a 12 MB object (verified
byte-identical by SHA-256, and again for a byte range) streams through without
ever being buffered in the Worker.

Filenames are stripped of path separators and control characters before they
reach an R2 key or a MIME header — `../../../etc/passwd` is stored as `passwd`.

**Archive format.** Attachment bytes are written to R2 once, under their own
keys. The reconstructed `sent.eml` references them by header rather than
inlining base64, which would double R2 usage for no gain:

```
X-Archived-Attachment: logo.png; size=70; key=mail/sales%40example.com/…/att/1-logo.png
```

## Storage tiering

R2 is the long-term store; the Durable Object is the index and a hot cache.

**Tiering is driven by storage pressure, not age.** Bodies stay hot for as long
as there is room. Nothing is archived on a schedule, and — importantly — no
periodic alarm is scheduled either: a quiet conversation costs exactly zero
wakeups. Pressure is only checked on write, which is the only moment the size
can grow.

| Object | Over `STORAGE_HIGH_WATERMARK` (0.85) it… | Until |
|---|---|---|
| `ThreadDO` | archives the **oldest bodies** to R2 | back under `STORAGE_LOW_WATERMARK` (0.7) |
| `MailboxDO` | drops the **full-text body index** for the oldest messages | back under the low watermark |

`ARCHIVE_AFTER_DAYS` is now `0` (off) by default. Set it above zero only for a
retention rule that is not about capacity — it re-enables a daily alarm.

### Why the mailbox index degrades search instead of archiving

A thread has bodies to move. The index does not — its rows *are* the inbox. Its
recoverable space is the full-text body content, the largest single component
(~2.4 bytes per indexed character). Under pressure the oldest messages get
re-indexed on subject, sender and label alone. They stay listed, stay readable,
and stay findable by header; they lose only body-search depth. Nothing is
deleted, the body is still in the thread, and the raw MIME is still in R2.

Measured on a 4,000-message index at a 16 MB test watermark: one pass trimmed
2,804 messages (70%), 23.07 MB → 12.73 MB, and the newest 30% kept full body
search.

### Two measured facts this design rests on

- **Archiving really does return space.** A thread of 2,000 × 10 KB bodies went
  23.69 MB → 8.07 MB as bodies moved to R2, ~1.56 MB per 200 messages. Freed
  pages are reclaimed automatically; `VACUUM` is not needed and is not even
  available (Durable Objects run inside a transaction, so it raises
  `cannot VACUUM from within a transaction`).
- **`databaseSize` does not drop until the transaction commits.** Re-reading it
  inside the relief loop therefore reads as zero progress and sheds everything
  — the first implementation dropped 1,600 of 1,800 bodies when a few hundred
  would have done. Relief is now sized up front from the average hot body (or
  the measured FTS cost per character) and re-checked on the next alarm.

| Data | Lives in | For how long |
|---|---|---|
| Sender, subject, snippet, dates, read flag, threading | MailboxDO SQLite | forever |
| Attachment **metadata** (filename, size, type) | ThreadDO SQLite | forever |
| Attachment **content** | R2 | forever |
| Raw MIME (`raw.eml` / `sent.eml`) | R2 | forever — the system of record |
| Message **body** | ThreadDO SQLite, then R2 `body.json` | hot until the object hits `STORAGE_HIGH_WATERMARK` |

Reads hydrate archived bodies back transparently, and the message view shows
where the body came from. The mailbox index never holds bodies at all, so
listings are unaffected either way.

The same alarm is the seam for agent work: `scheduleFollowUp(at, reason)` and
`setAgentState(state)` are already on ThreadDO, and the alarm handler has the
hook point where scheduled conversation work will run.

**Keys:**

```
mail/{address}/{uid}/raw.eml           inbound MIME, verbatim
mail/{address}/{uid}/sent.eml          outbound, reconstructed
mail/{address}/{uid}/att/{n}-{name}    attachment content
mail/{address}/{uid}/body.json         body, written when it ages out
```

**Recovery.** `body.json` is a derived convenience, not the truth. If it is lost,
a read falls back to re-parsing `raw.eml` with postal-mime and still returns the
full body (the view reports `Rebuilt from archived MIME`). Only losing the raw
object loses the message.

**Why it is safe to sweep without locking.** The sweep is not wrapped in
`blockConcurrencyWhile`, so reads are never blocked. A concurrent read sees
either the hot body or the archived one — both correct. A crash between the R2
put and the SQL update leaves an orphan that the next sweep overwrites at the
same key.

To exercise the cold path, lower `STORAGE_HIGH_WATERMARK` / `STORAGE_LOW_WATERMARK`
in `.dev.vars` so a small object crosses them, or call `/__dev/sweep` directly.

## SPF, DKIM and DMARC

**None of this is application code.** It is DNS, plus one thing Cloudflare
does for you and one thing it does not.

### Outbound — mail you send

| | Who does it | What you do |
|---|---|---|
| **DKIM** | Cloudflare generates and manages the keys and signs every message | Publish the record it gives you. No key ever touches this app. |
| **SPF** | Record supplied by Cloudflare | Publish it. Added for you automatically when the domain's DNS is already on Cloudflare; otherwise copy it from the dashboard. |
| **DMARC** | **Nobody — this one is on you** | Add a TXT record at `_dmarc.yourdomain.com`. |

Wrangler cannot do this — it configures the Worker, not the zone. So the
records are declared in **`dns.config.jsonc`**, version-controlled beside
`wrangler.jsonc`, and reconciled by script:

```bash
npm run dns:check                  # desired vs published, changes nothing
npm run dns:apply                  # create/update via the Cloudflare API
npm run dns:verify -- busta.app        # what the world actually sees
```

**Your wrangler login is not enough for this one step.** Its OAuth scopes are
`zone:read` with no DNS scope at all — verified by asking: it reads the zone
fine and is refused outright on DNS records, even for reads. Every other step
in the setup below does work on the wrangler session, including
`email routing enable` and `email sending enable`, which provision MX and
SPF/DKIM server-side under `email_routing:write` / `email_sending:write`.

So `dns:apply` needs one scoped token, which goes in **`.env`** at the project
root (`cp .env.example .env`):

```
CLOUDFLARE_DNS_API_TOKEN=...
```

**The name matters.** Wrangler auto-loads `.env` and uses `CLOUDFLARE_API_TOKEN`
for its *own* authentication, so a DNS-scoped token under that name silently
replaces your OAuth session and breaks every wrangler command with a
misleading `Failed to automatically retrieve account IDs`. Verified by
reproducing it.

That file is gitignored, and it does not touch the Worker: wrangler ignores
`.env` for the Worker's own bindings in both `dev` and `deploy` — checked, not
assumed — while Bun loads it for the scripts. Worker secrets are a separate thing and belong in `.dev.vars`
locally or `wrangler secret put` in production.

The token itself:

| | |
|---|---|
| Create at | `dash.cloudflare.com/profile/api-tokens` |
| Permissions | **Zone → DNS → Edit** |
| Zone Resources | Include → Specific zone → your zone |

Scope it to the single zone. Not the Global API Key — that carries every
permission on the account and cannot be revoked independently of your login.

`CLOUDFLARE_ZONE_ID` is optional: the script looks the zone up itself, falling
back to the wrangler session for the lookup since that much it *can* do.

It refuses to touch a name that already has more than one TXT record, because
duplicate DMARC is treated by receivers as *no* policy and guessing which to
keep is not the script's call.

**Staging is deliberate.** The config ships at `p=none`:

```
v=DMARC1; p=none; sp=reject; adkim=r; aspf=r; pct=100; fo=1; rua=mailto:dmarc@example.com;
```

`sp=reject` from day one costs nothing — no legitimate mail originates from
subdomains of a mail domain — while `p` stays at `none` until the reports come
back clean, then `quarantine`, then `reject`. Publishing `p=reject` on a domain
whose sending you have not measured is how legitimate mail disappears silently.

Alignment stays **relaxed**. Strict (`adkim=s; aspf=s`) breaks any subdomain
sender, and for calibration Cloudflare's own domain runs relaxed with
`p=reject`.

### MTA-STS — the one piece this app actually serves

Everything above is DNS. MTA-STS is not: the DNS record only *advertises* that
a policy exists, and senders then fetch the policy itself over HTTPS. That file
is served by this Worker at `/.well-known/mta-sts.txt`:

```
version: STSv1
mode: testing
mx: *.mx.cloudflare.net
max_age: 86400
```

It must be reachable at `https://mta-sts.<domain>/.well-known/mta-sts.txt`, so
add that hostname as a Worker route:

```jsonc
"routes": [
  { "pattern": "mail.example.com", "custom_domain": true },
  { "pattern": "mta-sts.example.com", "custom_domain": true }
]
```

`custom_domain` rather than a plain route: a route only attaches to a hostname
that already exists in DNS, while a custom domain has Cloudflare create and
manage the record. That removes a DNS dependency entirely — worth knowing if
your DNS token is scoped narrowly.

**It ships in `testing` mode on purpose.** Cloudflare does not document
MTA-STS support for Email Routing, so whether their MX hosts present
certificates that satisfy `enforce` is unverified — and an enforce policy
against an MX that fails validation stops your inbound mail entirely. Testing
mode reports violations through TLS-RPT without blocking anything. Read those
reports, then flip `MTA_STS_MODE` to `enforce`.

The `id=` in the DNS record is derived from the policy content, so editing the
policy changes the id and senders re-fetch instead of using a cached copy.

### Ordering matters — publish DNS last

The DMARC and TLS-RPT records point `rua=` at mailboxes **in this app**. Publish
them before inbound mail works and every report bounces, which is worse than
having no reporting: you get no data and you look like a broken domain.

For `busta.app`, in this order. The app is served from `home.busta.app`; the
apex carries MX for mail and is left free for a marketing site.

```bash
# 1. Inbound first, so the report mailboxes can actually receive
npx wrangler email routing enable busta.app
npx wrangler email routing dns get busta.app          # confirm MX landed
npx wrangler email routing rules create busta.app --name "dmarc" \
  --match-type literal --match-field to --match-value dmarc@busta.app \
  --action-type worker --action-value cloudflare-email --enabled

# 2. Outbound. SPF and DKIM records are published for you — the zone is
#    already on Cloudflare, so nothing manual here.
npx wrangler email sending enable busta.app
npx wrangler email sending dns get busta.app          # confirm SPF + DKIM

# 3. Deploy, so mta-sts.busta.app serves the policy the DNS record advertises
npx wrangler r2 bucket create cloudflare-email-archive
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put THREAD_SECRET
npx wrangler deploy

# 4. Claim dmarc@busta.app and tls-reports@busta.app in the app

# 5. Only now publish DMARC / MTA-STS / TLS-RPT
npm run dns:apply                              # token from .env, zone auto-resolved

# 6. Confirm what the world sees
npm run dns:verify -- busta.app
```

Steps 1–2 are `[open beta]` in Wrangler as of 4.135.

### Verifying, not assuming

`npm run dns:verify` queries DNS directly rather than trusting the config, and
exits non-zero on anything missing or broken so it can gate a deploy. The same
checks are available at runtime. Sample output against a real domain:

```
  [OK  ] SPF            Ends in -all: unauthorised senders are a hard fail.
  [OK  ] DMARC          p=reject with reporting — spoofed mail is refused.
  [OK  ] MTA-STS (DNS)  Policy is advertised.
  [WEAK] MTA-STS (policy)  mode: testing — violations reported, mail still flows in the clear.
  [OK  ] TLS-RPT        TLS failures are reported.
```

It also catches the failure modes that look fine in a dashboard: duplicate
DMARC or SPF records (receivers treat both as no policy), `pct<100`, a missing
`rua=`, and an advertised MTA-STS policy whose file does not resolve — which is
worse than not advertising one, because senders cache the failure.

### Inbound — mail you receive

**Email Routing has already enforced authentication before your Worker runs.**
Cloudflare's postmaster documentation: *"The email must either pass SPF or be
correctly signed with DKIM. Emails that fail both checks are rejected"*, and
*"incoming emails are rejected if they fail authentication according to the
sender's DMARC policy."*

So the app does not need to verify or reject on authentication — that decision
is made upstream, and anything reaching `email()` already survived it.

The residual case worth knowing: a sender publishing `p=none` (or no DMARC
record at all) only has to pass **SPF or DKIM**, not align them. Mail spoofing
such a domain can still reach you with `dmarc=fail`. That is why ingest records
the verdicts in the `auth` field — as evidence for display, not as a gate.

## Setup

### 1. Clerk

Create an application at [dashboard.clerk.com](https://dashboard.clerk.com).
Three settings are load-bearing, and each fails in a way that looks like a bug
somewhere else:

| Setting | Why | Symptom if wrong |
|---|---|---|
| **Disable email sign-in** | Email codes and magic links are a chicken-and-egg loop for an app that *is* the email. Use Google/GitHub OAuth or username + password. | You cannot receive the code needed to sign in and read your mail |
| **Enable Organizations** (Configure → Organizations) | Tenancy is org-scoped; `orgId` is null without it | The org picker appears forever with nothing to pick |
| **Allow the app's origin** | `authenticateRequest` is called with `authorizedParties` set to the request origin | Endless handshake redirects |

**Version pairing matters.** `@clerk/backend` 3.x pairs with `clerk-js` 6.x —
they ship together and a mismatched pair fails in ways that read as
configuration problems. Both are pinned accordingly; keep them in step.

```bash
cp .dev.vars.example .dev.vars   # then fill in the two Clerk keys
```

For production:

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put THREAD_SECRET   # HMAC key for reply tags + download links
```

Set `PUBLIC_BASE_URL` in `wrangler.jsonc` to the origin recipients will reach —
download links are built from it and are useless if it is not public.

### 2. Domain

Set `MAIL_DOMAIN` in `wrangler.jsonc`, then onboard it for both directions:

```bash
npx wrangler email sending enable  yourdomain.com   # outbound; DKIM keys managed by Cloudflare
npx wrangler email routing enable  yourdomain.com   # inbound MX
npx wrangler email sending list                     # confirm it's onboarded
```

Until a sending domain is onboarded you may only send to **verified destination
addresses** on your account (those sends are free and unmetered). After
onboarding, you can send to any recipient.

Route inbound mail to this Worker. **A catch-all cannot do this** — Cloudflare
restricts the catch-all rule to `forward` or `drop`, so Worker delivery needs an
explicit rule per address:

```bash
npx wrangler email routing rules create yourdomain.com \
  --name "sales" --match-type literal --match-field to \
  --match-value sales@yourdomain.com \
  --action-type worker --action-value cloudflare-email --enabled
```

This is the one place claiming a mailbox in the app is not self-contained: the
DO records the claim, but mail will not arrive until a matching routing rule
exists. Automating it would mean giving the Worker a Cloudflare API token,
which is a deliberate trade not yet made.

### 3. R2

```bash
npx wrangler r2 bucket create cloudflare-email-archive
npx wrangler r2 bucket create cloudflare-email-archive-preview
```

### 4. Run

```bash
npm install && npm --prefix web install
npm run dev       # http://localhost:8787 — Astro + the Worker, one process
npm run deploy    # builds web/ and deploys the one Worker
```

The deployed Worker is `web/src/worker.ts`. It re-exports `email()`, the
Durable Objects from `src/`, and sends each web request either
to Astro (pages already moved to `web/`) or to the original router in
`src/index.ts`. `wrangler.jsonc` at the repo root is still the only deploy
config. See `web/README.md` for the UI.

## Local development without DNS

Dev-only endpoints, gated on `ENVIRONMENT === "development"`, let you exercise
the whole pipeline before a domain exists. They bypass Clerk on purpose — never
deploy with `ENVIRONMENT=development`.

```bash
# Claim a mailbox for a fake org
curl -X POST localhost:8787/__dev/claim -H 'content-type: application/json' \
  -d '{"orgId":"org_acme","local":"sales","label":"Sales team"}'

# Deliver a message (runs the real ingest path: parse → R2 → DO)
curl -X POST localhost:8787/__dev/inbound -H 'content-type: application/json' \
  -d '{"from":"alice@example.net","to":"sales@example.com",
       "subject":"Quote request","text":"How much for 50 widgets?"}'

# Deliver arbitrary MIME (multipart, attachments, odd encodings)
curl -X POST localhost:8787/__dev/inbound -H 'content-type: application/json' \
  -d '{"from":"carol@example.org","to":"sales@example.com","raw":"<full MIME>"}'

# Inspect the mailbox — stats, sweep schedule, rows
curl -X POST localhost:8787/__dev/list -H 'content-type: application/json' \
  -d '{"address":"sales@example.com"}'

# Read one message and see where its body came from (hot | archive | raw)
curl -X POST localhost:8787/__dev/get -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","id":"<message id>"}'

# Send with real file attachments (exercises the multipart path)
curl -X POST localhost:8787/__dev/sendfile \
  -F "from=sales@example.com" -F "to=alice@example.net" \
  -F "subject=Quote" -F "body=Attached." \
  -F "files=@quote.csv;type=text/csv"

# Reply re-attaching a file from the message being answered
curl -X POST localhost:8787/__dev/sendfile \
  -F "from=sales@example.com" -F "to=alice@example.net" \
  -F "subject=Re: Contract" -F "body=Countersigned." \
  -F "parentId=<message id>" -F "reattach=<attachment id>"

# Inspect storage pressure; add "relieve":true to act on it
# (omit threadId for the mailbox index instead of a thread)
curl -X POST localhost:8787/__dev/pressure -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","threadId":"<thread id>","relieve":true}'

# Force a tiering sweep instead of waiting for pressure
# (omit threadId to sweep every thread in the mailbox)
curl -X POST localhost:8787/__dev/sweep -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","olderThanDays":0}'

# Exercise sub-addressing
curl -X POST localhost:8787/__dev/inbound -H 'content-type: application/json' \
  -d '{"from":"news@vendor.example","to":"sales+newsletter@example.com",
       "subject":"Digest","text":"News."}'

# Configure this mailbox's agent (omit fields to just read it back)
curl -X POST localhost:8787/__dev/agent -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","enabled":true,"labels":["triage"],
       "policy":"Qualify inbound leads; escalate anything over 100 seats."}'

# Read a whole conversation out of its ThreadDO
curl -X POST localhost:8787/__dev/thread -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","threadId":"<thread id>"}'

# Mint a signed reply address, then prove routing by mailing it
curl -X POST localhost:8787/__dev/replytag -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","threadId":"<thread id>"}'

# Send (locally simulated; real once the domain is onboarded)
curl -X POST localhost:8787/__dev/send -H 'content-type: application/json' \
  -d '{"from":"sales@example.com","to":"alice@example.net",
       "subject":"Re: Quote request","text":"$12/ea, 3 week lead time.",
       "replyToStoredId":"<id from __dev/list>"}'
```

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Mailboxes owned by the active org + claim form |
| POST | `/mailboxes` | Claim a local-part |
| GET | `/mb/:address` | Inbox rows (`?tag=` folder, `?view=trash\|starred`, `?before=` page) |
| GET | `/mb/:address/search` | Full-text search (`?q=`, `?cursor=`, `?unread=1`) |
| GET | `/mb/:address/:id` | Read a message + reply form + thread |
| GET | `/mb/:address/:id/body` | Sanitized HTML body, for the sandboxed iframe |
| POST | `/mb/:address/:id/trash` · `/restore` · `/purge` | Trash, restore, permanent delete |
| POST | `/mb/:address/:id/star` · `/unstar` · `/read` · `/unread` | Flags |
| GET | `/mb/:address/drafts` | Saved drafts |
| GET/POST | `/mb/:address/drafts/:id` · `/delete` | Edit or discard a draft |
| POST | `/mb/:address/:id/reply` | Threaded reply (multipart; uploads + re-attach) |
| GET | `/mb/:address/compose` | New message (`?forward=<id>` to forward one) |
| POST | `/mb/:address/compose` | Send (multipart; file uploads) |
| GET | `/mb/:address/:id/att/:attId` | Download an attachment from R2 |
| GET | `/.well-known/mta-sts.txt` | **Public.** MTA-STS policy, fetched by sending servers |
| GET | `/d/:token` | **Public.** Signed, expiring attachment download (streams from R2, supports `Range`) |
| GET | `/sign-in`, `/sign-out` | Clerk |

## Threading

Ingest extracts `Message-ID`, `In-Reply-To`, and `References`. A new message
inherits the thread of whatever it replies to, walking `References` newest-first
so deep threads still land on the right root when the immediate parent was never
delivered to this mailbox. Outbound replies set `In-Reply-To` and extend
`References`, so real mail clients thread them correctly too.

## Rejections and bounces

A send can fail two ways, and they need different handling.

**Synchronously**, as a thrown error from the binding. Codes are classified
from Cloudflare's published list:

| Class | Behaviour |
|---|---|
| Permanent (`E_SENDER_NOT_VERIFIED`, `E_CONTENT_TOO_LARGE`, `E_RECIPIENT_SUPPRESSED`, the `E_HEADER_*` family, …) | Not retried. Message kept and marked `failed`, with a remedy naming the fix. |
| Transient (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR`, `E_DELIVERY_FAILED`) | Queued in the mailbox outbox, retried on a Durable Object alarm at 1m → 5m → 15m → 1h → 4h → 12h, then given up on and marked `failed`. |
| Unrecognised | Treated as transient. Retrying something permanent costs a little quota; dropping something transient loses the user's mail. |

**The message is always stored**, whatever happens. A rate limit must not be
what destroys a draft. Retries run inside the Durable Object, so the user
closing their laptop is not what decides whether their mail goes out.

**Asynchronously**, as a bounce. The binding returns a `messageId` on
acceptance — the runtime type is `{ messageId: string }` and nothing more, so
per-recipient outcomes are not available from a Worker. A real failure arrives
later as an RFC 3464 delivery status notification, which ingest recognises
*before* threading (otherwise it lands as a stray reply from MAILER-DAEMON
while the original still reads as delivered). A DSN:

- marks the original message `bounced`, matched by the returned `Message-ID`
  or, when the server omits it, the most recent unbounced message to that
  recipient;
- adds the address to a local suppression list on a `5.x.x` permanent failure;
- does **not** suppress on `4.x.x` — a full mailbox is temporary, and wrongly
  suppressing a real address is worse than one more failed attempt;
- never appears in the inbox as ordinary mail.

Suppressed addresses are refused before the send, so quota is not spent on a
message Cloudflare would reject anyway.

**Inbound rejections.** Oversize mail is rejected at the envelope before the
body is buffered (`MAX_INBOUND_BYTES`, default 25 MB). An unprovisioned
mailbox is rejected. A storage failure during ingest returns a temporary
rejection so the sending server retries, rather than silently dropping mail.

### Testing all of it without a live domain

Set `FAULT_CODE` in `.dev.vars` to any `E_*` code and every send fails with it.
One switch, so there is nothing to get out of sync.

```bash
# queue/retry/exhaust
FAULT_CODE=E_RATE_LIMIT_EXCEEDED   # in .dev.vars, then restart wrangler dev
curl -X POST localhost:8787/__dev/outbox -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","dueNow":true,"drain":true}'

# suppression list
curl -X POST localhost:8787/__dev/suppressions -H 'content-type: application/json' \
  -d '{"address":"sales@example.com","add":"dead@example.net","reason":"hard bounce"}'

# bounces: post a full RFC 3464 DSN through the normal inbound path
curl -X POST localhost:8787/__dev/inbound -H 'content-type: application/json' \
  -d '{"from":"MAILER-DAEMON@mx.example.net","to":"sales@example.com","raw":"<DSN>"}'
```

`.dev.vars` is not hot-reloaded — restart `wrangler dev` after changing
`FAULT_CODE`.

## Still missing

Deliberately, and worth knowing before this is pointed at real mail:

- **No junk folder or spam scoring.** Inbound authentication is enforced
  upstream by Email Routing (see below), but nothing here scores content.
- **Authentication results are recorded, not surfaced.** The `auth` field is
  populated at ingest and never shown in the UI.
- **DMARC aggregate reports are not parsed.** Point `rua=` at a mailbox here
  and the reports arrive as ordinary mail with gzipped XML attachments — the
  posture checker tells you the record is right, not what the reports say.
- **MTA-STS ships in testing mode**, so TLS is reported on rather than
  required. Moving to enforce is unverified against Email Routing's MX.
- **The suppression list is local only.** Cloudflare maintains its own; this
  one is populated from bounces we see and is never reconciled with theirs.
- **No send rate limiting.** A compromised session can send at will, and will
  simply collect `E_RATE_LIMIT_EXCEEDED` and queue.
- **Complaint feedback loops are not ingested** — only bounces are.
- **No signatures, no contacts, no conversation-grouped inbox** (the list is
  message-level), and no mailbox release route.

## Known limits

- **Outbound body is plain text plus a generated HTML part.** No rich-text
  composer, and no inline `cid:` images — the binding supports
  `disposition: "inline"` with a `contentId`, but nothing here emits it.
- **Uploads are bounded by Worker memory, downloads are not.** `formData()`
  buffers the upload, so a file in the hundreds of megabytes will fail on the
  way in even though the download path streams fine. Lifting that means
  presigned direct-to-R2 uploads from the browser, which needs R2 S3 API
  credentials this app does not currently hold.
- **A download link is bearer access.** Anyone holding the URL can fetch the
  file until it expires; there is no per-recipient binding. Deleting the R2
  object is the only revocation.
- **The archived copy of a sent message is reconstructed.** The send binding
  builds the real MIME internally and doesn't return it, so `sent.eml` is a
  faithful record of what we asked to send, not a byte-copy of what left.
- **Search indexes the first `SEARCH_BODY_CHARS` of a body**, not all of it.
  Long messages are searchable by their opening, subject and sender only.
- **Under storage pressure, old mail loses body-search depth.** Once a mailbox
  crosses the high watermark the oldest messages are re-indexed on subject,
  sender and label alone. They stay listed and readable; only body search
  narrows, and only for the oldest.
- **No ranking.** Results are strictly newest-first, not relevance-ordered.
  That is what makes the cursor cheap, but there is no "best match" notion.
- **Search is arrival-ordered**, not date-ordered. Backdated mail sorts by
  when it arrived, which is what keeps the cursor cheap.
- **Sweep batches at 200 messages.** A mailbox with a large backlog drains over
  several alarm cycles (it reschedules itself a minute out while catching up).
- **One shared domain.** `MailboxDO` is keyed by full address, so per-tenant
  domains work already, but the claim form only offers `MAIL_DOMAIN`.
- **One sub-address namespace is reserved.** A label cannot be `t.<x>`;
  everything else is yours.
- **Folders are flat and derived.** A label exists only while mail carrying it
  does; there is no rename, merge, or nesting.
- **The agent is wiring, not an implementation.** Config, scoping, per-thread
  state and the alarm hook are all in place; nothing drafts or sends yet.
- **Cloudflare caps:** 50 recipients per message, 5 MiB per message, 16 KB of
  headers, 998-character subjects. New accounts start on a conservative daily
  send quota that scales with sending reputation.
