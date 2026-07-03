import { keccak_256 } from "@noble/hashes/sha3";
import type { Hex } from "viem";

// Fork-native WebAuthn passkey identity — no server round-trip (unlike
// slop-computer-live, which verifies passkeys relay-side). Here a passkey is
// purely a client-side identity + on-chain multisig signer:
//
//   createPasskey(): navigator.credentials.create → parse the P-256 public
//     key → derive the address keccak256(qx‖qy)[-20:], the same formula the
//     Multisig uses for a passkey signer. Stored in localStorage keyed by
//     address.
//
// Signing the multisig exec hash (navigator.credentials.get → WalletSignature)
// lands with the propose/sign/execute step.

const RP_NAME = "circle";
const IDENTITY_PREFIX = "circle:passkey:identity:";

export type PasskeyIdentity = {
  address: Hex; // 0x-lowercased, keccak256(qx‖qy)[-20:]
  qx: Hex; // 0x-prefixed 32-byte hex
  qy: Hex;
  credentialIdBase64Url: string;
  credentialIdHash: Hex; // 0x-prefixed keccak256(rawCredentialId)
};

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const v of b) out += v.toString(16).padStart(2, "0");
  return out;
}

function base64UrlFromBytes(b: Uint8Array): string {
  let bin = "";
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// SPKI DER for an EC P-256 key ends in the 65-byte uncompressed point
// 0x04 ‖ X(32) ‖ Y(32). Scan for the 0x04 marker (preceded by the 0x00
// unused-bits byte of the BIT STRING).
function parseSpkiPublicKey(spki: Uint8Array): { qx: Uint8Array; qy: Uint8Array } {
  for (let i = 0; i + 65 <= spki.length; i++) {
    if (spki[i] !== 0x04) continue;
    if (i > 0 && spki[i - 1] !== 0x00) continue;
    return { qx: spki.slice(i + 1, i + 33), qy: spki.slice(i + 33, i + 65) };
  }
  throw new Error("spki-parse-failed");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** keccak256(qx‖qy)[-20:] — matches Multisig.getPasskeyAddress. */
export function passkeyAddressFromPubkey(qx: Uint8Array, qy: Uint8Array): Hex {
  return ("0x" + bytesToHex(keccak_256(concat(qx, qy)).slice(-20))) as Hex;
}

export async function createPasskey(): Promise<PasskeyIdentity> {
  if (typeof window === "undefined") throw new Error("no-window");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: RP_NAME, id: window.location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: "circle member",
        displayName: "circle member",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }], // ES256 (P-256)
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 60000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey-create-cancelled");

  const attestation = cred.response as AuthenticatorAttestationResponse;
  const spki = attestation.getPublicKey();
  if (!spki) throw new Error("no-public-key");
  const { qx, qy } = parseSpkiPublicKey(new Uint8Array(spki));
  const rawId = new Uint8Array(cred.rawId);

  const identity: PasskeyIdentity = {
    address: passkeyAddressFromPubkey(qx, qy),
    qx: ("0x" + bytesToHex(qx)) as Hex,
    qy: ("0x" + bytesToHex(qy)) as Hex,
    credentialIdBase64Url: base64UrlFromBytes(rawId),
    credentialIdHash: ("0x" + bytesToHex(keccak_256(rawId))) as Hex,
  };
  storePasskeyIdentity(identity);
  return identity;
}

export function storePasskeyIdentity(id: PasskeyIdentity): void {
  try {
    localStorage.setItem(IDENTITY_PREFIX + id.address.toLowerCase(), JSON.stringify(id));
    localStorage.setItem("circle:passkey:last", id.address.toLowerCase());
  } catch {
    /* private mode / disabled storage — identity is still usable this session */
  }
}

export function loadLastPasskeyIdentity(): PasskeyIdentity | null {
  try {
    const addr = localStorage.getItem("circle:passkey:last");
    if (!addr) return null;
    const raw = localStorage.getItem(IDENTITY_PREFIX + addr);
    return raw ? (JSON.parse(raw) as PasskeyIdentity) : null;
  } catch {
    return null;
  }
}
