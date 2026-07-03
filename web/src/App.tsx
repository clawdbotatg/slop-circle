import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveRoomKeys } from "./crypto/roomKeys";
import { useLocalMedia, type LocalStreamHandle } from "./media/useLocalMedia";
import { useMesh } from "./mesh/useMesh";
import { AudioTile, VideoTile } from "./ui/StreamView";

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
  const [room, setRoom] = useState<{ slug: string; mediaKey: ArrayBuffer; authKey: ArrayBuffer } | null>(null);
  const [pending, setPending] = useState<{
    slug: string;
    verifier: string;
    mediaKey: ArrayBuffer;
    authKey: ArrayBuffer;
  } | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [handle, setHandle] = useState(() => localStorage.getItem("circle-handle") ?? "");

  const authRoom = useCallback(async (slug: string, secret: string) => {
    const { verifier, mediaKey, authKey } = await deriveRoomKeys(secret, slug);
    // Test seam: simulate an unauthorized peer (e.g. a relay-injected one)
    // that knows the verifier but not the fragment secret, so it derives
    // neither the media key nor the auth key.
    const wrong = (window as unknown as { __circleForceWrongKey?: boolean }).__circleForceWrongKey === true;
    const mKey = wrong ? crypto.getRandomValues(new Uint8Array(32)).buffer : mediaKey;
    const aKey = wrong ? crypto.getRandomValues(new Uint8Array(32)).buffer : authKey;
    const res = await fetch(`/v1/rooms/${encodeURIComponent(slug)}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password: verifier }), // verifier, never the secret
    });
    if (res.ok) {
      setRoom({ slug, mediaKey: mKey, authKey: aKey });
      location.hash = `${slug}:${encodeURIComponent(secret)}`;
      setGate("authed");
      return;
    }
    if (res.status === 404) {
      setPending({ slug, verifier, mediaKey: mKey, authKey: aKey });
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
      setRoom({ slug: pending.slug, mediaKey: pending.mediaKey, authKey: pending.authKey });
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
    <Room slug={room.slug} mediaKey={room.mediaKey} authKey={room.authKey} handle={handle} setHandle={setHandle} />
  );
}

function Room({
  slug,
  mediaKey,
  authKey,
  handle,
  setHandle,
}: {
  slug: string;
  mediaKey: ArrayBuffer;
  authKey: ArrayBuffer;
  handle: string;
  setHandle: (h: string) => void;
}) {
  const label = handle || "anon";
  const mesh = useMesh(true, slug, label, mediaKey, authKey);
  const failedPeers = Object.values(mesh.peerAuth).filter(s => s === "failed").length;

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
    <div className="room">
      <header>
        <span className="roomname">#{slug}</span>
        <input
          className="handle"
          placeholder="your name"
          value={handle}
          onChange={e => {
            setHandle(e.target.value);
            localStorage.setItem("circle-handle", e.target.value);
          }}
        />
        <span className={mesh.connected ? "status ok" : "status"}>
          {mesh.connected ? `${mesh.peers.length} here` : mesh.connectError ?? "connecting…"}
        </span>
        <span
          className={mesh.encrypted ? "badge sub-rosa" : "badge warn"}
          title={
            mesh.encrypted
              ? "Media is end-to-end encrypted with the room key. The server sees only ciphertext."
              : "Frame encryption unavailable in this browser — the transport is not end-to-end encrypted."
          }
        >
          {mesh.encrypted ? "🔒 sub rosa" : "⚠ not encrypted"}
        </span>
        {failedPeers > 0 && (
          <span
            className="badge alert"
            title="A peer could not prove knowledge of the room secret — possibly injected. It cannot decrypt any media."
          >
            ⚠ {failedPeers} unverified {failedPeers === 1 ? "peer" : "peers"}
          </span>
        )}
        <nav>
          {media.activeCamera ? (
            <button onClick={() => media.stop("camera")}>Stop camera</button>
          ) : (
            <button onClick={() => void media.startCamera()} disabled={media.busy === "camera"}>
              Camera
            </button>
          )}
          <button onClick={() => void media.startScreen()} disabled={media.busy === "screen"}>
            Share screen
          </button>
          {media.activeAudio ? (
            <button onClick={() => media.stop("audio")}>Mute mic</button>
          ) : (
            <button onClick={() => void media.startAudio()} disabled={media.busy === "audio"}>
              Mic only
            </button>
          )}
        </nav>
      </header>
      {media.error && <p className="err">{media.error}</p>}
      <main className="grid">
        {tiles.map(({ pub, mine, stream }) => {
          const auth = mine ? "verified" : mesh.peerAuth[pub.peerId];
          const mark = auth === "failed" ? "⚠ " : auth === "pending" ? "… " : "";
          const label = mine ? `${pub.label} (you)` : `${mark}${pub.label}`;
          return !stream ? (
            <div key={pub.streamId} className="tile tile-waiting">
              <span className="tile-label">{mark}{pub.label} (connecting…)</span>
            </div>
          ) : pub.kind === "audio" ? (
            <AudioTile key={pub.streamId} stream={stream} muted={mine} label={label} />
          ) : (
            <VideoTile
              key={pub.streamId}
              stream={stream}
              muted={mine}
              label={label}
              mirrored={mine && pub.kind === "camera"}
            />
          );
        })}
        {tiles.length === 0 && (
          <div className="empty">
            <p>Nobody is sharing yet. Turn on your camera to circle up.</p>
          </div>
        )}
      </main>
    </div>
  );
}
