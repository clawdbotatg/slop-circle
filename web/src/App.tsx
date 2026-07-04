import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveRoomKeys } from "./crypto/roomKeys";
import { useLocalMedia, type LocalStreamHandle } from "./media/useLocalMedia";
import { useMesh } from "./mesh/useMesh";
import { AudioSurface, VideoSurface } from "./ui/StreamView";
import { DesktopBackground, LivePulse, Window } from "./ui/slop";
import { ChatPanel } from "./ui/ChatPanel";
import { WalletPanel } from "./wallet/WalletPanel";

// The room link is `…/#<slug>:<password>` — the URL FRAGMENT never reaches
// any server, so sharing a link shares the secret peer-to-peer only.
// (Phase 1 upgrades the fragment secret into E2EE key material; in Phase 0
// it is exchanged for the room cookie via POST /v1/rooms/:slug/auth.)

function parseFragment(): { slug: string; password: string } | null {
  const h = location.hash.replace(/^#\/?/, "");
  const idx = h.indexOf(":");
  if (idx <= 0) return null;
  return { slug: h.slice(0, idx), password: decodeURIComponent(h.slice(idx + 1)) };
}

type Gate = "checking" | "join-form" | "claim-offer" | "authed" | "error";

export default function App() {
  const [gate, setGate] = useState<Gate>("checking");
  const [gateError, setGateError] = useState("");
  // Authed room carries the media key (never sent anywhere). The secret
  // itself lives only in the URL fragment.
  const [room, setRoom] = useState<{
    slug: string;
    mediaKey: ArrayBuffer;
    authKey: ArrayBuffer;
    busKey: ArrayBuffer;
  } | null>(null);
  const [pending, setPending] = useState<{
    slug: string;
    verifier: string;
    mediaKey: ArrayBuffer;
    authKey: ArrayBuffer;
    busKey: ArrayBuffer;
  } | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [handle, setHandle] = useState(() => localStorage.getItem("circle-handle") ?? "");

  const authRoom = useCallback(async (slug: string, secret: string) => {
    const { verifier, mediaKey, authKey, busKey } = await deriveRoomKeys(secret, slug);
    // Test seam: simulate an unauthorized peer (e.g. a relay-injected one)
    // that knows the verifier but not the fragment secret, so it derives
    // none of the content keys.
    const wrong = (window as unknown as { __circleForceWrongKey?: boolean }).__circleForceWrongKey === true;
    const mKey = wrong ? crypto.getRandomValues(new Uint8Array(32)).buffer : mediaKey;
    const aKey = wrong ? crypto.getRandomValues(new Uint8Array(32)).buffer : authKey;
    const bKey = wrong ? crypto.getRandomValues(new Uint8Array(32)).buffer : busKey;
    const res = await fetch(`/v1/rooms/${encodeURIComponent(slug)}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password: verifier }), // verifier, never the secret
    });
    if (res.ok) {
      setRoom({ slug, mediaKey: mKey, authKey: aKey, busKey: bKey });
      location.hash = `${slug}:${encodeURIComponent(secret)}`;
      setGate("authed");
      return;
    }
    if (res.status === 404) {
      setPending({ slug, verifier, mediaKey: mKey, authKey: aKey, busKey: bKey });
      location.hash = `${slug}:${encodeURIComponent(secret)}`;
      setGate("claim-offer");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setGateError(body.error ?? `auth failed (${res.status})`);
    setGate("join-form");
  }, []);

  const claimRoom = useCallback(async () => {
    if (!pending) return;
    const res = await fetch(`/v1/rooms/${encodeURIComponent(pending.slug)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password: pending.verifier }),
    });
    if (res.ok) {
      setRoom({
        slug: pending.slug,
        mediaKey: pending.mediaKey,
        authKey: pending.authKey,
        busKey: pending.busKey,
      });
      setGate("authed");
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setGateError(body.error ?? `claim failed (${res.status})`);
      setGate("join-form");
    }
  }, [pending]);

  useEffect(() => {
    const frag = parseFragment();
    if (!frag) {
      setGate("join-form");
      return;
    }
    setSlugInput(frag.slug);
    void authRoom(frag.slug, frag.password);
  }, [authRoom]);

  if (gate === "checking") return <div className="center">…</div>;

  if (gate === "claim-offer" && pending) {
    return (
      <div className="center">
        <div className="card">
          <h1>circle</h1>
          <p>
            Room <b>{pending.slug}</b> doesn't exist yet.
          </p>
          <p>Create it with this password? Everyone with the link can enter.</p>
          <button onClick={() => void claimRoom()}>Create room</button>
          <button className="ghost" onClick={() => setGate("join-form")}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (gate !== "authed" || !room) {
    return (
      <div className="center">
        <div className="card">
          <h1>circle</h1>
          <p className="dim">un-snoopable video calls for your circle</p>
          <form
            onSubmit={e => {
              e.preventDefault();
              setGateError("");
              const slug = slugInput.trim().toLowerCase();
              if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
                setGateError("room name: lowercase letters, digits, dashes");
                return;
              }
              void authRoom(slug, passwordInput);
            }}
          >
            <input
              placeholder="room name"
              value={slugInput}
              onChange={e => setSlugInput(e.target.value)}
              autoFocus
            />
            <input
              placeholder="password"
              type="password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
            />
            <button type="submit">Enter</button>
          </form>
          {gateError && <p className="err">{gateError}</p>}
        </div>
      </div>
    );
  }

  return (
    <Room
      slug={room.slug}
      mediaKey={room.mediaKey}
      authKey={room.authKey}
      busKey={room.busKey}
      handle={handle}
      setHandle={setHandle}
    />
  );
}

function Room({
  slug,
  mediaKey,
  authKey,
  busKey,
  handle,
  setHandle,
}: {
  slug: string;
  mediaKey: ArrayBuffer;
  authKey: ArrayBuffer;
  busKey: ArrayBuffer;
  handle: string;
  setHandle: (h: string) => void;
}) {
  const label = handle || "anon";
  const mesh = useMesh(true, slug, label, mediaKey, authKey, busKey);
  const failedPeers = Object.values(mesh.peerAuth).filter(s => s === "failed").length;
  const [walletOpen, setWalletOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [copied, setCopied] = useState(false);
  // Window positions on the desktop, keyed by stream id. z bumps on focus.
  type Slot = { x: number; y: number; w: number; h: number; z: number };
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const zTop = useRef(20);
  const copyInvite = useCallback(() => {
    // The full URL (incl. the #slug:secret fragment) IS the invite — the
    // secret rides the fragment, which never touches the server.
    void navigator.clipboard?.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const [streams, setStreams] = useState<LocalStreamHandle[]>([]);
  const streamsRef = useRef<LocalStreamHandle[]>(streams);
  streamsRef.current = streams;
  const meshRef = useRef(mesh);
  meshRef.current = mesh;

  const addStream = useCallback(
    (h: LocalStreamHandle) => {
      setStreams(prev => (prev.some(s => s.id === h.id) ? prev : [...prev, h]));
      meshRef.current.publish(h.stream, h.kind, label);
    },
    [label],
  );

  const stopStream = useCallback((id: string) => {
    const target = streamsRef.current.find(s => s.id === id);
    if (!target) return;
    meshRef.current.unpublish(id);
    target.stream.getTracks().forEach(t => t.stop());
    setStreams(prev => prev.filter(s => s.id !== id));
  }, []);

  const media = useLocalMedia(addStream, stopStream);

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      // Flip enabled on every local audio track (mic stays acquired; we just
      // stop transmitting sound).
      streamsRef.current.forEach(h => h.stream.getAudioTracks().forEach(t => (t.enabled = !next)));
      return next;
    });
  }, []);

  const leave = useCallback(() => {
    location.hash = "";
    location.reload();
  }, []);

  // Resolve the live stream for a publication: local handle for my pubs,
  // remoteStreams map for everyone else's.
  const tiles = useMemo(() => {
    return mesh.publications.map(pub => {
      const mine = pub.peerId === mesh.myId;
      const stream = mine
        ? streams.find(s => s.id === pub.streamId)?.stream
        : mesh.remoteStreams.get(pub.streamId);
      return { pub, mine, stream };
    });
  }, [mesh.publications, mesh.remoteStreams, mesh.myId, streams]);

  return (
    <>
      <DesktopBackground />
      <div className="slop-menubar">
        <span className="slop-menubar__brand">◆ circle · #{slug}</span>
        <input
          className="handle"
          placeholder="your name"
          value={handle}
          onChange={e => {
            setHandle(e.target.value);
            localStorage.setItem("circle-handle", e.target.value);
          }}
        />
        {media.activeCamera ? (
          <button onClick={() => media.stop("camera")}>Stop cam</button>
        ) : (
          <button onClick={() => void media.startCamera()} disabled={media.busy === "camera"}>
            Camera
          </button>
        )}
        <button onClick={() => void media.startScreen()} disabled={media.busy === "screen"}>
          Screen
        </button>
        {media.activeAudio ? (
          <button onClick={() => media.stop("audio")}>Stop mic</button>
        ) : (
          <button onClick={() => void media.startAudio()} disabled={media.busy === "audio"}>
            Mic
          </button>
        )}
        <button onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</button>
        <button onClick={() => setChatOpen(true)}>Chat</button>
        <button onClick={() => setWalletOpen(true)}>Wallet</button>
        <button onClick={copyInvite}>{copied ? "Copied ✓" : "Invite"}</button>
        <button onClick={leave}>Leave</button>
        <span className="slop-menubar__status">
          <span>{mesh.connected ? `${mesh.peers.length} here` : mesh.connectError ?? "connecting…"}</span>
          <span
            className={`slop-badge ${mesh.encrypted ? "slop-badge--rosa" : "slop-badge--warn"}`}
            title={mesh.encrypted ? "Media is end-to-end encrypted; the server sees only ciphertext." : "Frame encryption unavailable in this browser."}
          >
            {mesh.encrypted ? "🔒 sub rosa" : "⚠ not encrypted"}
          </span>
          {failedPeers > 0 && (
            <span className="slop-badge slop-badge--alert" title="A peer could not prove knowledge of the room secret — possibly injected. It cannot decrypt any media.">
              ⚠ {failedPeers} unverified
            </span>
          )}
          <LivePulse live={mesh.connected} />
        </span>
      </div>

      <div className="desktop-surface">
        {media.error && <div className="media-error">{media.error}</div>}
        {tiles.length === 0 && <p className="desktop-hint">Nobody is sharing yet — turn on your Camera to circle up. Then hit Invite and send the link to a friend.</p>}
        {tiles.map(({ pub, mine, stream }, i) => {
          const id = pub.streamId;
          const def: Slot = { x: 30 + (i % 5) * 42, y: 64 + (i % 5) * 44, w: 360, h: 280, z: 5 };
          const slot = slots[id] ?? def;
          const auth = mine ? "verified" : mesh.peerAuth[pub.peerId];
          const mark = auth === "failed" ? "⚠ " : auth === "pending" ? "⋯ " : "";
          const kind = pub.kind === "screen" ? "SCREEN" : pub.kind === "audio" ? "AUDIO" : "CAM";
          const title = `${kind} — ${mark}${pub.label}${mine ? " (you)" : ""}`;
          return (
            <Window
              key={id}
              title={title}
              x={slot.x}
              y={slot.y}
              width={slot.w}
              height={slot.h}
              zIndex={slot.z}
              onFocus={() => setSlots(s => ({ ...s, [id]: { ...(s[id] ?? def), z: (zTop.current += 1) } }))}
              onClose={mine ? () => media.stopById(id) : undefined}
              onMove={({ x, y }) => setSlots(s => ({ ...s, [id]: { ...(s[id] ?? def), x, y } }))}
              onResize={({ x, y, width, height }) => setSlots(s => ({ ...s, [id]: { ...(s[id] ?? def), x, y, w: width, h: height } }))}
              bodyStyle={{ padding: 0 }}
            >
              {!stream ? (
                <div className="tile-waiting">connecting…</div>
              ) : pub.kind === "audio" ? (
                <AudioSurface stream={stream} muted={mine} label={pub.label} />
              ) : (
                <VideoSurface stream={stream} muted={mine} mirrored={mine && pub.kind === "camera"} />
              )}
            </Window>
          );
        })}
      </div>

      {walletOpen && <WalletPanel mesh={mesh} onClose={() => setWalletOpen(false)} />}
      {chatOpen && <ChatPanel mesh={mesh} me={label} peers={mesh.peers} onClose={() => setChatOpen(false)} />}
    </>
  );
}
