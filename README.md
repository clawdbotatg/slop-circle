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

## Status

**Phase 0 — extraction.** Carving the media-only WebRTC mesh and a
minimal relay out of slop-computer-live. Milestone: two browsers, one
password link, a video call through a relay that holds nothing.

## Layout

```
relay/   the disposable signaling server (~small, blind, stateless-ish)
web/     the static client (Vite) — destined for IPFS + ENS
```

## License

MIT. Fully forkable — that's the point.
