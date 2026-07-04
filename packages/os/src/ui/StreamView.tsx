import { useEffect, useRef } from "react";

// Full-bleed media surfaces that fill a Window body (the window title bar
// already shows the peer/kind, so no label here).

export function VideoSurface({ stream, muted, mirrored = false }: { stream: MediaStream; muted: boolean; mirrored?: boolean }) {
  return (
    <video
      ref={el => {
        if (el && el.srcObject !== stream) el.srcObject = stream;
      }}
      autoPlay
      playsInline
      muted={muted}
      style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000", display: "block", transform: mirrored ? "scaleX(-1)" : undefined }}
    />
  );
}

export function AudioSurface({ stream, muted, label }: { stream: MediaStream; muted: boolean; label: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: "#000" }}>
      <audio ref={ref} autoPlay muted={muted} style={{ display: "none" }} />
      <span style={{ fontSize: "2.5rem" }}>🎙</span>
      <span className="dim">{label}</span>
    </div>
  );
}
