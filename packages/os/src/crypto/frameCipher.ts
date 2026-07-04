// Per-frame AES-GCM used by both the worker (RTCRtpScriptTransform) and the
// main-thread (createEncodedStreams) paths, so encrypt/decrypt can never
// drift apart.
//
// A leading run of bytes is left UNENCRYPTED: the WebRTC packetizer and the
// decoder inspect the codec header, so encrypting it round-trips at the byte
// level but the decoder still rejects the stream (frames decrypt fine yet no
// picture). Leaving the header clear is the established SFrame-style approach.
// Header lengths follow the WebRTC E2EE sample: 10 bytes for a video
// keyframe, 3 for a delta frame, 1 for audio.
//
//   layout:  [ clear header | 12-byte IV | AES-GCM ciphertext+tag ]

const GCM_TAG_BYTES = 16;
const IV_BYTES = 12;

type Frame = { data: ArrayBuffer; type?: "key" | "delta" | string };

function headerLen(frame: Frame): number {
  if ("type" in frame && (frame.type === "key" || frame.type === "delta")) {
    return frame.type === "key" ? 10 : 3;
  }
  return 1; // audio frame (no type)
}

export async function encryptFrame(frame: Frame, key: CryptoKey): Promise<void> {
  const data = new Uint8Array(frame.data);
  const n = Math.min(headerLen(frame), data.byteLength);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data.subarray(n));
  const out = new Uint8Array(n + IV_BYTES + ct.byteLength);
  out.set(data.subarray(0, n), 0);
  out.set(iv, n);
  out.set(new Uint8Array(ct), n + IV_BYTES);
  frame.data = out.buffer;
}

/** Returns true if the frame was decrypted, false if it should be dropped. */
export async function decryptFrame(frame: Frame, key: CryptoKey): Promise<boolean> {
  const data = new Uint8Array(frame.data);
  const n = Math.min(headerLen(frame), data.byteLength);
  if (data.byteLength < n + IV_BYTES + GCM_TAG_BYTES) return false;
  const iv = data.subarray(n, n + IV_BYTES);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data.subarray(n + IV_BYTES));
    const out = new Uint8Array(n + pt.byteLength);
    out.set(data.subarray(0, n), 0);
    out.set(new Uint8Array(pt), n);
    frame.data = out.buffer;
    return true;
  } catch {
    return false; // wrong key / not one of ours — drop
  }
}
