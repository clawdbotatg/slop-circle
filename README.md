# circle

**Spin up a box, share a link and a password, and your group gets
un-snoopable video calls gathered around a shared wallet.** No accounts,
no third parties, no wallet software — a passkey is enough to join, see
your friends, and (soon) co-sign from a shared treasury.

Even the server operator can't snoop: media is peer-to-peer and every
frame is encrypted with a key derived from the room secret in the URL
fragment, which never reaches the server. Small enough that anyone can
fork it, audit it, and run it anywhere.

---

# Fire up a circle — runbook (hand this section to your agent)

**Goal:** get a public HTTPS URL you can send to friends so you can meet.
Follow ONE of the two paths. Both end with a link to share.

**Why HTTPS is required:** browsers only allow camera/mic and passkeys on
`https://` or `localhost` — never a bare IP. So sharing with other people
always needs a real HTTPS URL (a tunnel or a domain). This is not optional.

**Prerequisites:** Node.js 18+ and `git`. Path B additionally needs Docker
and a domain name.

## Path A — quick shareable link, no server, no domain (~2 minutes)

Best for "let's meet in the next hour." The link is temporary (lives as
long as the two commands keep running).

```bash
# 1. get the code and its deps
git clone https://github.com/clawdbotatg/slop-circle
cd slop-circle
npm install

# 2. start circle locally (leave this running)
npm start
#    → serves at http://localhost:8788

# 3. in a SECOND terminal, expose it over public HTTPS (leave running too)
npx cloudflared tunnel --url http://localhost:8788
#    → prints a URL like https://something-random.trycloudflare.com
```

Give the human the `https://…trycloudflare.com` URL. Then follow
**"How to meet"** below to create a room and get the invite link.

> If `cloudflared` is unavailable, `npx localtunnel --port 8788` also works
> (it may show a one-time interstitial page to each visitor).

## Path B — a permanent instance on a box with a domain

Best for a circle you'll reuse. Needs Docker and a domain you can point at
the box.

```bash
git clone https://github.com/clawdbotatg/slop-circle
cd slop-circle/deploy

# 1. point an A record for your domain (e.g. circle.example.org) at this
#    box's public IP. Open TCP 80 and 443 in the firewall.

# 2. configure
cp .env.example .env
#    set in .env:
#      CIRCLE_DOMAIN=circle.example.org
#      CIRCLE_SESSION_SECRET=$(openssl rand -hex 32)   # paste the output

# 3. launch (Caddy fetches a Let's Encrypt cert automatically)
docker compose up -d --build
```

Your instance is at `https://your-domain`. Optional TURN (for friends
behind strict NATs — most calls connect without it) is in
[deploy/DEPLOY.md](deploy/DEPLOY.md).

## How to meet (do this once the URL is live)

1. Open the URL in a browser.
2. Enter a **room name** (lowercase letters/digits/dashes) and a
   **password** of your choosing, then **Enter**. You'll be asked to
   **Create room** — confirm it. You're now in the room.
3. Click **Copy invite link** in the top bar. That link contains the room
   and password (in the part after `#`, which never reaches the server).
4. Send that link to your friends over any channel. They open it, pick a
   display name, and click **Camera**. You're all in an encrypted call.

That's it. The badge in the top bar reads **🔒 sub rosa** when the call is
end-to-end encrypted.

---

## What works today

- **End-to-end-encrypted mesh video / audio / screen-share.** Media is
  peer-to-peer; the server only relays encrypted signaling. A malicious
  relay sees ciphertext (proven by `test/e2ee-adversarial.mjs`).
- **Authenticated peers.** Each peer proves it knows the room secret to
  the others; an injected peer is flagged and can decrypt nothing.
- **Passkey wallet identity.** Create an on-chain multisig signer with
  Face ID / Touch ID (no wallet app), see your personal-wallet address +
  balance, and sign — self-verified.
- **Shared circle wallet.** Propose a transaction from the room's multisig;
  members co-sign it over the encrypted bus until the threshold is met
  ("2 / 2 signed — ready to execute"). Everything up to the final on-chain
  broadcast works today; broadcasting the met-threshold transaction needs a
  funded key (the next step) — see [PLAN.md](PLAN.md).

## Try it locally first (single machine, no sharing)

```bash
npm install && npm start
```

Open **http://localhost:8788** in two browser tabs (use `localhost`, not
`127.0.0.1`). Create a room in the first, paste the link into the second,
turn on the camera in both.

## Good to know

- **The server is disposable and blind.** It routes encrypted signaling
  and serves static files — never media, keys, or the room secret. Seizing
  the box yields a scrypt password hash and connection timestamps, nothing
  more.
- **Group size:** it's a full mesh, so it's built for small circles
  (~6–10 people), not a webinar.
- **The room password is the door.** Anyone with the invite link can join.
  Rotate it (or use a fresh room) to remove someone.
- **Mainnet.** The wallet targets Ethereum mainnet; point it at your own
  node in the Wallet → Network settings (a public endpoint is a bootstrap
  default only).

## Status

Phases 0–1 complete (E2EE mesh + authenticated peers + swappable
transport); Phase 2 (the multisig circle) in progress. Full blueprint —
architecture, trust ladder, threat model, roadmap — in [PLAN.md](PLAN.md).

## Layout

```
relay/    the disposable signaling server (small, blind, stateless-ish)
web/      the static client (Vite) — destined for IPFS + ENS
deploy/   Dockerfile + compose + Caddy + coturn, and DEPLOY.md
test/     end-to-end tests (headless Chromium + virtual WebAuthn)
```

## License

MIT. Fully forkable — that's the point.
