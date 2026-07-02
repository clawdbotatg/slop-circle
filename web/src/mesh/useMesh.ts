import { useCallback, useEffect, useRef, useState } from "react";

// Adapted from slop-computer-live usePeerMesh.ts — media/mesh essentials
// only (~700 of 4,692 lines). Full-mesh WebRTC: every peer connects to
// every other peer; the relay only forwards signaling. Glare is avoided
// deterministically: only the peer with the lexicographically-lower id
// initiates offers (the watchdog force-initiates as the one exception).

export type StreamKind = "camera" | "screen" | "audio";

export type Publication = {
  streamId: string;
  peerId: string; // ephemeral, per-connection
  kind: StreamKind;
  label: string;
  cameraOff?: boolean;
};

export type Peer = {
  id: string;
  handle: string | null;
};

const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 2000;

const STREAM_WATCHDOG_INTERVAL_MS = 2000;
const STREAM_WAIT_TIMEOUT_MS = 6000; // grace before a pub counts as stuck
const STREAM_RECONNECT_BACKOFF_MS = 10_000; // min interval between retries per peer

const CAMERA_MAX_BITRATE = 1_500_000; // 1.5 Mbps — clean 480p, decent 720p
const CAMERA_MAX_FRAMERATE = 30;
const SCREEN_MAX_BITRATE = 2_500_000; // 2.5 Mbps — sharp text in screen shares
const SCREEN_MAX_FRAMERATE = 15;

// STUN-only fallback when the room's TURN server isn't reachable — works
// for same-NAT testing, fails on symmetric NATs.
const FALLBACK_ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

type TurnCreds = { username: string; credential: string; ttl: number; urls: string[] };

let cachedTurn: { config: RTCConfiguration; expiresAt: number } | null = null;

async function fetchIceConfig(slug: string): Promise<RTCConfiguration> {
  if (cachedTurn && cachedTurn.expiresAt > Date.now() + 60_000) return cachedTurn.config;
  try {
    const res = await fetch(`/turn/credentials?slug=${encodeURIComponent(slug)}`, { credentials: "include" });
    if (!res.ok) return FALLBACK_ICE;
    const data = (await res.json()) as TurnCreds;
    const config: RTCConfiguration = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: data.urls, username: data.username, credential: data.credential },
      ],
    };
    cachedTurn = { config, expiresAt: Date.now() + data.ttl * 1000 };
    return config;
  } catch {
    return FALLBACK_ICE;
  }
}

function applySenderCaps(pc: RTCPeerConnection, stream: MediaStream, kind: StreamKind): void {
  // Audio is cheap to encode and voice quality matters — leave it alone.
  if (kind === "audio") return;
  const streamTracks = new Set(stream.getTracks());
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    if (!streamTracks.has(sender.track)) continue;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    if (kind === "camera") {
      params.encodings[0] = {
        ...params.encodings[0],
        maxBitrate: CAMERA_MAX_BITRATE,
        maxFramerate: CAMERA_MAX_FRAMERATE,
      };
    } else if (kind === "screen") {
      params.encodings[0] = {
        ...params.encodings[0],
        maxBitrate: SCREEN_MAX_BITRATE,
        maxFramerate: SCREEN_MAX_FRAMERATE,
      };
    }
    sender.setParameters(params).catch(err => console.warn("[mesh] setParameters failed", err));
  }
}

function preferEfficientVideoCodecs(pc: RTCPeerConnection): void {
  if (typeof RTCRtpSender.getCapabilities !== "function") return;
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps?.codecs?.length) return;
  const isPreferred = (mimeType: string) => /\/(VP9|H264)$/i.test(mimeType);
  const preferred = caps.codecs.filter(c => isPreferred(c.mimeType));
  if (preferred.length === 0) return;
  const others = caps.codecs.filter(c => !isPreferred(c.mimeType));
  const ordered = [...preferred, ...others];
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track?.kind !== "video") continue;
    if (typeof transceiver.setCodecPreferences !== "function") continue;
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (err) {
      console.warn("[mesh] setCodecPreferences failed", err);
    }
  }
}

export type MeshState = {
  myId: string | null;
  peers: Peer[];
  connected: boolean;
  connectError: string | null;
  remoteStreams: Map<string, MediaStream>;
  publications: Publication[];
  publish: (stream: MediaStream, kind: StreamKind, label: string) => void;
  unpublish: (streamId: string) => void;
  replaceTrack: (
    streamId: string,
    kind: "audio" | "video",
    newTrack: MediaStreamTrack,
  ) => Promise<MediaStream | null>;
  setCameraOff: (streamId: string, off: boolean) => void;
};

export function useMesh(enabled: boolean, slug: string, label: string): MeshState {
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [publications, setPublications] = useState<Publication[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamsRef = useRef<Map<string, { stream: MediaStream; kind: StreamKind }>>(new Map());
  const iceConfigRef = useRef<RTCConfiguration>(FALLBACK_ICE);
  const labelRef = useRef(label);
  labelRef.current = label;

  // Live mirrors so the watchdog interval reads fresh state without rebuilding.
  const publicationsRef = useRef<Publication[]>(publications);
  publicationsRef.current = publications;
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(remoteStreams);
  remoteStreamsRef.current = remoteStreams;
  const peersRef = useRef<Peer[]>(peers);
  peersRef.current = peers;

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const closePeerConnection = useCallback((peerId: string) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.onnegotiationneeded = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    peerConnectionsRef.current.delete(peerId);
  }, []);

  const initiateOffer = useCallback(
    async (peerId: string) => {
      const pc = peerConnectionsRef.current.get(peerId);
      if (!pc) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "offer", to: peerId, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] initiateOffer failed", err);
      }
    },
    [send],
  );

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection(iceConfigRef.current);

      // Attach existing local streams so newly-formed pcs get our media.
      for (const { stream, kind } of localStreamsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* track already added */
          }
        }
        applySenderCaps(pc, stream, kind);
      }
      preferEfficientVideoCodecs(pc);

      pc.ontrack = event => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams(prev => {
          if (prev.get(stream.id) === stream) return prev;
          const next = new Map(prev);
          next.set(stream.id, stream);
          return next;
        });
        event.track.addEventListener("ended", () => {
          if (stream.getTracks().every(t => t.readyState === "ended")) {
            setRemoteStreams(prev => {
              if (!prev.has(stream.id)) return prev;
              const next = new Map(prev);
              next.delete(stream.id);
              return next;
            });
          }
        });
      };

      pc.onicecandidate = event => {
        if (event.candidate) send({ type: "ice", to: peerId, payload: event.candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        // "disconnected" is transient — only tear down on terminal states;
        // the stream watchdog rebuilds if the pc never recovers.
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          closePeerConnection(peerId);
        }
      };

      pc.onnegotiationneeded = () => {
        if (pc.signalingState === "stable") void initiateOffer(peerId);
      };

      peerConnectionsRef.current.set(peerId, pc);
      return pc;
    },
    [send, closePeerConnection, initiateOffer],
  );

  const handleOffer = useCallback(
    async (from: string, payload: RTCSessionDescriptionInit) => {
      let pc = peerConnectionsRef.current.get(from);
      // A recovery offer may land on our own dead pc — rebuild so it takes.
      if (
        pc &&
        (pc.connectionState === "failed" ||
          pc.connectionState === "closed" ||
          pc.connectionState === "disconnected")
      ) {
        closePeerConnection(from);
        pc = undefined;
      }
      if (!pc) pc = createPeerConnection(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        // setRemoteDescription may have spun up new transceivers — apply
        // codec prefs before answering.
        preferEfficientVideoCodecs(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "answer", to: from, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] handleOffer failed", err);
      }
    },
    [createPeerConnection, closePeerConnection, send],
  );

  const handleAnswer = useCallback(async (from: string, payload: RTCSessionDescriptionInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } catch (err) {
      console.warn("[mesh] handleAnswer failed", err);
    }
  }, []);

  const handleIce = useCallback(async (from: string, payload: RTCIceCandidateInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload));
    } catch {
      /* stale candidate */
    }
  }, []);

  const publish = useCallback(
    (stream: MediaStream, kind: StreamKind, pubLabel: string) => {
      if (localStreamsRef.current.has(stream.id)) return;
      localStreamsRef.current.set(stream.id, { stream, kind });
      for (const pc of peerConnectionsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* duplicate */
          }
        }
        applySenderCaps(pc, stream, kind);
        preferEfficientVideoCodecs(pc);
      }
      send({ type: "publish", streamId: stream.id, kind, label: pubLabel });
    },
    [send],
  );

  const replaceTrack = useCallback(
    async (
      streamId: string,
      kind: "audio" | "video",
      newTrack: MediaStreamTrack,
    ): Promise<MediaStream | null> => {
      const entry = localStreamsRef.current.get(streamId);
      if (!entry) return null;
      const { stream, kind: pubKind } = entry;
      for (const pc of peerConnectionsRef.current.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === kind);
        if (!sender) continue;
        try {
          await sender.replaceTrack(newTrack);
        } catch (err) {
          console.warn("[mesh] replaceTrack failed", err);
        }
      }
      // Fresh MediaStream so React consumers re-bind. Map key stays the
      // ORIGINAL publication streamId.
      const oldTracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      const keepTracks = kind === "audio" ? stream.getVideoTracks() : stream.getAudioTracks();
      const fresh = new MediaStream([...keepTracks, newTrack]);
      for (const t of oldTracks) t.stop();
      localStreamsRef.current.set(streamId, { stream: fresh, kind: pubKind });
      for (const pc of peerConnectionsRef.current.values()) {
        applySenderCaps(pc, fresh, pubKind);
      }
      return fresh;
    },
    [],
  );

  const unpublish = useCallback(
    (streamId: string) => {
      const entry = localStreamsRef.current.get(streamId);
      if (entry) {
        const { stream } = entry;
        localStreamsRef.current.delete(streamId);
        const tracks = new Set(stream.getTracks());
        for (const pc of peerConnectionsRef.current.values()) {
          for (const sender of pc.getSenders()) {
            if (sender.track && tracks.has(sender.track)) {
              try {
                pc.removeTrack(sender);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      // Optimistic local removal so the tile unmounts immediately.
      setPublications(prev => prev.filter(p => p.streamId !== streamId));
      send({ type: "unpublish", streamId });
    },
    [send],
  );

  const setCameraOff = useCallback(
    (streamId: string, off: boolean) => {
      // Server is source of truth — it rebroadcasts the updated publication
      // via `published`. No optimistic local write.
      send({ type: "set_camera_off", streamId, off });
    },
    [send],
  );

  // WebSocket connect / reconnect / message dispatch.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const teardownConnections = () => {
      peerConnectionsRef.current.forEach(pc => {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      });
      peerConnectionsRef.current = new Map();
      setRemoteStreams(new Map());
    };

    const connect = async () => {
      if (cancelled) return;
      iceConfigRef.current = await fetchIceConfig(slug);
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/signal?slug=${encodeURIComponent(slug)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        setConnectError(null);
        ws.send(JSON.stringify({ type: "hello" }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
        // Re-announce local streams (e.g. after reconnect).
        for (const [streamId, { kind }] of localStreamsRef.current) {
          ws.send(JSON.stringify({ type: "publish", streamId, kind, label: labelRef.current }));
        }
      };

      ws.onmessage = ev => {
        if (cancelled) return;
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }

        if (msg.type === "hello" && typeof msg.id === "string" && Array.isArray(msg.peers)) {
          const meId = msg.id;
          const others = msg.peers as Peer[];
          myIdRef.current = meId;
          setMyId(meId);
          setPeers([...others, { id: meId, handle: labelRef.current }]);
          if (Array.isArray(msg.publications)) setPublications(msg.publications as Publication[]);
          teardownConnections();
          // Offerer election: lower id initiates.
          for (const peer of others) {
            if (peer.id < meId) {
              createPeerConnection(peer.id);
              void initiateOffer(peer.id);
            }
          }
          return;
        }

        if (msg.type === "peer_join" && msg.peer) {
          const peer = msg.peer as Peer;
          setPeers(prev => (prev.some(p => p.id === peer.id) ? prev : [...prev, peer]));
          const meIdNow = myIdRef.current;
          if (meIdNow && peer.id < meIdNow) {
            createPeerConnection(peer.id);
            void initiateOffer(peer.id);
          }
          return;
        }

        if (msg.type === "peer_leave" && msg.peer) {
          const peer = msg.peer as Peer;
          setPeers(prev => prev.filter(p => p.id !== peer.id));
          closePeerConnection(peer.id);
          return;
        }

        if (msg.type === "signal") {
          const kind = msg.kind as string;
          const from = msg.from as string;
          const payload = msg.payload as RTCSessionDescriptionInit | RTCIceCandidateInit;
          if (kind === "offer") void handleOffer(from, payload as RTCSessionDescriptionInit);
          else if (kind === "answer") void handleAnswer(from, payload as RTCSessionDescriptionInit);
          else if (kind === "ice") void handleIce(from, payload as RTCIceCandidateInit);
          return;
        }

        if (msg.type === "published" && msg.publication) {
          const pub = msg.publication as Publication;
          setPublications(prev => {
            const next = prev.filter(p => !(p.peerId === pub.peerId && p.streamId === pub.streamId));
            next.push(pub);
            return next;
          });
          return;
        }

        if (msg.type === "unpublished" && typeof msg.peerId === "string" && typeof msg.streamId === "string") {
          const pid = msg.peerId as string;
          const sid = msg.streamId as string;
          setPublications(prev => prev.filter(p => !(p.peerId === pid && p.streamId === sid)));
          setRemoteStreams(prev => {
            if (!prev.has(sid)) return prev;
            const next = new Map(prev);
            next.delete(sid);
            return next;
          });
          return;
        }
        // pong and unknown types: ignore.
      };

      ws.onclose = ev => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        setConnected(false);
        const GATE_CLOSE_CODES: Record<number, string> = {
          4401: "unauthenticated",
          4403: "room-auth-required",
          4404: "room-not-found",
        };
        const gateReason = GATE_CLOSE_CODES[ev.code];
        if (gateReason) {
          setConnectError(gateReason);
          cancelled = true;
        }
        setMyId(null);
        myIdRef.current = null;
        teardownConnections();
        setPeers([]);
        setPublications([]);
        if (cancelled) return;
        reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      teardownConnections();
    };
  }, [enabled, slug, createPeerConnection, closePeerConnection, handleOffer, handleAnswer, handleIce, initiateOffer]);

  // Stream watchdog: a publication with no matching remote stream for too
  // long means a stuck pc — rebuild it and force a fresh offer (the one
  // exception to the offerer election).
  useEffect(() => {
    if (!enabled) return;
    const missingSince = new Map<string, number>();
    const lastAttempt = new Map<string, number>();
    const tick = () => {
      const meId = myIdRef.current;
      if (!meId) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      const liveStreamIds = new Set<string>();
      for (const pub of publicationsRef.current) {
        if (pub.peerId === meId) continue;
        liveStreamIds.add(pub.streamId);
        if (remoteStreamsRef.current.has(pub.streamId)) {
          missingSince.delete(pub.streamId);
          continue;
        }
        // Publisher already gone — the relay will reap the pub shortly.
        if (!peersRef.current.some(p => p.id === pub.peerId)) {
          missingSince.delete(pub.streamId);
          continue;
        }
        let firstSeen = missingSince.get(pub.streamId);
        if (firstSeen == null) {
          firstSeen = now;
          missingSince.set(pub.streamId, firstSeen);
        }
        if (now - firstSeen < STREAM_WAIT_TIMEOUT_MS) continue;
        const lastTry = lastAttempt.get(pub.peerId) ?? 0;
        if (now - lastTry < STREAM_RECONNECT_BACKOFF_MS) continue;
        lastAttempt.set(pub.peerId, now);
        console.warn(
          `[mesh] watchdog: pub ${pub.streamId} from ${pub.peerId} missing ${Math.round(now - firstSeen)}ms — rebuilding pc`,
        );
        closePeerConnection(pub.peerId);
        createPeerConnection(pub.peerId);
        void initiateOffer(pub.peerId);
      }
      for (const sid of missingSince.keys()) {
        if (!liveStreamIds.has(sid)) missingSince.delete(sid);
      }
    };
    const handle = setInterval(tick, STREAM_WATCHDOG_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [enabled, closePeerConnection, createPeerConnection, initiateOffer]);

  return {
    myId,
    peers,
    connected,
    connectError,
    remoteStreams,
    publications,
    publish,
    unpublish,
    replaceTrack,
    setCameraOff,
  };
}
