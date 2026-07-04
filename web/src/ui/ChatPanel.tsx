import { useEffect, useRef, useState } from "react";

// People + encrypted chat, riding the same room bus as the wallet. Messages
// are AES-GCM encrypted with the room key before they touch the relay, so
// text is as private as the call.

type Mesh = {
  sendRoomMessage: (obj: unknown) => void;
  addRoomMessageListener: (fn: (from: string, obj: unknown) => void) => () => void;
};

type ChatMsg = { from: string; name: string; text: string };

export function ChatPanel({
  mesh,
  me,
  peers,
  onClose,
}: {
  mesh: Mesh;
  me: string;
  peers: { id: string; handle: string | null }[];
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return mesh.addRoomMessageListener((from, obj) => {
      const m = obj as { t?: string; name?: string; text?: string };
      if (m?.t === "chat" && typeof m.text === "string") {
        setMsgs(prev => [...prev, { from, name: m.name || "anon", text: m.text! }]);
      }
    });
  }, [mesh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    mesh.sendRoomMessage({ t: "chat", name: me, text: t });
    setMsgs(prev => [...prev, { from: "me", name: `${me} (you)`, text: t }]);
    setText("");
  };

  return (
    <div className="wallet-overlay" onClick={onClose}>
      <div className="wallet-panel" onClick={e => e.stopPropagation()}>
        <div className="wallet-head">
          <h2>People &amp; chat</h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="wallet-section">
          <label>In the room ({peers.length})</label>
          <ul className="roster">
            {peers.map(p => (
              <li key={p.id}>{p.handle || "anon"}</li>
            ))}
          </ul>
        </div>

        <div className="wallet-section chat-log">
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
    </div>
  );
}
