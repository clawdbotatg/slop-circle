import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import type { AppServices } from "../os/appkit";
import { useRoomWallet } from "../wallet/useRoomWallet";
import { useSharedWallet } from "../wallet/useSharedWallet";
import { loadLastPasskeyIdentity } from "../wallet/passkey";
import { chainName, getChainId, makePublicClient } from "../wallet/rpc";

// Bank — the room's treasury dashboard. A distinct lens from Wallet (which is
// identity + signing): Bank shows the ONE shared multisig the circle gathers
// around — its address (to receive), its live on-chain balance, and the
// room's proposal activity. The treasury address is shared over the bus +
// blob (see useRoomWallet), so every member sees the same one.

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Bank({ slug, roomKey, mesh }: AppServices) {
  const { address, setAddress } = useRoomWallet(slug, roomKey, mesh);
  const shared = useSharedWallet(mesh, loadLastPasskeyIdentity());
  const [balance, setBalance] = useState<string | null>(null);
  const [balErr, setBalErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(() => {
    setBalErr("");
    setBalance(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    (async () => {
      try {
        const bal = await makePublicClient().getBalance({ address: address as Address });
        setBalance(formatEther(bal));
      } catch (e) {
        setBalErr((e as Error).message);
      }
    })();
  }, [address]);
  useEffect(refresh, [refresh]);

  const copy = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const commit = () => {
    setAddress(draft);
    setEditing(false);
    setDraft("");
  };

  return (
    <div className="wallet-body">
      <div>
        <div className="wallet-section">
          <label>Room treasury (shared multisig)</label>
          {address && !editing ? (
            <>
              <code className="wallet-addr" title={address} data-testid="bank-addr">
                {address}
              </code>
              <p className="wallet-balance">
                {balance !== null ? `${balance} (native)` : balErr ? "— set an RPC in Wallet → Network settings" : "reading balance…"}
              </p>
              <p className="dim">on {chainName(getChainId())} · send funds here to fund the circle</p>
              <div className="wallet-row">
                <button onClick={copy}>{copied ? "Copied ✓" : "Copy address"}</button>
                <button onClick={refresh}>Refresh</button>
                <button className="ghost" onClick={() => setEditing(true)}>
                  Change
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="dim">
                {address ? "Change the room treasury address — everyone will see the update." : "No treasury set yet. Paste the room's multisig address — everyone in the room will see it."}
              </p>
              <div className="wallet-row">
                <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="0x… multisig address" data-testid="bank-addr-input" />
                <button onClick={commit} data-testid="bank-set-addr">
                  Set
                </button>
                {address && (
                  <button className="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="wallet-section">
          <label>Activity ({shared.proposals.length})</label>
          {shared.proposals.length === 0 ? (
            <p className="dim">No proposals yet. Open Wallet to propose a spend from the treasury.</p>
          ) : (
            shared.proposals.map(p => {
              const met = p.sigs.length >= p.threshold;
              return (
                <div key={p.id} className={met ? "proposal ready" : "proposal"}>
                  <div className="proposal-memo">{p.memo || `${p.value} wei → ${short(p.target)}`}</div>
                  <div className="proposal-status">
                    {p.sigs.length}/{p.threshold} signed {met ? "— ready to execute ✓" : ""}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
