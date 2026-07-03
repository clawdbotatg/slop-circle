import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { encodeAbiParameters, type Hex } from "viem";
import { passkeyAddressFromCoords } from "./multisig";
import type { WalletSignature } from "./contracts";

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

function bytesFromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex-odd-length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function bigintTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// DER ECDSA signature: 0x30 LL  0x02 RL <r>  0x02 SL <s>. r/s may carry a
// leading 0x00 pad when their high bit is set.
function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error("der-not-sequence");
  let i = 2;
  if (der[i] !== 0x02) throw new Error("der-no-r-int");
  const rLen = der[i + 1]!;
  const r = bytesToBigInt(der.slice(i + 2, i + 2 + rLen));
  i += 2 + rLen;
  if (der[i] !== 0x02) throw new Error("der-no-s-int");
  const sLen = der[i + 1]!;
  const s = bytesToBigInt(der.slice(i + 2, i + 2 + sLen));
  return { r, s };
}

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

// Sign a multisig exec hash with a passkey and return the Passkey
// WalletSignature the contract expects. Before returning, we cryptographically
// self-verify the P-256 signature against our own public key over the WebAuthn
// signed message (sha256(authenticatorData ‖ sha256(clientDataJSON))) — a
// wrong/foreign credential or a mangled signature is caught here, chain-free.
export async function signExecHashWithPasskey(args: {
  credentialIdBase64Url: string;
  execHash: Hex;
  qx: Hex;
  qy: Hex;
}): Promise<WalletSignature> {
  if (typeof window === "undefined") throw new Error("no-window");
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(args.execHash) as BufferSource,
      rpId: window.location.hostname,
      userVerification: "required",
      allowCredentials: [
        {
          id: bytesFromBase64Url(args.credentialIdBase64Url) as BufferSource,
          type: "public-key",
          transports: ["internal", "hybrid"],
        },
      ],
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey-sign-cancelled");

  const a = cred.response as AuthenticatorAssertionResponse;
  const der = parseDerSignature(new Uint8Array(a.signature));
  // The contract (OZ WebAuthn.verify) rejects high-S; normalize to low-S.
  const sLow = der.s > P256_N / 2n ? P256_N - der.s : der.s;
  const authenticatorData = new Uint8Array(a.authenticatorData);
  const clientDataJSON = new Uint8Array(a.clientDataJSON);
  const clientDataText = new TextDecoder().decode(clientDataJSON);

  // Self-verify: recompute the WebAuthn signed message and check the P-256
  // signature against our public key. Reject anything that doesn't verify.
  const msgHash = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  const pub = new Uint8Array([0x04, ...hexToBytes(args.qx), ...hexToBytes(args.qy)]);
  const compact = new Uint8Array([...bigintTo32(der.r), ...bigintTo32(sLow)]);
  if (!p256.verify(compact, msgHash, pub)) {
    throw new Error("passkey-signature-self-verify-failed");
  }

  const challengeIndex = clientDataText.indexOf('"challenge"');
  const typeIndex = clientDataText.indexOf('"type"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("passkey-clientdata-missing-fields");

  // Passkey WalletSignature.data = abi.encode(qx, qy, WebAuthnAuth{r, s,
  // challengeIndex, typeIndex, authenticatorData, clientDataJSON}).
  const data = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      {
        type: "tuple",
        components: [
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
        ],
      },
    ],
    [
      args.qx,
      args.qy,
      {
        r: ("0x" + bytesToHex(bigintTo32(der.r))) as Hex,
        s: ("0x" + bytesToHex(bigintTo32(sLow))) as Hex,
        challengeIndex: BigInt(challengeIndex),
        typeIndex: BigInt(typeIndex),
        authenticatorData: ("0x" + bytesToHex(authenticatorData)) as Hex,
        clientDataJSON: clientDataText,
      },
    ],
  ) as Hex;

  return { sigType: 1, signer: passkeyAddressFromCoords(args.qx, args.qy), data };
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
