import { useEffect, useRef, useState } from "react";
import { getBlob, putBlob } from "../blob";

// The peer-authority validation app. A shared room notepad:
//   • live edits broadcast over the encrypted bus (everyone sees your typing)
//   • durable via the encrypted blob store (survives everyone leaving)
//   • late-joiners load the blob, then follow the bus
// There is ZERO notes logic on the relay — it only fans out ciphertext and
// stores an opaque blob. Conflict resolution is last-write-wins by timestamp
// (a CRDT is the upgrade for true concurrent-character editing).

type Mesh = {
  sendRoomMessage: (obj: unknown) => void;
  addRoomMessageListener: (fn: (from: string, obj: unknown) => void) => () => void;
};

type NotesDoc = { text: string; updatedAt: number };

export function Notes({ slug, roomKey, mesh }: { slug: string; roomKey: ArrayBuffer; mesh: Mesh }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("loading…");
  const updatedAtRef = useRef(0);
  const textRef = useRef("");
  textRef.current = text;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load current state two ways, whichever answers: the durable blob (works
  // even if nobody else is here) AND a bus sync-request (any present peer
  // re-broadcasts its doc — instant, and covers the case where the blob write
  // hasn't landed yet). Then follow live edits.
  useEffect(() => {
    let cancelled = false;

    const apply = (doc: Partial<NotesDoc>) => {
      if (cancelled) return;
      if (typeof doc.text === "string" && typeof doc.updatedAt === "number" && doc.updatedAt > updatedAtRef.current) {
        updatedAtRef.current = doc.updatedAt;
        setText(doc.text);
      }
      setStatus("synced");
    };

    getBlob<NotesDoc>(slug, "notes", roomKey).then(doc => {
      if (doc) apply(doc);
      else if (!cancelled) setStatus("synced");
    });

    const off = mesh.addRoomMessageListener((_from, obj) => {
      const m = obj as { t?: string } & Partial<NotesDoc>;
      if (m?.t === "notes") {
        apply(m); // last-write-wins by updatedAt
      } else if (m?.t === "notes-sync-request" && updatedAtRef.current > 0) {
        // Someone opened Notes — hand them our current doc over the bus.
        mesh.sendRoomMessage({ t: "notes", text: textRef.current, updatedAt: updatedAtRef.current });
      }
    });

    // Ask whoever's here for the current note.
    mesh.sendRoomMessage({ t: "notes-sync-request" });

    return () => {
      cancelled = true;
      off();
    };
    // `text` intentionally omitted — the listener reads the latest via the
    // ref/closure refresh below; we re-subscribe only on room/key change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, roomKey, mesh]);

  const onEdit = (value: string) => {
    setText(value);
    const updatedAt = Date.now();
    updatedAtRef.current = updatedAt;
    // Broadcast live to everyone in the room (bus).
    mesh.sendRoomMessage({ t: "notes", text: value, updatedAt });
    setStatus("saving…");
    // Debounce the durable write (blob store).
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void putBlob(slug, "notes", { text: value, updatedAt } satisfies NotesDoc, roomKey).then(() =>
        setStatus("synced"),
      );
    }, 400);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <textarea
        value={text}
        onChange={e => onEdit(e.target.value)}
        placeholder="Shared room notes — everyone sees this, and it persists."
        data-testid="notes-text"
        style={{
          flex: 1,
          resize: "none",
          border: "none",
          background: "rgba(0,0,0,0.4)",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-mono)",
          fontSize: "0.9rem",
          padding: "0.6rem",
          outline: "none",
          boxShadow: "none",
        }}
      />
      <div style={{ padding: "0.3rem 0.6rem", fontSize: "0.7rem", color: "var(--slop-text-muted)", borderTop: "1px solid rgba(255,62,201,0.25)" }}>
        {status} · shared over the encrypted bus, stored blind
      </div>
    </div>
  );
}
