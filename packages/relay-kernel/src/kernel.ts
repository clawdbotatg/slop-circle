/// <reference types="@fastify/cookie" />
/// <reference types="@fastify/websocket" />
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { roomCookieName, signRoomCookie, verifyRoomCookie } from "./room-auth.js";
import { getOrCreateRoom, isValidSlug, type Publication, type StreamKind } from "./room.js";
import { send } from "./send.js";

// @commons/relay-kernel — the blind, generic server core every slop-style
// product's relay is built on. It owns rooms + the password gate, peer
// presence, WebRTC signaling passthrough, the encrypted message bus, the
// encrypted blob store, and TURN credential minting — and nothing app- or
// product-specific. A product (circle, later slop.computer) creates a Fastify
// app, registers cookie + websocket, calls registerKernel(app, cfg), and adds
// its own bits (static client, server-plugin apps). See BASE-PLAN.md.

export type KernelConfig = {
  sessionSecret: string;
  dataDir: string;
  turnSecret: string;
  turnHost: string;
  turnTtlSeconds: number;
};

const ROOM_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60;
const BLOB_MAX_BYTES = 1_000_000;
const VALID_KEY = /^[a-z0-9-]{1,64}$/;

export function registerKernel(app: FastifyInstance, cfg: KernelConfig): void {
  const room = (slug: string) => getOrCreateRoom(slug, cfg.dataDir);
  const hasValidRoomCookie = (req: FastifyRequest, slug: string): boolean =>
    verifyRoomCookie(req.cookies?.[roomCookieName(slug)], slug, cfg.sessionSecret);

  const setRoomCookie = (reply: FastifyReply, slug: string) =>
    reply.setCookie(roomCookieName(slug), signRoomCookie(slug, cfg.sessionSecret), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: ROOM_COOKIE_TTL_SECONDS,
    });

  // Tiny in-memory rate limit for password attempts: 10/min per IP.
  const attemptBuckets = new Map<string, { count: number; resetAt: number }>();
  const rateLimited = (ip: string): boolean => {
    const now = Date.now();
    const bucket = attemptBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      attemptBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > 10;
  };

  // --- Room lifecycle: whoever claims a slug first sets its password. ---
  app.post<{ Params: { slug: string }; Body: { password?: string } }>("/v1/rooms/:slug/claim", async (req, reply) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < 4) return reply.code(400).send({ error: "password-too-short" });
    const r = room(slug);
    if (r.auth.hasPassword()) return reply.code(409).send({ error: "room-already-exists" });
    r.auth.setPassword(password);
    setRoomCookie(reply, slug);
    return { ok: true, slug };
  });

  app.post<{ Params: { slug: string }; Body: { current?: string; next?: string } }>(
    "/v1/rooms/:slug/password",
    async (req, reply) => {
      const { slug } = req.params;
      if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
      if (rateLimited(req.ip)) return reply.code(429).send({ error: "rate-limited" });
      const current = typeof req.body?.current === "string" ? req.body.current : "";
      const next = typeof req.body?.next === "string" ? req.body.next : "";
      if (next.length < 4) return reply.code(400).send({ error: "password-too-short" });
      const r = room(slug);
      if (!r.auth.hasPassword()) return reply.code(404).send({ error: "no-such-room" });
      if (!r.auth.verify(current)) return reply.code(401).send({ error: "bad-password" });
      r.auth.setPassword(next);
      return { ok: true };
    },
  );

  app.post<{ Params: { slug: string }; Body: { password?: string } }>("/v1/rooms/:slug/auth", async (req, reply) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    if (rateLimited(req.ip)) return reply.code(429).send({ error: "rate-limited" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password) return reply.code(400).send({ error: "missing-password" });
    const r = room(slug);
    if (!r.auth.hasPassword()) return reply.code(404).send({ error: "no-such-room" });
    if (!r.auth.verify(password)) return reply.code(401).send({ error: "bad-password" });
    setRoomCookie(reply, slug);
    return { ok: true, slug };
  });

  app.get<{ Params: { slug: string } }>("/v1/rooms/:slug/auth", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    const r = room(slug);
    return { slug, exists: r.auth.hasPassword(), authed: hasValidRoomCookie(req, slug) };
  });

  // --- Encrypted blob store: durable per-room key/value the relay can't read. ---
  const blobPath = (slug: string, key: string) => join(cfg.dataDir, "rooms", slug, "blobs", `${key}.blob`);

  // List a room's blob keys — lets a member export the whole encrypted room
  // for portable, operator-independent durability (they still can't read it).
  app.get<{ Params: { slug: string } }>("/v1/rooms/:slug/blobs", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { slug } = req.params;
    if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
    if (!hasValidRoomCookie(req, slug)) return reply.code(401).send({ error: "room-auth-required" });
    try {
      const keys = readdirSync(join(cfg.dataDir, "rooms", slug, "blobs"))
        .filter(f => f.endsWith(".blob"))
        .map(f => f.slice(0, -".blob".length));
      return { keys };
    } catch {
      return { keys: [] };
    }
  });

  app.get<{ Params: { slug: string; key: string } }>("/v1/rooms/:slug/blob/:key", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { slug, key } = req.params;
    if (!isValidSlug(slug) || !VALID_KEY.test(key)) return reply.code(400).send({ error: "bad-slug-or-key" });
    if (!hasValidRoomCookie(req, slug)) return reply.code(401).send({ error: "room-auth-required" });
    try {
      return { data: readFileSync(blobPath(slug, key), "utf8") };
    } catch {
      return reply.code(404).send({ error: "not-found" });
    }
  });

  app.put<{ Params: { slug: string; key: string }; Body: { data?: string } }>(
    "/v1/rooms/:slug/blob/:key",
    async (req, reply) => {
      const { slug, key } = req.params;
      if (!isValidSlug(slug) || !VALID_KEY.test(key)) return reply.code(400).send({ error: "bad-slug-or-key" });
      if (!hasValidRoomCookie(req, slug)) return reply.code(401).send({ error: "room-auth-required" });
      const data = typeof req.body?.data === "string" ? req.body.data : "";
      if (!data) return reply.code(400).send({ error: "missing-data" });
      if (data.length > BLOB_MAX_BYTES) return reply.code(413).send({ error: "too-large" });
      const path = blobPath(slug, key);
      try {
        mkdirSync(join(cfg.dataDir, "rooms", slug, "blobs"), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, data);
        renameSync(tmp, path);
      } catch {
        return reply.code(500).send({ error: "write-failed" });
      }
      return { ok: true };
    },
  );

  // --- TURN credentials (coturn REST scheme). ---
  app.get<{ Querystring: { slug?: string } }>("/turn/credentials", async (req, reply) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug : "";
    if (!isValidSlug(slug) || !hasValidRoomCookie(req, slug)) return reply.code(401).send({ error: "room-auth-required" });
    if (!cfg.turnSecret || !cfg.turnHost) return reply.code(503).send({ error: "turn-not-configured" });
    const expiry = Math.floor(Date.now() / 1000) + cfg.turnTtlSeconds;
    const username = `${expiry}:${randomBytes(4).toString("hex")}`;
    const credential = createHmac("sha1", cfg.turnSecret).update(username).digest("base64");
    return {
      username,
      credential,
      ttl: cfg.turnTtlSeconds,
      urls: [
        `stun:${cfg.turnHost}:3478`,
        `turn:${cfg.turnHost}:3478?transport=udp`,
        `turn:${cfg.turnHost}:3478?transport=tcp`,
      ],
    };
  });

  app.get("/healthz", async () => ({ ok: true }));

  // --- WS signaling: presence + WebRTC passthrough + encrypted bus. ---
  app.register(async fastify => {
    fastify.get("/signal", { websocket: true }, (socket, req) => {
      const url = new URL(req.url ?? "/", "http://x");
      const slug = url.searchParams.get("slug") ?? "";
      if (!isValidSlug(slug)) {
        send(socket, { type: "error", error: "bad-slug" });
        socket.close(4404, "room-not-found");
        return;
      }
      const r = room(slug);
      if (!r.auth.hasPassword()) {
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
      const info = { id: peerId, handle: handleRaw ? handleRaw.slice(0, 32) : null, connectedAt: Date.now() };

      r.addPeer({ ...info, ws: socket });
      send(socket, {
        type: "hello",
        id: peerId,
        peers: r.listPeers().filter(p => p.id !== peerId),
        publications: r.listPublications(),
      });
      r.broadcast({ type: "peer_join", peer: info }, peerId);

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
            const ok = r.sendTo(msg.to, { type: "signal", kind: msg.type, from: peerId, payload: msg.payload });
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
            const pub: Publication = { streamId: msg.streamId, peerId, kind: msg.kind as StreamKind, label: msg.label.slice(0, 64) };
            r.publish(pub);
            r.broadcast({ type: "published", publication: pub });
            return;
          }
          case "unpublish": {
            if (typeof msg.streamId !== "string") return send(socket, { type: "error", error: "missing-streamId" });
            const ownerId = r.findPublicationOwner(msg.streamId) ?? peerId;
            if (r.unpublish(ownerId, msg.streamId)) r.broadcast({ type: "unpublished", peerId: ownerId, streamId: msg.streamId });
            return;
          }
          // Opaque encrypted group bus (chat, wallet, notes) — fan-out only.
          case "room_msg": {
            if (typeof msg.payload !== "string") return send(socket, { type: "error", error: "bad-room-msg" });
            r.broadcast({ type: "room_msg", from: peerId, payload: msg.payload }, peerId);
            return;
          }
          case "set_camera_off": {
            if (typeof msg.streamId !== "string" || typeof msg.off !== "boolean") {
              return send(socket, { type: "error", error: "bad-camera-off" });
            }
            const pub = r.setCameraOff(peerId, msg.streamId, msg.off);
            if (pub) r.broadcast({ type: "published", publication: pub });
            return;
          }
        }
      });

      socket.on("close", () => {
        const ended = r.clearPeerPublications(peerId);
        r.removePeer(peerId);
        for (const p of ended) r.broadcast({ type: "unpublished", peerId, streamId: p.streamId });
        r.broadcast({ type: "peer_leave", peer: info });
      });
    });
  });
}
