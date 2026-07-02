import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [room, setRoom] = useState<{ slug: string; password: string } | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [handle, setHandle] = useState(() => localStorage.getItem("circle-handle") ?? "");

  const authRoom = useCallback(async (slug: string, password: string) => {
    const res = await fetch(`/v1/rooms/${encodeURIComponent(slug)}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setRoom({ slug, password });
      location.hash = `${slug}:${encodeURIComponent(password)}`;
      setGate("authed");
      return;
    }
    if (res.status === 404) {
      setRoom({ slug, password });
      setGate("claim-offer");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setGateError(body.error ?? `auth failed (${res.status})`);
    setGate("join-form");
  }, []);

  const claimRoom = useCallback(async () => {
    if (!room) return;
    const res = await fetch(`/v1/rooms/${encodeURIComponent(room.slug)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password: room.password }),
    });
    if (res.ok) {
      location.hash = `${room.slug}:${encodeURIComponent(room.password)}`;
      setGate("authed");
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setGateError(body.error ?? `claim failed (${res.status})`);
      setGate("join-form");
    }
  }, [room]);

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

  if (gate === "claim-offer" && room) {
    return (
      <div className="center">
        <div className="card">
          <h1>circle</h1>
          <p>
            Room <b>{room.slug}</b> doesn't exist yet.
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

  return <Room slug={room.slug} handle={handle} setHandle={setHandle} />;
}

function Room({
  slug,
  handle,
  setHandle,
}: {
  slug: string;
  handle: string;
  setHandle: (h: string) => void;
}) {
  const label = handle || "anon";
  const mesh = useMesh(true, slug, label);

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
        {tiles.map(({ pub, mine, stream }) =>
          !stream ? (
            <div key={pub.streamId} className="tile tile-waiting">
              <span className="tile-label">{pub.label} (connecting…)</span>
            </div>
          ) : pub.kind === "audio" ? (
            <AudioTile key={pub.streamId} stream={stream} muted={mine} label={pub.label} />
          ) : (
            <VideoTile
              key={pub.streamId}
              stream={stream}
              muted={mine}
              label={mine ? `${pub.label} (you)` : pub.label}
              mirrored={mine && pub.kind === "camera"}
            />
          ),
        )}
        {tiles.length === 0 && (
          <div className="empty">
            <p>Nobody is sharing yet. Turn on your camera to circle up.</p>
          </div>
        )}
      </main>
    </div>
  );
}
