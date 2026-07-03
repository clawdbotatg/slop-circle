import MultisigJson from "./Multisig.json";
import MultisigFactoryJson from "./MultisigFactory.json";

// Vendored from slop-computer-live (the slop Multisig v4). Passkey-native:
// P-256/WebAuthn signers are verified on-chain via the EIP-7951 P256VERIFY
// precompile (0x100) — cheap on mainnet post-Fusaka. The factory + impl are
// immutable and live at the SAME CREATE2 address on Base (8453), Ethereum
// (1), Optimism (10), Arbitrum (42161), Polygon (137), Gnosis (100).
//
// A fork should vendor the contract SOURCE (the separate slop-computer-
// contracts Foundry repo) before an audit; here we carry only the ABIs +
// addresses, which is all the client needs.

export const MultisigAbi = MultisigJson as readonly unknown[];
export const MultisigFactoryAbi = MultisigFactoryJson as readonly unknown[];

export const FACTORY_ADDRESS = "0xfcdEe21865b60C2700C23Cd946316CEdA0F215B5" as const;
export const MULTISIG_IMPL_ADDRESS = "0x5Be7f750Cc271DBf0C6027a45bFe78b99504CE3A" as const;

// On-chain Signature.sigType: 0 = Account (EOA / 7702 / Safe / nested
// Multisig / any ERC-1271), 1 = Passkey (P-256/WebAuthn).
export const SIGNER_TYPE = { Account: 0, Passkey: 1 } as const;
export type SignerType = (typeof SIGNER_TYPE)[keyof typeof SIGNER_TYPE];

export type WalletSignature = {
  sigType: SignerType;
  signer: `0x${string}`;
  data: `0x${string}`;
};
