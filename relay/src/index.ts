import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.js";
import { roomCookieName, signRoomCookie, verifyRoomCookie } from "./room-auth.js";
import { getOrCreateRoom, isValidSlug, type Publication, type StreamKind } from "./room.js";
import { send } from "./send.js";

// The circle relay: a deliberately blind, disposable signaling server.
// It forwards WebRTC signaling between peers who proved knowledge of the
// room password, mints TURN credentials, and serves the static client.
// It holds no media, no keys, no messages — seize the box and you get a
// scrypt hash and connection timestamps.

const app = Fastify({ logger: true });

await app.register(cookie);
await app.register(websocket);

const ROOM_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60;

function hasValidRoomCookie(req: { cookies?: Record<string, string | undefined> }, slug: string): boolean {
  return verifyRoomCookie(req.cookies?.[roomCookieName(slug)], slug, config.sessionSecret);
}

// Tiny in-memory rate limit for password attempts: 10/min per IP.
const attemptBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = attemptBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    attemptBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 10;
}

// --- Room lifecycle -------------------------------------------------------
// No host role exists: whoever claims a slug first sets its password.
// (Identity rungs — passkeys, wallets — arrive in Phase 2.)

app.post<{ Params: { slug: string }; Body: { password?: string } }>(
  "/v1/rooms/:slug/claim",
  async (req, reply) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < 4) return reply.code(400).send({ error: "password-too-short" });
    const room = getOrCreateRoom(slug);
    if (room.auth.hasPassword()) return reply.code(409).send({ error: "room-already-exists" });
    room.auth.setPassword(password);
    reply.setCookie(roomCookieName(slug), signRoomCookie(slug, config.sessionSecret), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: ROOM_COOKIE_TTL_SECONDS,
    });
    return { ok: true, slug };
  },
);

// Rotate: requires knowledge of the current password.
app.post<{ Params: { slug: string }; Body: { current?: string; next?: string } }>(
  "/v1/rooms/:slug/password",
  async (req, reply) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    if (rateLimited(req.ip)) return reply.code(429).send({ error: "rate-limited" });
    const current = typeof req.body?.current === "string" ? req.body.current : "";
    const next = typeof req.body?.next === "string" ? req.body.next : "";
    if (next.length < 4) return reply.code(400).send({ error: "password-too-short" });
    const room = getOrCreateRoom(slug);
    if (!room.auth.hasPassword()) return reply.code(404).send({ error: "no-such-room" });
    if (!room.auth.verify(current)) return reply.code(401).send({ error: "bad-password" });
    room.auth.setPassword(next);
    return { ok: true };
  },
);

// Verify password → issue the slug-scoped HMAC cookie.
app.post<{ Params: { slug: string }; Body: { password?: string } }>(
  "/v1/rooms/:slug/auth",
  async (req, reply) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    if (rateLimited(req.ip)) return reply.code(429).send({ error: "rate-limited" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password) return reply.code(400).send({ error: "missing-password" });
    const room = getOrCreateRoom(slug);
    if (!room.auth.hasPassword()) return reply.code(404).send({ error: "no-such-room" });
    if (!room.auth.verify(password)) return reply.code(401).send({ error: "bad-password" });
    reply.setCookie(roomCookieName(slug), signRoomCookie(slug, config.sessionSecret), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: ROOM_COOKIE_TTL_SECONDS,
    });
    return { ok: true, slug };
  },
);

// Page-load probe: does the room exist, and am I already in?
app.get<{ Params: { slug: string } }>("/v1/rooms/:slug/auth", async (req, reply) => {
  reply.header("cache-control", "no-store");
  const { slug } = req.params;
  if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
  const room = getOrCreateRoom(slug);
  return { slug, exists: room.auth.hasPassword(), authed: hasValidRoomCookie(req, slug) };
});

// --- TURN credentials -----------------------------------------------------
// coturn REST scheme: username "<expiry>:<rand>", credential
// base64(HMAC-SHA1(secret, username)). Gated by any valid room cookie so
// strangers can't farm relay bandwidth.

app.get<{ Querystring: { slug?: string } }>("/turn/credentials", async (req, reply) => {
  const slug = typeof req.query.slug === "string" ? req.query.slug : "";
  if (!isValidSlug(slug) || !hasValidRoomCookie(req, slug)) {
    return reply.code(401).send({ error: "room-auth-required" });
  }
  if (!config.turnSecret || !config.turnHost) {
    return reply.code(503).send({ error: "turn-not-configured" });
  }
  const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
  const username = `${expiry}:${randomBytes(4).toString("hex")}`;
  const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
  return {
    username,
    credential,
    ttl: config.turnTtlSeconds,
    urls: [
      `stun:${config.turnHost}:3478`,
      `turn:${config.turnHost}:3478?transport=udp`,
      `turn:${config.turnHost}:3478?transport=tcp`,
    ],
  };
});

app.get("/healthz", async () => ({ ok: true }));

// --- WS signaling ---------------------------------------------------------

app.register(async fastify => {
  fastify.get("/signal", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/", "http://x");
    const slug = url.searchParams.get("slug") ?? "";
    if (!isValidSlug(slug)) {
      send(socket, { type: "error", error: "bad-slug" });
      socket.close(4404, "room-not-found");
      return;
    }
    const room = getOrCreateRoom(slug);

    // Every room must be claimed — there is no open sandbox room.
    if (!room.auth.hasPassword()) {
      send(socket, { type: "error", error: "room-not-found", slug });
      socket.close(4404, "room-not-found");
      return;
    }
    if (!hasValidRoomCookie(req, slug)) {
      send(socket, { type: "error", error: "room-auth-required", slug });
      socket.close(4403, "room-auth-required");
      return;
    }

    const peerId = randomBytes(8).toString("hex");
    const handleRaw = url.searchParams.get("handle") ?? "";
    const info = {
      id: peerId,
      handle: handleRaw ? handleRaw.slice(0, 32) : null,
      connectedAt: Date.now(),
    };

    room.addPeer({ ...info, ws: socket });

    send(socket, {
      type: "hello",
      id: peerId,
      peers: room.listPeers().filter(p => p.id !== peerId),
      publications: room.listPublications(),
    });
    room.broadcast({ type: "peer_join", peer: info }, peerId);

    socket.on("message", (raw: Buffer | string) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: "error", error: "invalid-json" });
      }
      switch (msg?.type) {
        case "hello":
          return;
        case "ping":
          send(socket, { type: "pong" });
          return;

        case "offer":
        case "answer":
        case "ice": {
          if (typeof msg.to !== "string") return send(socket, { type: "error", error: "missing-to" });
          const ok = room.sendTo(msg.to, {
            type: "signal",
            kind: msg.type,
            from: peerId,
            payload: msg.payload,
          });
          if (!ok) send(socket, { type: "error", error: "peer-not-found", to: msg.to });
          return;
        }

        case "publish": {
          if (
            typeof msg.streamId !== "string" ||
            (msg.kind !== "camera" && msg.kind !== "screen" && msg.kind !== "audio") ||
            typeof msg.label !== "string"
          ) {
            return send(socket, { type: "error", error: "bad-publish" });
          }
          const pub: Publication = {
            streamId: msg.streamId,
            peerId,
            kind: msg.kind as StreamKind,
            label: msg.label.slice(0, 64),
          };
          room.publish(pub);
          room.broadcast({ type: "published", publication: pub });
          return;
        }

        case "unpublish": {
          if (typeof msg.streamId !== "string") return send(socket, { type: "error", error: "missing-streamId" });
          const ownerId = room.findPublicationOwner(msg.streamId) ?? peerId;
          const ok = room.unpublish(ownerId, msg.streamId);
          if (ok) room.broadcast({ type: "unpublished", peerId: ownerId, streamId: msg.streamId });
          return;
        }

        // Opaque encrypted group message bus (chat, wallet proposals +
        // signatures). The payload is AES-GCM ciphertext keyed from the room
        // secret — the relay only fans it out, never reads it.
        case "room_msg": {
          if (typeof msg.payload !== "string") return send(socket, { type: "error", error: "bad-room-msg" });
          room.broadcast({ type: "room_msg", from: peerId, payload: msg.payload }, peerId);
          return;
        }

        case "set_camera_off": {
          if (typeof msg.streamId !== "string" || typeof msg.off !== "boolean") {
            return send(socket, { type: "error", error: "bad-camera-off" });
          }
          const pub = room.setCameraOff(peerId, msg.streamId, msg.off);
          if (pub) room.broadcast({ type: "published", publication: pub });
          return;
        }
        // Unknown types: ignore.
      }
    });

    socket.on("close", () => {
      const ended = room.clearPeerPublications(peerId);
      room.removePeer(peerId);
      for (const p of ended) {
        room.broadcast({ type: "unpublished", peerId, streamId: p.streamId });
      }
      room.broadcast({ type: "peer_leave", peer: info });
    });
  });
});

// --- Static client --------------------------------------------------------
// In production one process serves everything: the relay and the built
// client (which can equally be pinned to IPFS — the client only needs
// this origin for /signal, /v1/rooms and /turn).

const distPath = resolve(config.webDist);
if (existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/v1") && !req.url.startsWith("/turn")) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "not-found" });
  });
}

await app.listen({ port: config.port, host: config.host });
