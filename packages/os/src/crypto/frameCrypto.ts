// Attaches the frame-encryption transform to WebRTC senders/receivers.
// Prefers the standard RTCRtpScriptTransform (worker-based; Safari + modern
// Chromium); falls back to the legacy createEncodedStreams API (older
// Chromium) which runs the same crypto on the main thread.

import { decryptFrame, encryptFrame } from "./frameCipher";

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./frameWorker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

export function frameCryptoSupported(): boolean {
  return (
    typeof (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== "undefined" ||
    typeof (RTCRtpSender.prototype as { createEncodedStreams?: unknown }).createEncodedStreams === "function"
  );
}

type Op = "encrypt" | "decrypt";

// Main-thread fallback: import the key once, run AES-GCM in a TransformStream.
let fallbackKey: Promise<CryptoKey> | null = null;
function fallbackImport(keyBytes: ArrayBuffer): Promise<CryptoKey> {
  if (!fallbackKey) {
    fallbackKey = crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return fallbackKey;
}

function fallbackTransform(op: Op, keyBytes: ArrayBuffer): TransformStream {
  return new TransformStream({
    async transform(chunk: { data: ArrayBuffer; type?: string }, controller) {
      const key = await fallbackImport(keyBytes);
      if (op === "encrypt") {
        await encryptFrame(chunk, key);
        controller.enqueue(chunk);
      } else if (await decryptFrame(chunk, key)) {
        controller.enqueue(chunk);
      }
    },
  });
}

type Endpoint = RTCRtpSender | RTCRtpReceiver;

let pathLogged = false;
function logPath(p: string): void {
  if (!pathLogged) {
    pathLogged = true;
    console.log("[frameCrypto] using", p);
  }
}

function attach(endpoint: Endpoint, op: Op, keyBytes: ArrayBuffer): void {
  const g = globalThis as { RTCRtpScriptTransform?: new (w: Worker, opts: unknown) => unknown };
  try {
    // Prefer the synchronous same-thread createEncodedStreams where present
    // (Chromium): no worker-readiness race. RTCRtpScriptTransform (Safari +
    // modern Chromium) runs the same crypto in a worker.
    const withStreams = endpoint as unknown as {
      createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
    };
    if (typeof withStreams.createEncodedStreams === "function") {
      logPath("createEncodedStreams (main thread)");
      const { readable, writable } = withStreams.createEncodedStreams();
      readable.pipeThrough(fallbackTransform(op, keyBytes)).pipeTo(writable);
      return;
    }
    if (typeof g.RTCRtpScriptTransform !== "undefined") {
      logPath("RTCRtpScriptTransform (worker)");
      (endpoint as unknown as { transform: unknown }).transform = new g.RTCRtpScriptTransform(getWorker(), {
        operation: op,
        keyBytes,
      });
      return;
    }
  } catch (err) {
    console.warn("[frameCrypto] attach failed", err);
  }
}

export function encryptSender(sender: RTCRtpSender, keyBytes: ArrayBuffer): void {
  attach(sender, "encrypt", keyBytes);
}

export function decryptReceiver(receiver: RTCRtpReceiver, keyBytes: ArrayBuffer): void {
  attach(receiver, "decrypt", keyBytes);
}
