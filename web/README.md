# Busta web

The Astro frontend for Busta, built into the same Worker as the mail server.
`src/worker.ts` is the Worker entry. It re-exports `email()`, the Durable
Objects and the Workflow from `../src`, and sends a web request to Astro only if
its path is in `ASTRO_ROUTES`. Every other path still uses the old string-rendered
pages in `../src/ui`. To move a page: build it here, add its path to `ASTRO_ROUTES`,
then delete its renderer from `../src/ui/pages.ts`.

```sh
npm run dev      # http://localhost:8787; styleguide at /design, full screens at /design/mock/* (development only)
npm run check    # astro check (types + templates)
npm run build
npm run deploy   # astro build, then wrangler deploy of the generated config
```

Config: the adapter reads `../wrangler.jsonc` (`configPath`) and `../.dev.vars`, and
keeps local state in `../.wrangler/state`, so dev data is shared with the old setup.

## Design system

- `src/styles/tokens.css` holds every color, font, size and radius, for light and dark. It follows the OS
  setting, and `data-theme="light|dark"` on `<html>` overrides it. `.theme-light`/`.theme-dark` pin a subtree.
- `src/styles/base.css` is the reset and base type. Base.astro imports it.
- `src/components/ui/` holds the components. Import them from the barrel: `import { Button, MailRow } from "../components/ui"`.
- `src/layouts/` has `Base` (head, fonts, no-flash theme script), `AppShell` (top bar, sidebar,
  pane) and `AuthLayout` (centered sign-in).
- `src/lib/audience.ts` has `audienceChanges(thread, self)`, which works out who was added, removed or
  moved (To/Cc/Bcc) at each message in a thread. `<AudienceDivider>` draws its result. Bcc is compared only between
  messages you sent, and sender/reply-all role swaps are not reported as moves.
- `src/lib/clerk-appearance.ts` is the Clerk theme built on the same CSS variables. Pass it as
  `clerk({ appearance: bustaAppearance })` once `@clerk/astro` is wired up.

Color roles: primary blue for actions; secondary slate for +tags; tertiary violet for the
agent only; attention red for unread marks only; error crimson, always with an icon and words;
warn amber for in flight; success green; star gold, used as an icon only. Threads are chat-style: `<ChatMessage>` puts other people's mail on the left and yours on the right, with quoted history
folded. Components take
meaning-based props (`tone="bounced"`), never colors.

## Sample screens

`src/pages/design/mock/*` build the Sign in, Mailbox and Thread screens from the design with the real layouts and components.
The sample data is in `src/mock/`. Clerk isn't wired in yet, so the sign-in card is a stand-in built from our own components.
`AgentDraft` and the agent bar are marked **Future**: agents aren't shipping yet.

The approved design these follow is saved at `../designs/2026-09-23-ui-pallet/index.html`.
