# Slop OS — base platform plan

> Status: **plan / architecture, not built** (2026-07-04). This is the
> direction for turning "slop computer" from one bespoke app into a **base
> OS + a plugin system**, with `circle` as the greyscale base product and
> `slop.computer` as a themed superset. Companion to
> [PLAN.md](PLAN.md) (the circle app itself) and
> [cypherpunkPlan.md-in-slop] (the original fork rationale).

## TL;DR

There is **one base OS** and every slop-style product is
`base OS + a theme + a set of apps + backend wiring`.

- **circle** = base OS + **greyscale theme** + basic apps (camera, screen,
  audio, chat, notes, wallet, bank) + a tiny **blind** relay. This *is* the
  base. **Peer-authority**: apps coordinate over an encrypted bus and
  persist to an encrypted blob store the relay can't read — no per-app
  server code, fully E2EE.
- **slop.computer** = the same base OS + **magenta theme** + many apps
  (poker, chess, browser, music, news…) + a bigger relay. **Server-authority**
  lives here: games/apps that need a trusted referee, secret-holding
  external calls, or indexing are **server plugins**.

The two primitives that make "all apps are plugins" actually true — and
that keep the relay small *and* private — are the **encrypted bus** and the
**encrypted blob store**. Server plugins are the deliberate exception, used
by slop, not by circle.

---

## 1. The reframe

Slop stops being "a big app" and becomes an **operating system**: a window
manager, a menu bar, a theme, an app-plugin API, and the agent **SKILL**.
Products are thin selections over it. circle and slop.computer share the OS;
they differ only in a theme file, an app list, and which backend they wire.

## 2. What an "app" is (three parts, most apps need two)

1. **A window** — client UI, a React plugin (`defineApp`).
2. **Coordination** — how members' copies talk: chat lines, a proposed tx, a
   vote, a move. Rides the **encrypted bus** (opaque to the relay).
3. **Server logic** — *optional*, only for apps that need a trusted party.

circle apps use parts 1–2 only. slop apps may add part 3.

## 3. Peer-authority (circle) vs server-authority (slop)

**This is the core split.**

- **circle = peer-authority.** App state lives with the members. Live
  coordination goes over the encrypted bus; durable state is written to the
  encrypted blob store (ciphertext the relay stores but can't read) and
  re-synced on join. Where a "trusted party" is unavoidable, it's a
  *member's browser* (e.g. share-your-node RPC), never the operator. Result:
  the relay is a blind kernel; everything is E2EE.
- **slop.computer = server-authority where it needs it.** Poker needs a
  dealer clients can't fake; the facilitator holds a hot wallet; transcript
  needs an STT key; browser-host runs Chromium. Those are **server plugins**
  on slop's relay. Each is a documented step *down* in privacy (that app's
  data is visible to the operator), which is fine for a public show and
  wrong for a private circle — hence the split.

**Privacy gradient (encode this as a base principle):** bus/blob apps are
blind-relay E2EE; server-plugin apps trust the operator. The base defaults
to the first; server plugins are opt-in per product.

## 3½. Multiplayer without server-authority (the Notes test)

The natural objection: *"most apps are multiplayer — when I type a note
everyone sees it — surely that needs the server?"* No. **"Multiplayer" ≠
"server logic."** A collaborative app needs three things, none of which
require the server to understand the app:

1. **Broadcast** my change to everyone → the encrypted **bus** (relay fans
   out ciphertext it can't read).
2. **Agree** on the resulting state → done *on the peers*: last-write-wins
   (`updatedAt`) for simple data, or a **CRDT** (Yjs / Automerge) for real
   collaborative text/lists — CRDTs merge concurrent edits deterministically
   with no central authority (`y-webrtc` already does Google-Docs-style
   editing over WebRTC with only a signaling relay). Our bus is the transport.
3. **Persist / late-join** → the encrypted **blob store** (relay holds
   ciphertext; a joiner fetches+decrypts it) or an online peer re-sends state
   (the `sync-request` pattern circle already uses).

For a collaborative-but-not-secret app the relay is only **relaying + storing**
— a blind pipe and a blind disk. It never runs the app.

**Existence proof (already built):** circle's wallet co-signing is a
multiplayer app — propose → everyone sees it → everyone signs → collects to
threshold → late-joiners sync — running entirely over the encrypted bus with
**zero wallet logic in the relay**. That's a *harder* multiplayer flow than
Notes.

**When you truly need server-authority** (the only cases): hidden information
(poker's deck must be secret from players), anti-cheat (a client could lie
about an outcome others can't verify), secrets/external calls (RPC/LLM key,
facilitator hot wallet), or trusted ordering (rare; usually a CRDT or the
chain covers it). Notes has none of these; poker has all of them. That's the
clean line — and why **most apps are multiplayer but very few need
server-authority.**

**Notes is the validation app.** It's the perfect first peer-authority
plugin: intuition says it needs a server, the model says it doesn't. Build
Notes on the bus + blob store first; if it works, the whole peer-authority
model is proven before the bigger refactor.

## 4. The relay, reframed: a microkernel + a plugin host

Today slop's relay is a ~9k-line monolith because per-app state/handlers all
live in it. In this model the relay is a small **kernel** with generic
primitives no app modifies:

1. **Rooms** + the password/gate + cookies
2. **Peer presence** (who's here)
3. **WebRTC signaling passthrough** (offer/answer/ice)
4. **Encrypted bus** — fan out opaque ciphertext to the room (ephemeral)
5. **Encrypted blob store** — durable per-room key/value the relay can't
   read; client encrypts app state → hands the relay a blob keyed by
   `room + appId` → re-fetches on join. Persistence without the relay
   understanding the data. *(new primitive vs circle today)*
6. **TURN** credential minting

With 1–6, **adding an app is zero relay code** — it uses the bus + blob
store. The relay stays small and blind.

**Escape hatch — server-plugin host (slop uses; circle ideally doesn't):**
```
defineServerApp({
  id: "poker",
  onMessage(ctx, peer, msg),      // app-namespaced messages "poker:*"
  routes(router),                 // HTTP under /apps/poker/*
  state: ctx.roomStore("poker"),  // kernel-provided per-room storage
  grants: ["rpc", "hotwallet"],   // capabilities the operator must enable
})
```
The kernel dispatches app-namespaced traffic generically (no monolith switch
to extend); plugins are isolated (can't touch another plugin's state or
kernel internals — same discipline `fleet/` follows toward `server.py`).

## 5. Durability & censorship-resistance of blob state

The encrypted blob store keeps the relay *blind*, but the operator still
controls *availability* (could withhold/delete). For a censorship-resistant
base, an app may additionally **checkpoint encrypted state to IPFS and/or
anchor a hash on-chain** (the room multisig is a natural anchor). So group
history can survive even a hostile operator. This is an app-level option,
not a kernel requirement.

## 6. The packages

Base = **two halves + a contract**:

- **`@slop/os`** (client): window manager, desktop, menu bar + dropdowns,
  the SKILL action, plugin registry, theme tokens (greyscale default),
  service contexts (`useMesh`, `useIdentity`, `useWallet`, `useRoom`,
  `useSkill`). Framework-agnostic React — **no Next-isms** — so both a Vite
  app (circle, static/IPFS) and a Next app (slop) can consume it.
- **`@slop/relay-kernel`** (server): rooms/auth/presence/signaling/bus/blob/
  TURN + the server-plugin host. Small and generic.
- **`@slop/app-kit`** (contract): what an app is written against —
  `defineApp` (client), optional `defineServerApp` (server), a `skill`
  markdown doc, theme-token usage.

**Apps are packages** (`@slop/app-chat`, `@slop/app-wallet`,
`@slop/app-poker`…), each with a client half and optionally a server half
and a skill doc. **Products select apps + a theme:**
- **circle**: `os` + `relay-kernel` + `[camera, screen, audio, chat, notes,
  wallet, bank]` + greyscale theme. Vite client + a relay that is ~just the
  kernel (target: **zero server plugins**).
- **slop.computer**: `os` + `relay-kernel` + all of circle's + `[poker,
  chess, browser, music, news, …]` + magenta theme + the server plugins
  those apps need. Next client + kernel-plus-plugins relay.

## 7. The app-kit contract (sketch)

```ts
// client half — every app
defineApp({
  id: "notes",
  label: "Notes",
  icon: "/icons/notes.png",
  window: { defaultSize: { w: 360, h: 300 }, min: { w: 220, h: 160 } },
  Component: NotesWindow,          // renders in a Window, reads services via context
  menu?: [/* menu-bar contributions */],
  skill?: "…markdown: how an agent uses Notes…",
});

// server half — only server-authority apps (slop)
defineServerApp({ id, onMessage, routes, state, grants });
```
Services an app consumes (interfaces; product supplies impl):
`useMesh()` (presence, media publish/subscribe, encrypted bus send/recv),
`useBlob(appId)` (encrypted durable store), `useIdentity()`,
`useWallet()`, `useRoom()` (slug, invite link, secret), `useSkill()`.

## 8. Theme

Base defines the `--slop-*` token contract; the **default palette is
greyscale** (circle). A product ships a token override for its identity
(slop = magenta/purple/cyan/lime). "Grey base, pink slop" = two token files.
Lean **build-time** theming (each product bundles its theme) so the static
client stays IPFS-friendly; runtime theme-swap is a possible later nicety.

## 9. The SKILL (first-class in the base) — ✅ SHIPPED (2026-07-05)

The menu's **Skill** action composes a markdown brief an agent follows to
*operate the room*, and copies it to the clipboard. `composeSkill()` in
`@slop/os` assembles a system preamble + **each installed app's own `skill`
section** (so the instructions always match the installed apps) + the invite
link. Agent-operability is a base feature, not a slop extra — especially apt
for the "civil society + agents" thesis.

**Design note — why client-composed, not a kernel agent token.** The original
sketch (below, kept for the slop.computer contrast) had the kernel mint a
room-scoped agent token and serve a fetchable `/v1/skill?token=…` URL. That
fits slop.computer's **server-authority** model — its relay sees content, so a
server-side token can grant an agent real capability. But circle's relay is
**blind** (peer-authority, E2EE): a server token could get an agent *into* the
room but could never let it *read* anything, since the content keys are derived
from the URL-fragment secret the relay never sees. So for circle the honest
design is: **compose the skill client-side and let the invite link be the
credential** — its fragment carries the secret peer-to-peer, the relay stays
blind, and the agent operates by driving the client with the link. When
slop.computer migrates onto the base (P6), it can add the kernel-token variant
for its server-authority apps; the two models coexist, each right for its
authority model.

*Original (server-authority) sketch, for slop.computer:* the kernel serves
`/v1/skill` + mints room-scoped agent tokens; each app plugin contributes its
`skill` section; the base composes them into the system skill.

## 10. Propagation

North star: *change the base → it reaches slop.computer.* Mechanism:
**versioned base packages** (`@slop/os`, `@slop/relay-kernel`, `@slop/app-kit`)
that both products depend on; bump + reinstall + redeploy to propagate.
Controlled (not instant), keeps circle (static/IPFS) and slop (Next) release
cycles independent, matches the "fork family" idea in slop's DESIGN.md.

Start with the base packages living **inside the circle repo**, consumed by
circle; publish them when stable.

**Honest hard part:** propagation only becomes real once **slop.computer is
refactored to consume the base** — today it's a monolith with apps hardcoded
in `Desktop.tsx` + the relay. That migration is the single biggest cost here
and is a *separate, later* phase. Until then circle is the reference base and
slop benefits only once migrated. Don't let the propagation dream block
building the base.

**Two implementations exist today (be honest about this).** `@slop/os` is a
*fresh, framework-agnostic reimplementation* of slop's window manager/OS (Vite,
no Next-isms) — it **looks** like slop.computer but shares **no code** with it.
slop.computer still runs its own separate monolith and does not consume
`@slop/os`. So right now there are two parallel windowing codebases. This is
exactly why circle.slop.computer "isn't really slop computer" — it's a cousin,
not the same OS. Collapsing the two into one *is* the P6 migration.

**The migration has two possible directions (open — see §13.7):**
1. **`@slop/os` is the source of truth; slop adopts it.** Keep building the base
   on circle; later refactor slop's `Desktop.tsx` to render from `@slop/os` +
   the app registry instead of hardcoded apps. (What the roadmap currently
   assumes.) Risk: `@slop/os` must grow to match slop's polish/features before
   slop can drop its own OS.
2. **Extract the base *from* slop's real code.** Treat slop.computer's actual,
   polished OS as the thing to package: de-Next-ify it into `@slop/os`, then
   have both circle and slop consume that. Risk: slop's code is entangled with
   Next + server-authority assumptions; the extraction is the hard part, and
   circle's proven Vite/E2EE build would have to re-absorb it.
Either way **slop.computer must migrate** — that's the unavoidable, expensive
step. The direction only changes *which* codebase is the donor.

## 11. Roadmap

- **P0 — Contracts.** `@slop/app-kit`: `defineApp` / `defineServerApp` /
  `skill` / theme tokens / service-context interfaces. Mostly design.
- **P1 — OS + kernel.** Extract circle's current window/menu/theme into
  `@slop/os` (add real dropdown menus + the SKILL action); extract the relay
  into `@slop/relay-kernel` and **add the encrypted blob store**.
- **P2 — Basic apps as plugins.** Build **Notes first** as the peer-authority
  validation app (bus + encrypted blob store, no server) — see §3½ — then the
  rest: camera/screen/audio/chat/wallet/bank. Prove circle runs with **zero
  server plugins**.
- **P3 — Greyscale polish + SKILL end-to-end. ✅ DONE (2026-07-05).**
  (1) The SKILL: `composeSkill()` in `@slop/os` + a "Skill" menu action compose
  per-app skill docs + the invite link into an agent brief, copied to the
  clipboard. Client-composed (relay stays blind) not a kernel token — see §9.
  (2) Greyscale theme: `web/src/theme/base.css` (the @slop/os design system) now
  routes ALL color through a two-layer token contract — a PALETTE a product
  overrides (accent/secondary/live/warn/alert as `-rgb` triplets) + SEMANTIC
  tokens; ships a greyscale default. `index.css` is the thin product entry
  (imports base, empty override, documents slop's magenta override as the
  worked example). A product reskins by overriding ~7 tokens, nothing
  structural — the exact seam P6 needs. Live at circle.slop.computer.
- **P4 — Extract packages. ✅ DONE (2026-07-05).** The base is now four
  workspace packages: `@slop/app-kit` (contract), `@slop/os` (client OS —
  Vite bundles its TS source), `@slop/relay-kernel` (server core — builds to
  dist, Node consumes it; build order kernel→relay→web), and the apps.
  `web/` + `relay/` are the circle product. All green + deployed live.
- **P5 — split the standalone base repo. DEFERRED (deliberately).** The
  boundaries are proven and the monorepo already gives clean packages + a
  physical seam. A separate repo only pays off with a *second* consumer, so
  the right trigger is **when slop.computer is ready to migrate onto the
  base** — split then (via `git subtree split` per package) so circle + slop
  both consume it. Splitting now, with circle the only consumer, is pure
  cross-repo friction for no gain.
- **P6 — migrate slop.computer** onto the base: magenta theme, its apps as
  plugins (client + server-authority server plugins). Propagation becomes
  bidirectional here — and this is what triggers P5.
- **Next up.** P0–P4 are done and circle is a complete, live, greyscale,
  peer-authority product on the extracted base. The two remaining threads are
  both **P6-flavored** (they need slop.computer to move): the repo split (P5,
  triggered by a 2nd consumer) and the slop migration itself (P6, incl. the
  §13.7 direction decision). Absent starting P6, the productive circle-only
  work left is app breadth (bank, richer notes via a CRDT — §3½) and the
  blob durability/IPFS checkpoint option (§5). The base platform itself is
  feature-complete against this plan.

## 12. How current `circle` code maps in

- `web/src/ui/slop.tsx` (Window, DesktopBackground, menu bar) → `@slop/os`
  (add dropdown-menu system + SKILL).
- `web/src/mesh/*`, `web/src/crypto/*` (mesh client, E2EE bus, frame crypto)
  → `@slop/os` service layer (`useMesh`, encrypted bus).
- `relay/src/*` (rooms, room-auth, signal, send) → `@slop/relay-kernel`;
  **add** the encrypted blob store primitive.
- `web/src/wallet/*` → `@slop/app-wallet` + `@slop/app-bank` plugins.
- `ChatPanel` → `@slop/app-chat`; new `@slop/app-notes`; camera/screen/audio
  → share-app plugins wrapping `useLocalMedia` + `mesh.publish`.

## 13. Open decisions (still discussing)

1. **Blob durability** — ship the IPFS/on-chain checkpoint option in the base,
   or leave it per-app? (Leaning: a base-provided helper apps can opt into.)
2. **Peer-authority reach** — how far to push "a member's browser is the
   dealer/RPC/indexer" vs accepting a server plugin. (circle: as far as
   possible; slop: pragmatic servers.)
3. **Repo/packaging** — base packages inside the circle repo now, publish
   later (leaning yes) vs a dedicated base repo immediately.
4. **Naming/scope** — `@slop/*` (family) vs a neutral scope.
5. **Theme timing** — build-time (leaning, IPFS-friendly) vs runtime swap.
6. **When to start the slop.computer migration** — after the base is proven
   by circle (leaning) vs in parallel.
7. **Migration direction** (see §10, "two directions") — `@slop/os` is the
   source of truth and slop adopts it (leaning; keeps circle's clean E2EE/Vite
   base as the donor) vs extract the base from slop's real, polished OS code.
   Either way slop must migrate; this only decides the donor codebase.
