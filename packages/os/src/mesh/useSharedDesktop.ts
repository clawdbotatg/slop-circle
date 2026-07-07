import { useCallback, useEffect, useRef, useState } from "react";
import { getBlob, putBlob } from "../blob";

// The SHARED desktop. Like slop.computer, a circle is a single computer every
// member sees identically: window geometry, z-order, and which apps are open
// are room-global. When anyone moves, resizes, opens, closes, minimizes, or
// focuses a window, everyone sees it.
//
// CONTRACT MATCHES slop.computer exactly (so a later swap onto its real code
// is mechanical, not a reconciliation): the `SlotPosition` shape, the
// `slots` / `openWindowIds` / `updateSlot` / `openWindow` / `closeWindow`
// surface, the `slot_update` / `window_open` / `window_close` message names,
// and minimize-encoded-as-height (a window with height <= TITLEBAR_HEIGHT is
// "docked"; there is no separate min flag) are all slop's. What differs is the
// TRANSPORT only: slop keeps this in a relay-side store; circle's relay must
// stay BLIND, so we sync over the encrypted bus (live) + blob (durable /
// late-join). That transport seam is what makes circle peer-authority.

export type SlotPosition = { id: string; x: number; y: number; width: number; height: number; z: number };

type Mesh = {
  sendRoomMessage: (o: unknown) => void;
  addRoomMessageListener: (fn: (from: string, obj: unknown) => void) => () => void;
};

type DesktopSnapshot = { slots: Record<string, SlotPosition>; open: string[] };

export function useSharedDesktop(slug: string, roomKey: ArrayBuffer, mesh: Mesh) {
  const { sendRoomMessage, addRoomMessageListener } = mesh;
  const [slots, setSlots] = useState<Record<string, SlotPosition>>({});
  const [openWindowIds, setOpenWindowIds] = useState<Set<string>>(new Set());
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const openRef = useRef(openWindowIds);
  openRef.current = openWindowIds;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void putBlob(slug, "desktop", { slots: slotsRef.current, open: [...openRef.current] } satisfies DesktopSnapshot, roomKey);
    }, 500);
  }, [slug, roomKey]);

  // Merge one slot locally (last-write-wins) — mirrors slop's incoming {slot}.
  const applySlot = useCallback((slot: SlotPosition) => {
    setSlots(prev => (prev[slot.id] === slot ? prev : { ...prev, [slot.id]: slot }));
  }, []);

  // Adopt full state we don't already have (newcomer catch-up) — mirrors slop's
  // `hello` bulk seed — without clobbering our own live layout.
  const fill = useCallback((snap: Partial<DesktopSnapshot>) => {
    if (snap.slots) {
      setSlots(prev => {
        const next = { ...prev };
        for (const [id, s] of Object.entries(snap.slots!)) if (!(id in next)) next[id] = s;
        return next;
      });
    }
    if (snap.open) setOpenWindowIds(prev => new Set([...prev, ...snap.open!]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getBlob<DesktopSnapshot>(slug, "desktop", roomKey).then(d => {
      if (d && !cancelled) fill(d);
    });
    const off = addRoomMessageListener((_from, obj) => {
      const m = obj as { type?: string; id?: string; slots?: Record<string, SlotPosition>; open?: string[] } & Partial<SlotPosition>;
      switch (m?.type) {
        case "slot_update": {
          if (typeof m.id !== "string") return;
          const e = slotsRef.current[m.id];
          applySlot({
            id: m.id,
            x: m.x ?? e?.x ?? 80,
            y: m.y ?? e?.y ?? 280,
            width: m.width ?? e?.width ?? 360,
            height: m.height ?? e?.height ?? 260,
            z: m.z ?? e?.z ?? 5,
          });
          return;
        }
        case "window_open":
          if (typeof m.id === "string") setOpenWindowIds(prev => (prev.has(m.id!) ? prev : new Set(prev).add(m.id!)));
          return;
        case "window_close":
          if (typeof m.id === "string")
            setOpenWindowIds(prev => {
              if (!prev.has(m.id!)) return prev;
              const next = new Set(prev);
              next.delete(m.id!);
              return next;
            });
          return;
        case "desktop_sync_req":
          sendRoomMessage({ type: "desktop_sync", slots: slotsRef.current, open: [...openRef.current] });
          return;
        case "desktop_sync":
          fill({ slots: m.slots, open: m.open });
          return;
      }
    });
    sendRoomMessage({ type: "desktop_sync_req" });
    return () => {
      cancelled = true;
      off();
    };
  }, [slug, roomKey, sendRoomMessage, addRoomMessageListener, applySlot, fill]);

  // slop's updateSlot: a patch that always carries id; a brand-new window is
  // forced to the front (z above every existing slot). Optimistic local merge
  // + broadcast.
  const updateSlot = useCallback(
    (patch: Partial<SlotPosition> & { id: string }) => {
      const cur = slotsRef.current[patch.id];
      const finalPatch: Partial<SlotPosition> & { id: string } = cur
        ? patch
        : { ...patch, z: Math.max(0, ...Object.values(slotsRef.current).map(s => s.z)) + 1 };
      const merged: SlotPosition = {
        id: finalPatch.id,
        x: finalPatch.x ?? cur?.x ?? 80,
        y: finalPatch.y ?? cur?.y ?? 280,
        width: finalPatch.width ?? cur?.width ?? 360,
        height: finalPatch.height ?? cur?.height ?? 260,
        z: finalPatch.z ?? cur?.z ?? 5,
      };
      setSlots(prev => ({ ...prev, [merged.id]: merged }));
      sendRoomMessage({ type: "slot_update", ...finalPatch });
      scheduleSave();
    },
    [sendRoomMessage, scheduleSave],
  );

  // Bump a slot to the front (shared z-order).
  const focus = useCallback(
    (slot: SlotPosition) => {
      const maxZ = Math.max(5, ...Object.values(slotsRef.current).map(s => s.z));
      if (slot.z === maxZ) return;
      updateSlot({ ...slot, z: maxZ + 1 });
    },
    [updateSlot],
  );

  const openWindow = useCallback(
    (id: string) => {
      setOpenWindowIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
      sendRoomMessage({ type: "window_open", id });
      scheduleSave();
    },
    [sendRoomMessage, scheduleSave],
  );

  const closeWindow = useCallback(
    (id: string) => {
      setOpenWindowIds(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      sendRoomMessage({ type: "window_close", id });
      scheduleSave();
    },
    [sendRoomMessage, scheduleSave],
  );

  return { slots, openWindowIds, updateSlot, focus, openWindow, closeWindow };
}
