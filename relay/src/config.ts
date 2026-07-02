// Config comes straight from the process environment — no dotenv dep.
// For local files use `node --env-file=.env` (or tsx equivalent); prod
// uses the service manager's environment.

const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback ?? "";
  return v;
};

const isProd = process.env.NODE_ENV === "production";

// Fail closed on the session secret. It's the HMAC key for room-access
// cookies. The dev fallback is public in this repo — booting prod with it
// lets anyone forge a valid cookie for any room. Refuse to start.
// Generate one: `openssl rand -hex 32`.
const DEV_SESSION_SECRET = "dev-secret-change-me";
const sessionSecret = env("CIRCLE_SESSION_SECRET", DEV_SESSION_SECRET);
if (isProd && sessionSecret === DEV_SESSION_SECRET) {
  throw new Error(
    "CIRCLE_SESSION_SECRET is unset (or the public dev fallback) while NODE_ENV=production — refusing to start.",
  );
}

export const config = {
  port: Number(env("PORT", "8788")),
  host: env("HOST", "0.0.0.0"),
  sessionSecret,
  dataDir: env("CIRCLE_DATA_DIR", ".circle-data"),
  // TURN is optional: without it, calls are STUN-only (~85-90% of peer
  // pairs connect; symmetric-NAT pairs won't). Point these at a coturn
  // with `use-auth-secret` and the same secret.
  turnSecret: env("TURN_SECRET", ""),
  turnHost: env("TURN_HOST", ""),
  turnTtlSeconds: Number(env("TURN_TTL_SECONDS", "3600")),
  // Absolute or relative path to the built web client; served if present.
  webDist: env("CIRCLE_WEB_DIST", "../web/dist"),
};
