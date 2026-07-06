import { useCallback, useEffect, useRef, useState } from "react";
import { getBlob, putBlob } from "@commons/os";
import type { AppServices } from "../os/appkit";

// The room's shared treasury (multisig) address — the one wallet the circle
// gathers around. Agreed by all members: announced over the encrypted bus
// (live) and persisted to the encrypted blob (durable + late-join), exactly
// like Notes. The relay only ever sees ciphertext.

type Mesh = AppServices["mesh"];

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export function useRoomWallet(slug: string, roomKey: ArrayBuffer, mesh: Mesh) {
  const { sendRoomMessage, addRoomMessageListener } = mesh;
  const [address, setAddressState] = useState("");
  const addrRef = useRef("");
  addrRef.current = address;

  useEffect(() => {
    let cancelled = false;
    const apply = (a: unknown) => {
      if (!cancelled && typeof a === "string" && isAddr(a)) setAddressState(a);
    };
    getBlob<{ address: string }>(slug, "room-wallet", roomKey).then(d => {
      if (d) apply(d.address);
    });
    const off = addRoomMessageListener((_from, obj) => {
      const m = obj as { t?: string; address?: string };
      if (m?.t === "room-wallet") apply(m.address);
      else if (m?.t === "room-wallet-sync-request" && addrRef.current) {
        sendRoomMessage({ t: "room-wallet", address: addrRef.current });
      }
    });
    sendRoomMessage({ t: "room-wallet-sync-request" });
    return () => {
      cancelled = true;
      off();
    };
  }, [slug, roomKey, sendRoomMessage, addRoomMessageListener]);

  // Set the treasury for the whole room (bus + durable blob).
  const setAddress = useCallback(
    (a: string) => {
      const addr = a.trim();
      setAddressState(addr);
      if (isAddr(addr)) {
        sendRoomMessage({ t: "room-wallet", address: addr });
        void putBlob(slug, "room-wallet", { address: addr }, roomKey);
      }
    },
    [slug, roomKey, sendRoomMessage],
  );

  return { address, setAddress };
}
