// Everything the group's privacy rests on is derived here, in the browser,
// from the room secret carried in the URL fragment (`#slug:secret`). The
// fragment never reaches any server.
//
// Two independent keys come out of the one secret, via PBKDF2 with distinct
// salt labels so neither can be computed from the other:
//
//   verifier  — sent to the relay IN PLACE OF the password. The relay
//               scrypt-hashes and stores it, so it gates entry without ever
//               seeing the secret. A relay that logs every verifier still
//               cannot derive the media key.
//   mediaKey  — never leaves the browser. Encrypts every media frame
//               (see frameCrypto). Even a fully malicious relay that MITMs
//               the WebRTC handshake, or injects its own peer, only ever
//               holds ciphertext.

const PBKDF2_ITERATIONS = 210_000;

async function pbkdf2(secret: string, label: string, slug: string, bytes: number): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const salt = enc.encode(`circle|${label}|${slug}`);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type RoomKeys = {
  /** Sent to the relay as the room "password". Safe for the server to see. */
  verifier: string;
  /** AES-256-GCM key material for frame encryption. Never sent anywhere. */
  mediaKey: ArrayBuffer;
  /** HMAC key material for peer-to-peer authentication. Never sent anywhere. */
  authKey: ArrayBuffer;
};

export async function deriveRoomKeys(secret: string, slug: string): Promise<RoomKeys> {
  const [verifierBytes, mediaBytes, authBytes] = await Promise.all([
    pbkdf2(secret, "verifier-v1", slug, 32),
    pbkdf2(secret, "media-v1", slug, 32),
    pbkdf2(secret, "auth-v1", slug, 32),
  ]);
  return {
    verifier: base64url(verifierBytes),
    // Return copies: callers may transfer these to a worker, so hand out
    // standalone ArrayBuffers.
    mediaKey: mediaBytes.slice().buffer,
    authKey: authBytes.slice().buffer,
  };
}
