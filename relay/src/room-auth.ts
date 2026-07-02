import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// scrypt "interactive login" parameters — ~50ms per verify.
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const SCRYPT_N = 16384; // 2^14
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function hashPassword(plaintext: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(plaintext: string, stored: string): boolean {
  const idx = stored.indexOf(":");
  if (idx < 0) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(stored.slice(0, idx), "hex");
    expected = Buffer.from(stored.slice(idx + 1), "hex");
  } catch {
    return false;
  }
  let computed: Buffer;
  try {
    computed = scryptSync(plaintext, salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  } catch {
    return false;
  }
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// Only the scrypt hash touches disk — the relay never stores a plaintext
// room password.
type RoomAuthState = { passwordHash: string | null; createdAt: number };

export class RoomAuth {
  private state: RoomAuthState = { passwordHash: null, createdAt: 0 };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<RoomAuthState>;
      this.state = {
        passwordHash: typeof parsed.passwordHash === "string" ? parsed.passwordHash : null,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      };
    } catch {
      /* fresh — no password yet */
    }
  }

  hasPassword(): boolean {
    this.load();
    return this.state.passwordHash !== null;
  }

  setPassword(plaintext: string): void {
    if (!plaintext) throw new Error("empty password");
    this.load();
    this.state = {
      passwordHash: hashPassword(plaintext),
      createdAt: this.state.createdAt || Date.now(),
    };
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch {
      /* disk write failure — in-memory hash still valid until restart */
    }
  }

  verify(plaintext: string): boolean {
    this.load();
    if (!this.state.passwordHash) return false;
    return verifyPassword(plaintext, this.state.passwordHash);
  }
}

export const ROOM_COOKIE_PREFIX = "circle_room_";

export function roomCookieName(slug: string): string {
  return `${ROOM_COOKIE_PREFIX}${slug}`;
}

export function signRoomCookie(slug: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ slug, iat: Date.now() }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyRoomCookie(cookie: string | undefined, slug: string, secret: string): boolean {
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot < 0) return false;
  const payloadB64 = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    // Slug is bound into the signed payload → no cross-room cookie replay.
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { slug?: unknown };
    return payload.slug === slug;
  } catch {
    return false;
  }
}
