import { useEffect, useRef } from "react";

// The canonical stream tile: <video srcObject autoPlay playsInline>.
// Own publications are always muted (echo prevention). Audio-only streams
// render a hidden <audio> plus a label card.

export function VideoTile({
  stream,
  muted,
  label,
  mirrored = false,
}: {
  stream: MediaStream;
  muted: boolean;
  label: string;
  mirrored?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  return (
    <div className="tile">
      <video
        ref={el => {
          videoRef.current = el;
          if (el && el.srcObject !== stream) el.srcObject = stream;
        }}
        autoPlay
        playsInline
        muted={muted}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          background: "#000",
          display: "block",
          transform: mirrored ? "scaleX(-1)" : undefined,
        }}
      />
      <span className="tile-label">{label}</span>
    </div>
  );
}

export function AudioTile({ stream, muted, label }: { stream: MediaStream; muted: boolean; label: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (audioRef.current && audioRef.current.srcObject !== stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div className="tile tile-audio">
      <audio ref={audioRef} autoPlay muted={muted} style={{ display: "none" }} />
      <span className="tile-audio-glyph">🎙</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}
