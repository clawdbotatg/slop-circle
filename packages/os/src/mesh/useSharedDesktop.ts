import { useCallback, useEffect, useRef, useState } from "react";
import { getBlob, putBlob } from "../blob";

// The SHARED desktop. Like slop.computer, a circle is a single computer every
// member sees identically: window geometry, z-order, open/closed, and
// minimize/maximize are room-global. When anyone moves, resizes, opens,
// closes, minimizes, or focuses a window, everyone sees it.
//
// slop keeps this in a relay-side store; circle's relay must stay BLIND, so we
// sync it over the encrypted bus (live) and persist to the encrypted blob
// (durable + late-join) — the same primitives Notes/Bank use. The relay only
// ever fans out ciphertext.

export type Slot = { x: number; y: number; w: number; h: number; z: number; min?: boolean; max?: boolean };

type Mesh = {
  sendRoomMessage: (o: unknown) => void;
  addRoomMessageListener: (fn: (from: string, obj: unknown) => void) => () => void;
};

type DesktopSnapshot = { slots: Record<string, Slot>; open: string[] };
type DesktopMsg =
  | { __ds: "slot"; id: string; slot: Slot }
  | { __ds: "open"; id: string }
  | { __ds: "close"; id: string }
  | { __ds: "sync-req" }
  | { __ds: "sync"; slots: Record<string, Slot>; open: string[] };

export function useSharedDesktop(slug: string, roomKey: ArrayBuffer, mesh: Mesh) {
  const { sendRoomMessage, addRoomMessageListener } = mesh;
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const openRef = useRef(open);
  openRef.current = open;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void putBlob(slug, "desktop", { slots: slotsRef.current, open: [...openRef.current] } satisfies DesktopSnapshot, roomKey);
    }, 500);
  }, [slug, roomKey]);

  // Adopt state we don't already have (newcomer catch-up) without clobbering
  // our own live layout — single live updates below are last-write-wins.
  const fill = useCallback((snap: Partial<DesktopSnapshot>) => {
    if (snap.slots) {
      setSlots(prev => {
        const next = { ...prev };
        for (const [id, s] of Object.entries(snap.slots!)) if (!(id in next)) next[id] = s;
        return next;
      });
    }
    if (snap.open) {
      setOpen(prev => {
        const next = new Set(prev);
        for (const id of snap.open!) next.add(id);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getBlob<DesktopSnapshot>(slug, "desktop", roomKey).then(d => {
      if (d && !cancelled) fill(d);
    });
    const off = addRoomMessageListener((_from, obj) => {
      const m = obj as DesktopMsg;
      if (!m || typeof (m as { __ds?: string }).__ds !== "string") return;
      if (m.__ds === "slot") {
        setSlots(prev => (prev[m.id] === m.slot ? prev : { ...prev, [m.id]: m.slot }));
      } else if (m.__ds === "open") {
        setOpen(prev => (prev.has(m.id) ? prev : new Set(prev).add(m.id)));
      } else if (m.__ds === "close") {
        setOpen(prev => {
          if (!prev.has(m.id)) return prev;
          const next = new Set(prev);
          next.delete(m.id);
          return next;
        });
      } else if (m.__ds === "sync-req") {
        sendRoomMessage({ __ds: "sync", slots: slotsRef.current, open: [...openRef.current] } satisfies DesktopMsg);
      } else if (m.__ds === "sync") {
        fill({ slots: m.slots, open: m.open });
      }
    });
    // Ask whoever's here for the current desktop.
    sendRoomMessage({ __ds: "sync-req" } satisfies DesktopMsg);
    return () => {
      cancelled = true;
      off();
    };
  }, [slug, roomKey, sendRoomMessage, addRoomMessageListener, fill]);

  // Merge a patch into a slot and broadcast it (last-write-wins across peers).
  const updateSlot = useCallback(
    (id: string, patch: Partial<Slot>, fallback: Slot) => {
      setSlots(prev => {
        const cur = prev[id] ?? fallback;
        const merged = { ...cur, ...patch };
        sendRoomMessage({ __ds: "slot", id, slot: merged } satisfies DesktopMsg);
        return { ...prev, [id]: merged };
      });
      scheduleSave();
    },
    [sendRoomMessage, scheduleSave],
  );

  // Bump a window to the front (shared z-order).
  const focus = useCallback(
    (id: string, fallback: Slot) => {
      const maxZ = Math.max(5, ...Object.values(slotsRef.current).map(s => s.z));
      if ((slotsRef.current[id]?.z ?? 0) === maxZ) return;
      updateSlot(id, { z: maxZ + 1 }, fallback);
    },
    [updateSlot],
  );

  const openWindow = useCallback(
    (id: string) => {
      setOpen(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
      sendRoomMessage({ __ds: "open", id } satisfies DesktopMsg);
      scheduleSave();
    },
    [sendRoomMessage, scheduleSave],
  );

  const closeWindow = useCallback(
    (id: string) => {
      setOpen(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      sendRoomMessage({ __ds: "close", id } satisfies DesktopMsg);
      scheduleSave();
    },
    [sendRoomMessage, scheduleSave],
  );

  return { slots, open, updateSlot, focus, openWindow, closeWindow };
}
