import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { createPasskey, loadLastPasskeyIdentity, type PasskeyIdentity } from "./passkey";
import { predictPersonalWalletAddress } from "./multisig";
import {
  chainName,
  getChainId,
  getDeployer,
  getRpcUrl,
  makePublicClient,
  setChainId,
  setDeployer,
  setRpcUrl,
} from "./rpc";

// The personal wallet: a passkey member's spendable address, before any
// wallet software. Phase 2 foundation — identity + counterfactual address +
// balance (the "receives" half). Propose/sign/execute lands next.

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletPanel({ onClose }: { onClose: () => void }) {
  const [identity, setIdentity] = useState<PasskeyIdentity | null>(() => loadLastPasskeyIdentity());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [rpc, setRpc] = useState(getRpcUrl());
  const [chain, setChain] = useState(getChainId());
  const [deployer, setDep] = useState<string>(getDeployer());

  const [personalAddr, setPersonalAddr] = useState<Address | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [derivErr, setDerivErr] = useState("");

  const create = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      setIdentity(await createPasskey());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // Derive the counterfactual personal-wallet address + balance when we have
  // an identity and a deployer. Best-effort: needs a reachable RPC.
  useEffect(() => {
    let cancelled = false;
    setPersonalAddr(null);
    setBalance(null);
    setDerivErr("");
    if (!identity) return;
    if (/^0x0+$/i.test(deployer)) {
      setDerivErr("Set a deployer address to derive your personal wallet.");
      return;
    }
    (async () => {
      try {
        const client = makePublicClient();
        const addr = await predictPersonalWalletAddress({
          client,
          passkeyAddress: identity.address,
          deployer: deployer as Address,
        });
        if (cancelled) return;
        setPersonalAddr(addr);
        const bal = await client.getBalance({ address: addr });
        if (!cancelled) setBalance(formatEther(bal));
      } catch (e) {
        if (!cancelled) setDerivErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, deployer, chain, rpc]);

  const saveSettings = () => {
    setRpcUrl(rpc.trim());
    setChainId(chain);
    setDeployer(deployer.trim());
  };

  return (
    <div className="wallet-overlay" onClick={onClose}>
      <div className="wallet-panel" onClick={e => e.stopPropagation()}>
        <div className="wallet-head">
          <h2>Wallet</h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {!identity ? (
          <div className="wallet-section">
            <p className="dim">
              A passkey is your identity and your signer — no wallet software, no seed phrase. Face ID / Touch ID
              creates it.
            </p>
            <button onClick={() => void create()} disabled={busy}>
              {busy ? "Creating…" : "Create passkey identity"}
            </button>
            {err && <p className="err">{err}</p>}
          </div>
        ) : (
          <div className="wallet-section">
            <label>Passkey identity (signer)</label>
            <code className="wallet-addr" title={identity.address}>
              {identity.address}
            </code>
            <p className="dim">
              This is an on-chain multisig <b>signer</b>, not a place to receive funds (a raw passkey address is
              unspendable). Your spendable address is the personal wallet below.
            </p>

            <label>Personal wallet (receive here)</label>
            {personalAddr ? (
              <>
                <code className="wallet-addr" title={personalAddr}>
                  {personalAddr}
                </code>
                <p className="wallet-balance">{balance !== null ? `${balance} (native)` : "reading balance…"}</p>
              </>
            ) : (
              <p className="dim">{derivErr || "deriving…"}</p>
            )}
          </div>
        )}

        <details className="wallet-section">
          <summary>Network settings</summary>
          <label>Chain</label>
          <select value={chain} onChange={e => setChain(Number(e.target.value))}>
            {[1, 8453, 10, 42161, 137, 100].map(id => (
              <option key={id} value={id}>
                {chainName(id)}
              </option>
            ))}
          </select>
          <label>RPC URL (blank = public default — point at your own node)</label>
          <input value={rpc} onChange={e => setRpc(e.target.value)} placeholder="http://localhost:8545" />
          <label>Personal-wallet deployer</label>
          <input value={deployer} onChange={e => setDep(e.target.value)} placeholder="0x…" />
          <button onClick={saveSettings}>Save network settings</button>
        </details>
      </div>
    </div>
  );
}
