import { createWalletClient, custom, encodeFunctionData, type Abi, type Hex } from "viem";
import { MultisigAbi } from "./contracts";
import { sortSignatures } from "./multisig";
import { chainFor } from "./rpc";
import type { Proposal } from "./useSharedWallet";

// Broadcasting a met-threshold proposal — the one on-chain, state-changing
// step. Passkey-only members have no EOA to broadcast from, so per the trust
// ladder the pragmatic v1 path is "a member with a browser wallet + gas
// broadcasts for the group" (window.ethereum). A relay gas-facilitator is a
// later option. The signatures were all collected client-side; this just
// assembles execTransaction and sends it.

/** Assemble the execTransaction calldata for a proposal (chain-free — used
 *  by the broadcast and unit-tested for correctness). */
export function assembleExecCalldata(p: Proposal): Hex {
  const sigs = sortSignatures(p.sigs).map(s => ({ sigType: s.sigType, signer: s.signer, data: s.data }));
  return encodeFunctionData({
    abi: MultisigAbi as Abi,
    functionName: "execTransaction",
    args: [p.target, BigInt(p.value), p.data, BigInt(p.deadline), sigs],
  });
}

/** Broadcast via an injected browser wallet (MetaMask, etc.). The signer just
 *  pays gas — the multisig verifies the collected signatures on-chain. */
export async function broadcastViaBrowserWallet(p: Proposal): Promise<Hex> {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("no browser wallet found — install one, or use a member who has ETH for gas");
  const wallet = createWalletClient({ chain: chainFor(p.chainId), transport: custom(eth as never) });
  const [from] = await wallet.requestAddresses();
  return wallet.sendTransaction({ account: from, to: p.multisig, data: assembleExecCalldata(p), value: 0n });
}
