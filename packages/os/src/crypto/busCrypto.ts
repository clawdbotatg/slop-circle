// AES-GCM for the room message bus. Group messages (chat, wallet proposals
// and signatures) are encrypted with the bus key (derived from the room
// secret) before they touch the relay, so the relay only ever fans out
// ciphertext. Layout: [12-byte IV | ciphertext+tag], hex-encoded.

let keyPromise: Promise<CryptoKey> | null = null;
let keyRef: ArrayBuffer | null = null;

function importKey(keyBytes: ArrayBuffer): Promise<CryptoKey> {
  if (keyRef !== keyBytes) {
    keyRef = keyBytes;
    keyPromise = crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return keyPromise!;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const v of b) s += v.toString(16).padStart(2, "0");
  return s;
}
function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function encryptBus(obj: unknown, keyBytes: ArrayBuffer): Promise<string> {
  const key = await importKey(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt as BufferSource);
  return toHex(iv) + toHex(new Uint8Array(ct));
}

export async function decryptBus<T = unknown>(hex: string, keyBytes: ArrayBuffer): Promise<T | null> {
  try {
    const buf = fromHex(hex);
    if (buf.byteLength < 13) return null;
    const key = await importKey(keyBytes);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.subarray(0, 12) as BufferSource },
      key,
      buf.subarray(12) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null; // wrong key / tampered — drop
  }
}
