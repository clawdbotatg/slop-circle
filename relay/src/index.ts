import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { registerKernel } from "@commons/relay-kernel";
import Fastify from "fastify";
import { config } from "./config.js";

// The circle relay = the @commons/relay-kernel (blind rooms/auth/signaling/bus/
// blob/turn core) + circle's product wiring: it also serves the static
// client. It holds no media, no keys, no messages — seize the box and you get
// a scrypt hash and connection timestamps. circle registers ZERO server-plugin
// apps (everything is peer-authority over the bus + blob store); slop.computer
// is where server-authority apps would plug in.

const app = Fastify({ logger: true });

await app.register(cookie);
await app.register(websocket);

registerKernel(app, {
  sessionSecret: config.sessionSecret,
  dataDir: config.dataDir,
  turnSecret: config.turnSecret,
  turnHost: config.turnHost,
  turnTtlSeconds: config.turnTtlSeconds,
});

// Static client — one process serves the app and the API (the client can
// equally be pinned to IPFS; it only needs this origin for /signal, /v1, /turn).
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
