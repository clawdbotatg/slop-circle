# slop-circle (working title)

**Spin up a box, share a link and a password, and your group gets
un-snoopable video calls gathered around a shared multisig wallet on
Ethereum mainnet.** No accounts, no third parties, no wallet software
required — a passkey is enough to join, see your friends, and co-sign
from the treasury.

This is the minimal, cypherpunk extraction of
[slop-computer-live](https://github.com/clawdbotatg/slop-computer-live):
just the peer-to-peer mesh video and the passkey-native multisig,
hardened so that even the server operator can't snoop, and small enough
that anyone can fork it, audit it, and run it anywhere.

The full blueprint — architecture, trust ladder, threat model, phases —
is in [PLAN.md](PLAN.md).

## Principles

- **The server knows nothing.** It forwards ciphertext between peers.
  Keys never touch it. Media never touches it (full-mesh WebRTC).
- **The client is unstoppable.** Static build, pinned to IPFS, named by
  ENS. Fork it, pin it yourself, verify the CID.
- **Every trust is named and optional.** Good UX by default,
  trust-a-friend in the middle, fully sovereign at the top — and all
  rungs coexist in one room.
- **No cloud AI. No telemetry. No analytics.**

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:8788** (use `localhost`, not `127.0.0.1` —
passkeys need a real domain or `localhost`). To test a call, open it in
**two browser tabs**: pick a room name + password in the first (that
creates the room), then paste the same link into the second and turn on
your camera in both. Click **Wallet** to create a passkey identity and
sign — no wallet software, no accounts.

Two tabs on one machine connect directly. Two *different* people on
different networks need a public HTTPS deployment plus a TURN server
(coming in the deploy packaging).

## What works today

- **End-to-end-encrypted mesh video/audio/screen** — media is
  peer-to-peer and every frame is encrypted with a key derived from the
  room secret in the URL fragment, which never reaches the server. A
  malicious relay sees only ciphertext (proven by `test/e2ee-adversarial.mjs`).
- **Authenticated peers** — each peer proves it knows the room secret;
  an injected peer is flagged and can't decrypt anything.
- **Passkey wallet identity** — create an on-chain multisig signer with
  Face ID / Touch ID, see your counterfactual personal-wallet address and
  balance, and sign (self-verified). Propose/execute over the mesh and the
  wallet-signers room gate are in progress.

## Status

Phases 0–1 complete (E2EE mesh + authenticated peers + swappable
transport); Phase 2 (the multisig circle) in progress. See
[PLAN.md](PLAN.md).

## Layout

```
relay/   the disposable signaling server (~small, blind, stateless-ish)
web/     the static client (Vite) — destined for IPFS + ENS
test/    end-to-end tests (headless Chromium + virtual WebAuthn)
```

## License

MIT. Fully forkable — that's the point.
