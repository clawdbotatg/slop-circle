import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { FACTORY_ADDRESS, MultisigFactoryAbi, type WalletSignature } from "./contracts";

// Vendored from slop-computer-live. Pure client-side helpers for the slop
// Multisig — CREATE2 address derivation, the off-chain exec hash, signature
// ordering, and the personal-wallet (1-of-2) derivation.

/** CREATE2 salt from a label. Two labels → two multisigs from one deployer. */
export function saltFromLabel(label: string): Hex {
  return keccak256(stringToBytes(label));
}

// Off-chain exec hash. Must match `Multisig.getExecHash` exactly:
//   keccak256(abi.encode(chainId, multisig, nonce, deadline, target, value, keccak256(data)))
export function computeExecHash(args: {
  chainId: number;
  multisig: Address;
  nonce: bigint;
  deadline: bigint;
  target: Address;
  value: bigint;
  data: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, address, uint256, uint256, address, uint256, bytes32"), [
      BigInt(args.chainId),
      args.multisig,
      args.nonce,
      args.deadline,
      args.target,
      args.value,
      keccak256(args.data),
    ]),
  );
}

// execTransaction rejects out-of-order (or duplicate) signer arrays as
// `SignersUnsorted`. Sort ascending by signer address.
export function sortSignatures(sigs: WalletSignature[]): WalletSignature[] {
  return [...sigs].sort((a, b) => (a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1));
}

// EOA signature wrapper. The contract applies the `\x19Ethereum Signed
// Message:\n32` prefix internally, so personal_sign over the raw execHash
// bytes is what we want (viem's `{ raw: execHash }`).
export function wrapEoaSignature(signer: Address, sig: Hex): WalletSignature {
  return { sigType: 0, signer, data: sig };
}

// Passkey signer address: keccak256(qx‖qy)[-20:], matching
// `Multisig.getPasskeyAddress(qx, qy)`.
export function passkeyAddressFromCoords(qx: Hex, qy: Hex): Address {
  return (`0x` + keccak256((qx + qy.slice(2)) as Hex).slice(-40)) as Address;
}

export const DEFAULT_TX_DEADLINE_SECONDS = 7 * 24 * 60 * 60;
export function defaultDeadline(nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  return BigInt(nowSeconds + DEFAULT_TX_DEADLINE_SECONDS);
}

// ---- personal wallet (single-player, 1-of-2 [passkey, mainMultisig]) -------
//
// A passkey user's spendable address is NOT the raw passkey address (P-256,
// unspendable — funds sent there burn). It's a slop Multisig deployed
// counterfactually at `getMultisigAddress(deployer, salt)`. The factory bakes
// the DEPLOYER into the CREATE2 address, so one fixed deployer must broadcast
// every personal wallet's deploy. The salt commits to the passkey, so the
// same passkey always lands on the same wallet with no server state.

export const PERSONAL_WALLET_SALT_PREFIX = "circle-personal-v1:";

export function personalWalletSalt(passkeyAddress: Address): Hex {
  return saltFromLabel(PERSONAL_WALLET_SALT_PREFIX + passkeyAddress.toLowerCase());
}

/** createMultisig args for a passkey's 1-of-2 personal wallet. Not needed to
 *  derive the address (deployer+salt only) — used at deploy time. */
export function personalWalletCreateArgs(args: {
  passkey: { qx: Hex; qy: Hex; credentialIdHash: Hex };
  mainMultisig: Address;
}): {
  accounts: Address[];
  passkeyQxs: Hex[];
  passkeyQys: Hex[];
  credentialIdHashes: Hex[];
  threshold: bigint;
  salt: Hex;
} {
  const passkeyAddress = passkeyAddressFromCoords(args.passkey.qx, args.passkey.qy);
  return {
    accounts: [args.mainMultisig],
    passkeyQxs: [args.passkey.qx],
    passkeyQys: [args.passkey.qy],
    credentialIdHashes: [args.passkey.credentialIdHash],
    threshold: 1n,
    salt: personalWalletSalt(passkeyAddress),
  };
}

/** Read the counterfactual personal-wallet address from the factory. Works
 *  before deploy (funding-before-deploy). Throws if the deployer is unset. */
export async function predictPersonalWalletAddress(args: {
  client: PublicClient;
  passkeyAddress: Address;
  deployer: Address;
}): Promise<Address> {
  if (/^0x0+$/i.test(args.deployer)) {
    throw new Error("deployer unset — refusing to derive against the zero address");
  }
  return (await args.client.readContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: [args.deployer, personalWalletSalt(args.passkeyAddress)],
  })) as Address;
}
