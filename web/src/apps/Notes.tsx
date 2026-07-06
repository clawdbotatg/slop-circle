import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { getBlob, putBlob } from "@commons/os";
import type { AppServices } from "../os/appkit";

// The peer-authority validation app. A shared room notepad:
//   • live edits merge over the encrypted bus via a CRDT (Yjs) — concurrent
//     edits from different members combine instead of clobbering
//   • durable via the encrypted blob store (survives everyone leaving)
//   • late-joiners load the blob, then a sync-request pulls any newer state
// There is ZERO notes logic on the relay — it only fans out ciphertext (opaque
// Yjs updates) and stores an opaque blob. The CRDT does conflict resolution on
// the peers, so two people typing at once both keep their edits.

// Yjs updates are binary; the bus carries JSON, so frame them as base64.
function toB64(u: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u.length; i += chunk) s += String.fromCharCode(...u.subarray(i, i + chunk));
  return btoa(s);
}
function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function Notes({ slug, roomKey, mesh }: AppServices) {
  // Stable across renders (useMesh returns them via useCallback) — safe as
  // effect deps so we subscribe once, not on every parent re-render.
  const { sendRoomMessage, addRoomMessageListener } = mesh;
  const [text, setText] = useState("");
  const [status, setStatus] = useState("loading…");

  // One CRDT document per mount.
  const docRef = useRef<Y.Doc | null>(null);
  if (!docRef.current) docRef.current = new Y.Doc();
  const doc = docRef.current;
  const ytext = doc.getText("notes");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Reflect the merged CRDT text into React on every change (local or remote).
    const observer = () => {
      if (!cancelled) setText(ytext.toString());
    };
    ytext.observe(observer);
    setText(ytext.toString());

    const scheduleSave = () => {
      setStatus("saving…");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void putBlob(slug, "notes-crdt", { u: toB64(Y.encodeStateAsUpdate(doc)) }, roomKey).then(() => {
          if (!cancelled) setStatus("synced");
        });
      }, 400);
    };

    // Broadcast only locally-originated updates; remote ones carry origin
    // "remote" so we don't echo them back into a loop.
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") sendRoomMessage({ t: "notes-update", u: toB64(update) });
      scheduleSave();
    };
    doc.on("update", onUpdate);

    // Durable load (works even if nobody else is here).
    getBlob<{ u: string }>(slug, "notes-crdt", roomKey).then(d => {
      if (d?.u) Y.applyUpdate(doc, fromB64(d.u), "remote");
      if (!cancelled) setStatus("synced");
    });

    const off = addRoomMessageListener((_from, obj) => {
      const m = obj as { t?: string; u?: string };
      if (m?.t === "notes-update" && typeof m.u === "string") {
        Y.applyUpdate(doc, fromB64(m.u), "remote"); // CRDT merge, not clobber
      } else if (m?.t === "notes-sync-request") {
        // Hand the newcomer our full state; Yjs merges it idempotently.
        sendRoomMessage({ t: "notes-update", u: toB64(Y.encodeStateAsUpdate(doc)) });
      }
    });

    // Ask whoever's here for their state (covers a not-yet-landed blob write).
    sendRoomMessage({ t: "notes-sync-request" });

    return () => {
      cancelled = true;
      off();
      doc.off("update", onUpdate);
      ytext.unobserve(observer);
    };
  }, [slug, roomKey, sendRoomMessage, addRoomMessageListener, doc, ytext]);

  // Translate a whole-textarea change into a minimal Y.Text delta (common
  // prefix + suffix) so an edit only touches the changed range — that's what
  // lets two members' concurrent edits at different spots both survive.
  const onEdit = (value: string) => {
    const old = ytext.toString();
    if (old === value) return;
    let start = 0;
    const min = Math.min(old.length, value.length);
    while (start < min && old[start] === value[start]) start++;
    let eo = old.length;
    let en = value.length;
    while (eo > start && en > start && old[eo - 1] === value[en - 1]) {
      eo--;
      en--;
    }
    doc.transact(() => {
      if (eo > start) ytext.delete(start, eo - start);
      if (en > start) ytext.insert(start, value.slice(start, en));
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <textarea
        value={text}
        onChange={e => onEdit(e.target.value)}
        placeholder="Shared room notes — everyone sees this, edits merge, and it persists."
        data-testid="notes-text"
        style={{
          flex: 1,
          resize: "none",
          border: "none",
          background: "rgba(0,0,0,0.4)",
          color: "var(--commons-text)",
          fontFamily: "var(--commons-font-mono)",
          fontSize: "0.9rem",
          padding: "0.6rem",
          outline: "none",
          boxShadow: "none",
        }}
      />
      <div style={{ padding: "0.3rem 0.6rem", fontSize: "0.7rem", color: "var(--commons-text-muted)", borderTop: "1px solid rgba(var(--commons-accent-rgb),0.25)" }}>
        {status} · CRDT-merged over the encrypted bus, stored blind
      </div>
    </div>
  );
}
