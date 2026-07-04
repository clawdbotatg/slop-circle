import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";

// Configurable RPC — the sovereign default is a member's own Ethereum node.
// The instance points wherever the user sets it; a public endpoint is only a
// bootstrap convenience (see PLAN.md §5.3 RPC ladder). Nothing is hardcoded to
// a single provider.

const CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [optimism.id]: optimism,
  [arbitrum.id]: arbitrum,
  [polygon.id]: polygon,
  [gnosis.id]: gnosis,
};

const RPC_KEY = "circle:rpc-url";
const CHAIN_KEY = "circle:chain-id";
const DEPLOYER_KEY = "circle:deployer";

export function getChainId(): number {
  const v = Number(localStorage.getItem(CHAIN_KEY) ?? "");
  return CHAINS[v] ? v : mainnet.id;
}

export function setChainId(id: number): void {
  localStorage.setItem(CHAIN_KEY, String(id));
}

/** The configured RPC URL, or "" to use viem's default public endpoint for
 *  the chain (bootstrap only — a real circle points this at its own node). */
export function getRpcUrl(): string {
  return localStorage.getItem(RPC_KEY) ?? "";
}

export function setRpcUrl(url: string): void {
  if (url) localStorage.setItem(RPC_KEY, url);
  else localStorage.removeItem(RPC_KEY);
}

/** The fixed deployer baked into every personal-wallet CREATE2 address. Must
 *  match the facilitator that will broadcast the deploy. Configurable; unset
 *  → derivation is disabled (we never derive against the zero address). */
export function getDeployer(): Address {
  return (localStorage.getItem(DEPLOYER_KEY) ?? "0x0000000000000000000000000000000000000000") as Address;
}

export function setDeployer(addr: string): void {
  localStorage.setItem(DEPLOYER_KEY, addr);
}

export function chainName(id = getChainId()): string {
  return CHAINS[id]?.name ?? `chain ${id}`;
}

export function chainFor(id: number): Chain {
  return CHAINS[id] ?? mainnet;
}

export function makePublicClient(): PublicClient {
  const url = getRpcUrl();
  return createPublicClient({ chain: chainFor(getChainId()), transport: http(url || undefined) });
}
