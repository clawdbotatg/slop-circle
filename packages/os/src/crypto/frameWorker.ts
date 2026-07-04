// Runs off the main thread as an RTCRtpScriptTransform worker (Safari +
// modern Chromium). Each encoded media frame is AES-GCM encrypted on the
// sender side and decrypted on the receiver side with the room media key.
// The transform sits between the codec and the packetizer, so what travels
// over the peer connection (and any TURN relay) is ciphertext.

/// <reference lib="webworker" />

import { decryptFrame, encryptFrame } from "./frameCipher";

type Op = "encrypt" | "decrypt";

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(keyBytes: ArrayBuffer): Promise<CryptoKey> {
  const cacheKey = String(keyBytes.byteLength) + ":" + new Uint8Array(keyBytes).join(",");
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(cacheKey, p);
  }
  return p;
}

function makeTransform(op: Op, keyBytes: ArrayBuffer): TransformStream {
  return new TransformStream({
    async transform(chunk: { data: ArrayBuffer; type?: string }, controller) {
      const key = await importKey(keyBytes);
      if (op === "encrypt") {
        await encryptFrame(chunk, key);
        controller.enqueue(chunk);
      } else if (await decryptFrame(chunk, key)) {
        controller.enqueue(chunk);
      }
    },
  });
}

(self as unknown as { onrtctransform: ((e: Event) => void) | null }).onrtctransform = (event: Event) => {
  const t = (event as unknown as {
    transformer: {
      readable: ReadableStream;
      writable: WritableStream;
      options: { operation: Op; keyBytes: ArrayBuffer };
    };
  }).transformer;
  const ts = makeTransform(t.options.operation, t.options.keyBytes);
  t.readable.pipeThrough(ts).pipeTo(t.writable);
};
