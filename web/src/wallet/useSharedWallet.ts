import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { WalletSignature } from "./contracts";
import { computeExecHash, defaultDeadline, sortSignatures } from "./multisig";
import { signExecHashWithPasskey, type PasskeyIdentity } from "./passkey";

// The shared circle wallet: members propose a transaction from the room's
// multisig and co-sign it over the encrypted room bus until the threshold is
// met. Everything here is chain-independent — the exec hash and signatures
// are computed and collected client-side. Only the final execTransaction
// broadcast (deferred) needs a funded key / a chain.
//
// A proposal carries every field the exec hash binds to, so a signer never
// needs its own chain read: it recomputes the same hash from the proposer's
// fields and signs that.

export type Proposal = {
  id: string;
  chainId: number;
  multisig: Address;
  nonce: string; // stringified bigint (0 for a counterfactual first tx)
  deadline: string; // stringified bigint
  target: Address;
  value: string; // stringified bigint (wei)
  data: Hex;
  threshold: number;
  proposer: string;
  memo: string;
  sigs: WalletSignature[];
};

type BusMessage =
  | { t: "propose"; proposal: Omit<Proposal, "sigs"> }
  | { t: "sig"; id: string; sig: WalletSignature }
  | { t: "sync-request" }
  | { t: "sync"; proposals: Proposal[] };

type Mesh = {
  sendRoomMessage: (obj: unknown) => void;
  addRoomMessageListener: (fn: (from: string, obj: unknown) => void) => () => void;
};

function execHashOf(p: Pick<Proposal, "chainId" | "multisig" | "nonce" | "deadline" | "target" | "value" | "data">): Hex {
  return computeExecHash({
    chainId: p.chainId,
    multisig: p.multisig,
    nonce: BigInt(p.nonce),
    deadline: BigInt(p.deadline),
    target: p.target,
    value: BigInt(p.value),
    data: p.data,
  });
}

function addSig(sigs: WalletSignature[], sig: WalletSignature): WalletSignature[] {
  if (sigs.some(s => s.signer.toLowerCase() === sig.signer.toLowerCase())) return sigs; // dedupe by signer
  return sortSignatures([...sigs, sig]);
}

export function useSharedWallet(mesh: Mesh, identity: PasskeyIdentity | null) {
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;

  const upsertProposal = useCallback((p: Proposal) => {
    setProposals(prev => {
      const existing = prev[p.id];
      if (!existing) return { ...prev, [p.id]: p };
      // Merge signatures from both sides.
      let merged = existing.sigs;
      for (const s of p.sigs) merged = addSig(merged, s);
      return { ...prev, [p.id]: { ...existing, sigs: merged } };
    });
  }, []);

  useEffect(() => {
    const off = mesh.addRoomMessageListener((_from, obj) => {
      const msg = obj as BusMessage;
      if (msg?.t === "propose") {
        upsertProposal({ ...msg.proposal, sigs: [] });
      } else if (msg?.t === "sig") {
        setProposals(prev => {
          const p = prev[msg.id];
          if (!p) return prev;
          return { ...prev, [msg.id]: { ...p, sigs: addSig(p.sigs, msg.sig) } };
        });
      } else if (msg?.t === "sync-request") {
        // A newcomer asked for state — reply with everything we have.
        const all = Object.values(proposalsRef.current);
        if (all.length) mesh.sendRoomMessage({ t: "sync", proposals: all } satisfies BusMessage);
      } else if (msg?.t === "sync") {
        for (const p of msg.proposals) upsertProposal(p);
      }
    });
    // Ask existing members for any in-flight proposals.
    mesh.sendRoomMessage({ t: "sync-request" } satisfies BusMessage);
    return off;
  }, [mesh, upsertProposal]);

  const propose = useCallback(
    (args: { multisig: Address; target: Address; value: bigint; data?: Hex; threshold: number; nonce?: bigint; chainId: number; memo?: string }) => {
      const base: Omit<Proposal, "sigs"> = {
        id: crypto.randomUUID(),
        chainId: args.chainId,
        multisig: args.multisig,
        nonce: (args.nonce ?? 0n).toString(),
        deadline: defaultDeadline().toString(),
        target: args.target,
        value: args.value.toString(),
        data: args.data ?? "0x",
        threshold: args.threshold,
        proposer: identity?.address ?? "anon",
        memo: args.memo ?? "",
      };
      upsertProposal({ ...base, sigs: [] });
      mesh.sendRoomMessage({ t: "propose", proposal: base } satisfies BusMessage);
      return base.id;
    },
    [mesh, identity, upsertProposal],
  );

  const sign = useCallback(
    async (id: string) => {
      if (!identity) throw new Error("no passkey identity");
      const p = proposalsRef.current[id];
      if (!p) throw new Error("no such proposal");
      const execHash = execHashOf(p);
      const sig = await signExecHashWithPasskey({
        credentialIdBase64Url: identity.credentialIdBase64Url,
        execHash,
        qx: identity.qx,
        qy: identity.qy,
      });
      setProposals(prev => {
        const cur = prev[id];
        return cur ? { ...prev, [id]: { ...cur, sigs: addSig(cur.sigs, sig) } } : prev;
      });
      mesh.sendRoomMessage({ t: "sig", id, sig } satisfies BusMessage);
    },
    [mesh, identity],
  );

  return { proposals: Object.values(proposals), propose, sign };
}
