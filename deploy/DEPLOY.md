# Deploying a public circle

The whole point: **spin up a box, share a link, done.** A circle instance is
one small process (the relay, which also serves the client) behind Caddy for
HTTPS, plus optional coturn for NAT traversal. Anyone can run it — that's the
product.

You need HTTPS for a real deployment: browsers require it for camera/mic
access, and passkeys require a real domain (not a bare IP). Caddy handles the
cert automatically.

## Option A — a box you control (VPS, home server, Raspberry Pi)

1. **DNS:** point an `A` record for your domain (e.g. `circle.example.org`) at
   the box's public IP.
2. **Firewall:** open TCP `80` + `443`. If you'll use TURN, also open UDP
   `3478` and UDP `49160-49200`.
3. **Configure:**
   ```bash
   cd deploy
   cp .env.example .env
   # set CIRCLE_DOMAIN and CIRCLE_SESSION_SECRET (openssl rand -hex 32)
   ```
4. **Run:**
   ```bash
   docker compose up -d --build
   ```
   Visit `https://your-domain` — create a room, share the link + password.

### Adding TURN (for peers behind strict/symmetric NATs)

Calls connect for ~85-90% of peer pairs on STUN alone. For the rest, enable
coturn:

1. In `.env`, set `TURN_SECRET` (another `openssl rand -hex 32`) and
   `TURN_HOST` (this box's public IP or your domain).
2. Put the same secret and the box's public IP into
   `coturn/turnserver.conf` (`__TURN_SHARED_SECRET__`, `__PUBLIC_IP__`).
3. Start with the TURN profile:
   ```bash
   docker compose --profile turn up -d --build
   ```

## Option B — quick share for a one-off test (no VPS, no domain)

To just test with a friend for an hour, tunnel your local `npm start` to a
public HTTPS URL:

```bash
npm start                          # in one terminal (serves :8788)
npx cloudflared tunnel --url http://localhost:8788   # in another
```

Share the `https://…trycloudflare.com` URL it prints (append your
`#room:password`). Passkeys and camera work because the tunnel is real HTTPS.
This is ephemeral and STUN-only, but it's the zero-setup way to feel the
product with another person.

## Notes

- **The server stays blind.** It only routes encrypted signaling and serves
  static files. It never sees media, keys, or the room secret (which lives in
  the URL fragment and never leaves the browser). Seizing the box yields a
  scrypt hash and connection timestamps.
- **This packaging is adapted from slop-computer-live's prod-proven Caddy +
  coturn configs** but hasn't been run through `docker compose` in this repo's
  CI yet — if something's off on first boot, `docker compose logs` is the
  place to look. The relay refuses to start in production without
  `CIRCLE_SESSION_SECRET` set (by design).
- **The client is meant to move to IPFS/ENS** (a future step) so it can't be
  taken down; then the server is just a swappable, disposable relay any member
  runs.
