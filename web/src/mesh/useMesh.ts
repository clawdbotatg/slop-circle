import { useCallback, useEffect, useRef, useState } from "react";
import { decryptReceiver, encryptSender, frameCryptoSupported } from "../crypto/frameCrypto";
import type { Peer, Publication, StreamKind } from "./meshTypes";
import { runPeerAuth, type PeerAuthResult } from "./peerAuth";
import { RelayTransport, type SignalTransport } from "./signalTransport";

export type { Peer, Publication, StreamKind } from "./meshTypes";
export type PeerAuthState = "pending" | PeerAuthResult;

// Adapted from slop-computer-live usePeerMesh.ts — media/mesh essentials
// only. Full-mesh WebRTC over a swappable SignalTransport: every peer
// connects to every other peer; the transport only routes signaling.
// Perfect negotiation handles offer glare (both peers may offer at once).

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
    // Mutate the existing encoding in place — spreading it copies read-only
    // fields (rid/ssrc) which setParameters then rejects.
    const enc = params.encodings[0];
    if (kind === "camera") {
      enc.maxBitrate = CAMERA_MAX_BITRATE;
      enc.maxFramerate = CAMERA_MAX_FRAMERATE;
    } else if (kind === "screen") {
      enc.maxBitrate = SCREEN_MAX_BITRATE;
      enc.maxFramerate = SCREEN_MAX_FRAMERATE;
    }
    sender.setParameters(params).catch(err => console.warn("[mesh] setParameters failed", err));
  }
}

function preferEfficientVideoCodecs(pc: RTCPeerConnection): void {
  if (typeof RTCRtpSender.getCapabilities !== "function") return;
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps?.codecs?.length) return;
  // Prefer VP8 first: its RTP packetization (RFC 7741) treats the frame
  // payload as opaque bytes, so per-frame encryption survives packetize/
  // depacketize. H264's NAL-unit packetization parses the payload and breaks
  // on ciphertext (frames never reassemble). VP9 second, H264 last.
  const rank = (mimeType: string) => (/\/VP8$/i.test(mimeType) ? 0 : /\/VP9$/i.test(mimeType) ? 1 : 2);
  const ordered = [...caps.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
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
  /** True when media frames are end-to-end encrypted with the room key. */
  encrypted: boolean;
  /** Per-peer authentication status (proved knowledge of the room secret). */
  peerAuth: Record<string, PeerAuthState>;
  publish: (stream: MediaStream, kind: StreamKind, label: string) => void;
  unpublish: (streamId: string) => void;
  replaceTrack: (
    streamId: string,
    kind: "audio" | "video",
    newTrack: MediaStreamTrack,
  ) => Promise<MediaStream | null>;
  setCameraOff: (streamId: string, off: boolean) => void;
};

export function useMesh(
  enabled: boolean,
  slug: string,
  label: string,
  mediaKey: ArrayBuffer | null,
  authKey: ArrayBuffer | null,
): MeshState {
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [publications, setPublications] = useState<Publication[]>([]);
  const [peerAuth, setPeerAuth] = useState<Record<string, PeerAuthState>>({});

  const transportRef = useRef<SignalTransport | null>(null);
  const connectedRef = useRef(false);
  const myIdRef = useRef<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Perfect-negotiation bookkeeping: are we mid-offer to this peer?
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());
  const localStreamsRef = useRef<Map<string, { stream: MediaStream; kind: StreamKind }>>(new Map());
  const iceConfigRef = useRef<RTCConfiguration>(FALLBACK_ICE);
  const labelRef = useRef(label);
  labelRef.current = label;
  const mediaKeyRef = useRef(mediaKey);
  mediaKeyRef.current = mediaKey;
  const authKeyRef = useRef(authKey);
  authKeyRef.current = authKey;

  const setPeerAuthStatus = useCallback((peerId: string, status: PeerAuthState) => {
    setPeerAuth(prev => (prev[peerId] === status ? prev : { ...prev, [peerId]: status }));
  }, []);
  const clearPeerAuth = useCallback((peerId: string) => {
    setPeerAuth(prev => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  // Live mirrors so the watchdog interval reads fresh state without rebuilding.
  const publicationsRef = useRef<Publication[]>(publications);
  publicationsRef.current = publications;
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(remoteStreams);
  remoteStreamsRef.current = remoteStreams;
  const peersRef = useRef<Peer[]>(peers);
  peersRef.current = peers;

  const send = useCallback((msg: object) => {
    transportRef.current?.send(msg);
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
    makingOfferRef.current.delete(peerId);
    clearPeerAuth(peerId);
  }, [clearPeerAuth]);

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      // encodedInsertableStreams is required by the legacy createEncodedStreams
      // fallback path; ignored where RTCRtpScriptTransform is used.
      const pc = new RTCPeerConnection({
        ...iceConfigRef.current,
        ...(mediaKeyRef.current ? { encodedInsertableStreams: true } : {}),
      } as RTCConfiguration);

      // Peer authentication over a data channel: the lower-id peer opens
      // "circle-auth", the higher-id peer answers via ondatachannel. Each
      // proves knowledge of the room secret to the other.
      const authKeyBytes = authKeyRef.current;
      if (authKeyBytes) {
        const meId = myIdRef.current ?? "";
        setPeerAuthStatus(peerId, "pending");
        const onResult = (r: PeerAuthResult) => setPeerAuthStatus(peerId, r);
        if (meId < peerId) {
          const ch = pc.createDataChannel("circle-auth");
          runPeerAuth(ch, { myId: meId, peerId, authKey: authKeyBytes }, onResult);
        } else {
          pc.ondatachannel = e => {
            if (e.channel.label === "circle-auth") {
              runPeerAuth(e.channel, { myId: meId, peerId, authKey: authKeyBytes }, onResult);
            }
          };
        }
      }

      // Attach existing local streams so newly-formed pcs get our media.
      for (const { stream, kind } of localStreamsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            const sender = pc.addTrack(track, stream);
            if (mediaKeyRef.current) encryptSender(sender, mediaKeyRef.current);
          } catch {
            /* track already added */
          }
        }
        applySenderCaps(pc, stream, kind);
      }
      preferEfficientVideoCodecs(pc);

      pc.ontrack = event => {
        if (mediaKeyRef.current) decryptReceiver(event.receiver, mediaKeyRef.current);
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

      // Perfect negotiation: whoever's media changes fires an offer; glare
      // is resolved by the polite/impolite rule in handleOffer. Both peers
      // may offer at once safely.
      pc.onnegotiationneeded = async () => {
        try {
          makingOfferRef.current.set(peerId, true);
          await pc.setLocalDescription(); // implicit createOffer
          send({ type: "offer", to: peerId, payload: pc.localDescription!.toJSON() });
        } catch (err) {
          console.warn("[mesh] onnegotiationneeded failed", err);
        } finally {
          makingOfferRef.current.set(peerId, false);
        }
      };

      peerConnectionsRef.current.set(peerId, pc);
      return pc;
    },
    [send, closePeerConnection, setPeerAuthStatus],
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

      // Perfect-negotiation glare handling: the higher-id peer is "polite".
      // On a collision the impolite peer ignores the incoming offer (its own
      // offer wins); the polite peer yields (setRemoteDescription implicitly
      // rolls back its own offer in modern browsers).
      const meId = myIdRef.current ?? "";
      const polite = meId > from;
      const collision = makingOfferRef.current.get(from) === true || pc.signalingState !== "stable";
      if (!polite && collision) return; // impolite: ignore, our offer stands
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        // setRemoteDescription may have spun up new transceivers — apply
        // codec prefs before answering.
        preferEfficientVideoCodecs(pc);
        await pc.setLocalDescription(); // implicit createAnswer
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
    // Ignore a stray answer when we're not expecting one (glare aftermath).
    if (pc.signalingState !== "have-local-offer") return;
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
      /* stale candidate (or dropped during glare rollback) */
    }
  }, []);

  // Force an offer even with no local media — used by the watchdog to
  // re-establish a stuck connection so we can keep receiving a peer.
  const forceOffer = useCallback(
    async (peerId: string) => {
      const pc = peerConnectionsRef.current.get(peerId);
      if (!pc) return;
      try {
        makingOfferRef.current.set(peerId, true);
        await pc.setLocalDescription();
        send({ type: "offer", to: peerId, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] forceOffer failed", err);
      } finally {
        makingOfferRef.current.set(peerId, false);
      }
    },
    [send],
  );

  const publish = useCallback(
    (stream: MediaStream, kind: StreamKind, pubLabel: string) => {
      if (localStreamsRef.current.has(stream.id)) return;
      localStreamsRef.current.set(stream.id, { stream, kind });
      for (const pc of peerConnectionsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            const sender = pc.addTrack(track, stream);
            if (mediaKeyRef.current) encryptSender(sender, mediaKeyRef.current);
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
    let disposed = false;

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
      setPeerAuth({});
    };

    const transport = new RelayTransport(slug);
    transportRef.current = transport;

    // Prime the ICE config (TURN creds) before peers form. Best-effort:
    // falls back to STUN-only if the relay has no TURN configured.
    void fetchIceConfig(slug).then(cfg => {
      if (!disposed) iceConfigRef.current = cfg;
    });

    transport.start({
      onOpen: () => {
        connectedRef.current = true;
        setConnected(true);
        setConnectError(null);
        // Re-announce local streams (e.g. after reconnect).
        for (const [streamId, { kind }] of localStreamsRef.current) {
          transport.send({ type: "publish", streamId, kind, label: labelRef.current });
        }
      },
      onClose: reason => {
        connectedRef.current = false;
        setConnected(false);
        if (reason) setConnectError(reason);
        setMyId(null);
        myIdRef.current = null;
        teardownConnections();
        setPeers([]);
        setPublications([]);
      },
      onHello: (id, others, pubs) => {
        myIdRef.current = id;
        setMyId(id);
        setPeers([...others, { id, handle: labelRef.current }]);
        setPublications(pubs);
        teardownConnections();
        // Both peers create the connection; offers flow from
        // onnegotiationneeded and glare is handled politely.
        for (const peer of others) createPeerConnection(peer.id);
      },
      onPeerJoin: peer => {
        setPeers(prev => (prev.some(p => p.id === peer.id) ? prev : [...prev, peer]));
        createPeerConnection(peer.id);
      },
      onPeerLeave: peer => {
        setPeers(prev => prev.filter(p => p.id !== peer.id));
        closePeerConnection(peer.id);
      },
      onSignal: (from, kind, payload) => {
        if (kind === "offer") void handleOffer(from, payload as RTCSessionDescriptionInit);
        else if (kind === "answer") void handleAnswer(from, payload as RTCSessionDescriptionInit);
        else if (kind === "ice") void handleIce(from, payload as RTCIceCandidateInit);
      },
      onPublished: pub => {
        setPublications(prev => {
          const next = prev.filter(p => !(p.peerId === pub.peerId && p.streamId === pub.streamId));
          next.push(pub);
          return next;
        });
      },
      onUnpublished: (pid, sid) => {
        setPublications(prev => prev.filter(p => !(p.peerId === pid && p.streamId === sid)));
        setRemoteStreams(prev => {
          if (!prev.has(sid)) return prev;
          const next = new Map(prev);
          next.delete(sid);
          return next;
        });
      },
    });

    return () => {
      disposed = true;
      connectedRef.current = false;
      transport.close();
      transportRef.current = null;
      teardownConnections();
    };
  }, [enabled, slug, createPeerConnection, closePeerConnection, handleOffer, handleAnswer, handleIce]);

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
      if (!connectedRef.current) return;
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
        void forceOffer(pub.peerId);
      }
      for (const sid of missingSince.keys()) {
        if (!liveStreamIds.has(sid)) missingSince.delete(sid);
      }
    };
    const handle = setInterval(tick, STREAM_WATCHDOG_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [enabled, closePeerConnection, createPeerConnection, forceOffer]);

  return {
    myId,
    peers,
    connected,
    connectError,
    remoteStreams,
    publications,
    encrypted: mediaKey !== null && frameCryptoSupported(),
    peerAuth,
    publish,
    unpublish,
    replaceTrack,
    setCameraOff,
  };
}
