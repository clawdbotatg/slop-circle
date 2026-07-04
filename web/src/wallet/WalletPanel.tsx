import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { createPasskey, loadLastPasskeyIdentity, signExecHashWithPasskey, type PasskeyIdentity } from "./passkey";
import { keccak256, parseEther, stringToBytes, type Hex } from "viem";
import { useSharedWallet } from "./useSharedWallet";
import { broadcastViaBrowserWallet } from "./execute";
import type { AppServices } from "../os/appkit";
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

// The Wallet window-app: passkey identity + personal wallet + shared multisig
// (propose / co-sign / execute). Rendered inside an OS-managed Window.
export function WalletPanel({ mesh }: AppServices) {
  const [identity, setIdentity] = useState<PasskeyIdentity | null>(() => loadLastPasskeyIdentity());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [rpc, setRpc] = useState(getRpcUrl());
  const [chain, setChain] = useState(getChainId());
  const [deployer, setDep] = useState<string>(getDeployer());

  const [personalAddr, setPersonalAddr] = useState<Address | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [derivErr, setDerivErr] = useState("");

  const [signTest, setSignTest] = useState<"idle" | "signing" | "ok" | "fail">("idle");
  const testSigner = useCallback(async () => {
    if (!identity) return;
    setSignTest("signing");
    try {
      // Sign a throwaway exec hash and let signExecHashWithPasskey verify the
      // P-256 signature against our own key. Proves the passkey can sign.
      const execHash = keccak256(stringToBytes("circle-signer-selftest:" + Date.now())) as Hex;
      await signExecHashWithPasskey({
        credentialIdBase64Url: identity.credentialIdBase64Url,
        execHash,
        qx: identity.qx,
        qy: identity.qy,
      });
      setSignTest("ok");
    } catch {
      setSignTest("fail");
    }
  }, [identity]);

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

  // --- shared circle wallet (propose + co-sign over the room bus) ---
  const shared = useSharedWallet(mesh, identity);
  const [roomWallet, setRoomWallet] = useState("");
  const [threshold, setThreshold] = useState(2);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [proposeErr, setProposeErr] = useState("");
  const [execState, setExecState] = useState<Record<string, string>>({});
  const doExecute = async (id: string) => {
    const p = shared.proposals.find(x => x.id === id);
    if (!p) return;
    setExecState(s => ({ ...s, [id]: "broadcasting…" }));
    try {
      const hash = await broadcastViaBrowserWallet(p);
      setExecState(s => ({ ...s, [id]: `sent: ${hash.slice(0, 12)}…` }));
    } catch (e) {
      setExecState(s => ({ ...s, [id]: (e as Error).message }));
    }
  };
  const doPropose = () => {
    setProposeErr("");
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(roomWallet)) throw new Error("enter the room wallet (multisig) address");
      if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error("enter a valid recipient address");
      shared.propose({
        multisig: roomWallet as Address,
        target: target as Address,
        value: parseEther(amount || "0"),
        threshold,
        chainId: chain,
        memo: `send ${amount || "0"} to ${target.slice(0, 8)}…`,
      });
    } catch (e) {
      setProposeErr((e as Error).message);
    }
  };

  return (
    <div className="wallet-body">
      <div>
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
            <button onClick={() => void testSigner()} disabled={signTest === "signing"}>
              {signTest === "signing" ? "Signing…" : "Test signer"}
            </button>
            {signTest === "ok" && <p className="wallet-signer-ok">signature valid ✓</p>}
            {signTest === "fail" && <p className="err">signer test failed</p>}

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

        {identity && (
          <div className="wallet-section">
            <label>Shared circle wallet — propose &amp; co-sign</label>
            <input value={roomWallet} onChange={e => setRoomWallet(e.target.value)} placeholder="room wallet (multisig) address 0x…" />
            <div className="wallet-row">
              <input value={target} onChange={e => setTarget(e.target.value)} placeholder="send to 0x…" />
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="amount"
                style={{ width: "6rem" }}
              />
            </div>
            <div className="wallet-row">
              <label style={{ alignSelf: "center" }}>threshold</label>
              <input
                type="number"
                min={1}
                value={threshold}
                onChange={e => setThreshold(Math.max(1, Number(e.target.value)))}
                style={{ width: "4rem" }}
              />
              <button onClick={doPropose} data-testid="propose">
                Propose
              </button>
            </div>
            {proposeErr && <p className="err">{proposeErr}</p>}

            {shared.proposals.map(p => {
              const met = p.sigs.length >= p.threshold;
              return (
                <div key={p.id} className={met ? "proposal ready" : "proposal"} data-testid="proposal">
                  <div className="proposal-memo">{p.memo || `${p.value} wei → ${p.target.slice(0, 10)}…`}</div>
                  <div className="proposal-status" data-testid="sigcount">
                    {p.sigs.length} / {p.threshold} signed{" "}
                    {met ? <b className="wallet-signer-ok">— ready to execute ✓</b> : null}
                  </div>
                  {!met ? (
                    <button onClick={() => void shared.sign(p.id)} data-testid={`sign-${p.id}`}>
                      Sign
                    </button>
                  ) : (
                    <button onClick={() => void doExecute(p.id)} data-testid={`exec-${p.id}`}>
                      Execute (broadcast)
                    </button>
                  )}
                  {execState[p.id] && <div className="proposal-status">{execState[p.id]}</div>}
                </div>
              );
            })}
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
