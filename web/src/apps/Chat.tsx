import { useEffect, useRef, useState } from "react";
import type { AppServices } from "../os/appkit";

// Chat as a window-app: people roster + encrypted room chat, riding the same
// bus. Rendered inside a managed Window (the OS provides the title bar + close).

type ChatMsg = { from: string; name: string; text: string };

export function Chat({ mesh, label }: AppServices) {
  const { sendRoomMessage, addRoomMessageListener, peers } = mesh;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return addRoomMessageListener((from, obj) => {
      const m = obj as { t?: string; name?: string; text?: string };
      if (m?.t === "chat" && typeof m.text === "string") {
        setMsgs(prev => [...prev, { from, name: m.name || "anon", text: m.text! }]);
      }
    });
  }, [addRoomMessageListener]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    sendRoomMessage({ t: "chat", name: label, text: t });
    setMsgs(prev => [...prev, { from: "me", name: `${label} (you)`, text: t }]);
    setText("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "0.5rem", gap: "0.5rem" }}>
      <div>
        <label style={{ fontSize: "0.72rem", color: "var(--commons-cyan)" }}>In the room ({peers.length})</label>
        <ul className="roster">
          {peers.map(p => (
            <li key={p.id}>{p.handle || "anon"}</li>
          ))}
        </ul>
      </div>
      <div className="chat-log" style={{ flex: 1 }}>
        {msgs.length === 0 && <p className="dim">No messages yet.</p>}
        {msgs.map((m, i) => (
          <div key={i} className="chat-msg">
            <span className="chat-name">{m.name}:</span> {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="wallet-row">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          placeholder="message the room…"
          data-testid="chat-input"
        />
        <button onClick={send} data-testid="chat-send">
          Send
        </button>
      </div>
    </div>
  );
}
