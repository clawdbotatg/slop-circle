// Mutual peer authentication over a WebRTC data channel.
//
// Frame encryption already denies an unauthorized peer any media (it can't
// decrypt). This adds *presence integrity*: each peer proves to the other
// that it knows the room secret, so a relay-injected participant is
// detected and flagged rather than silently sitting in the room — and it
// gates the non-media data channels (chat, tx) that arrive in later phases.
//
// Handshake (symmetric, both sides): exchange fresh nonces, then exchange
// directional HMAC proofs over (senderId, senderNonce, peerNonce). The proof
// is keyed by authKey (derived from the fragment secret), so a peer without
// the secret can't produce it. Directionality (sender id + nonce order)
// stops an attacker from echoing our own proof back; fresh nonces stop
// replay of a proof captured from an earlier session.

const HANDSHAKE_TIMEOUT_MS = 8000;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

async function hmacHex(key: CryptoKey, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return toHex(sig);
}

export type PeerAuthResult = "verified" | "failed";

export function runPeerAuth(
  channel: RTCDataChannel,
  opts: { myId: string; peerId: string; authKey: ArrayBuffer },
  onResult: (r: PeerAuthResult) => void,
): void {
  const { myId, peerId, authKey } = opts;
  let myNonce = "";
  let peerNonce = "";
  let sentProof = false;
  let settled = false;

  const finish = (r: PeerAuthResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onResult(r);
  };
  const timer = setTimeout(() => finish("failed"), HANDSHAKE_TIMEOUT_MS);

  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = () => {
    keyPromise ??= crypto.subtle.importKey("raw", authKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return keyPromise;
  };

  const maybeSendProof = async () => {
    if (sentProof || !myNonce || !peerNonce) return;
    sentProof = true;
    const proof = await hmacHex(await getKey(), `${myId}|${myNonce}|${peerNonce}`);
    try {
      channel.send(JSON.stringify({ t: "proof", v: proof }));
    } catch {
      finish("failed");
    }
  };

  const start = () => {
    myNonce = randomNonce();
    try {
      channel.send(JSON.stringify({ t: "nonce", v: myNonce }));
    } catch {
      finish("failed");
    }
  };

  channel.onmessage = async ev => {
    let msg: { t?: string; v?: string };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.t === "nonce" && typeof msg.v === "string") {
      peerNonce = msg.v;
      void maybeSendProof();
    } else if (msg.t === "proof" && typeof msg.v === "string") {
      if (!myNonce || !peerNonce) return finish("failed");
      const expected = await hmacHex(await getKey(), `${peerId}|${peerNonce}|${myNonce}`);
      // Constant-ish compare; both are our own local hex strings.
      finish(msg.v.length === expected.length && msg.v === expected ? "verified" : "failed");
    }
  };
  channel.onclose = () => finish("failed");
  channel.onerror = () => finish("failed");

  if (channel.readyState === "open") start();
  else channel.onopen = start;
}
