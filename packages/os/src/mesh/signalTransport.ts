// The signaling channel behind an interface, so the relay is just
// implementation #1. A Waku transport (gossip topic derived from the room)
// and a copy-paste-SDP transport can slot in later without touching mesh
// logic — the mesh only ever sees opaque routed messages and typed events.
//
// Everything a signal carries (SDP, ICE, publication metadata) is already
// safe for an untrusted transport to see: media is E2E-encrypted and peers
// authenticate each other directly (see peerAuth). The transport is dumb
// routing.

import type { Peer, Publication } from "./meshTypes";

export type SignalHandlers = {
  /** Connected (or reconnected) — re-announce local publications. */
  onOpen: () => void;
  /** Disconnected. reason is a gate error (terminal, no reconnect) or null. */
  onClose: (reason: string | null) => void;
  onHello: (id: string, peers: Peer[], publications: Publication[]) => void;
  onPeerJoin: (peer: Peer) => void;
  onPeerLeave: (peer: Peer) => void;
  onSignal: (from: string, kind: string, payload: unknown) => void;
  onPublished: (pub: Publication) => void;
  onUnpublished: (peerId: string, streamId: string) => void;
  /** Encrypted group message from another peer (opaque ciphertext string). */
  onRoomMsg: (from: string, payload: string) => void;
};

export interface SignalTransport {
  start(handlers: SignalHandlers): void;
  send(msg: object): void;
  close(): void;
}

const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 2000;

// Terminal WS close codes → a reason string; anything else reconnects.
const GATE_CLOSE_CODES: Record<number, string> = {
  4401: "unauthenticated",
  4403: "room-auth-required",
  4404: "room-not-found",
};

export class RelayTransport implements SignalTransport {
  private ws: WebSocket | null = null;
  private handlers: SignalHandlers | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  constructor(private readonly slug: string) {}

  start(handlers: SignalHandlers): void {
    this.handlers = handlers;
    this.connect();
  }

  send(msg: object): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.cancelled = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.cancelled) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/signal?slug=${encodeURIComponent(this.slug)}`);
    this.ws = ws;
    const h = this.handlers!;

    ws.onopen = () => {
      if (this.cancelled) return;
      ws.send(JSON.stringify({ type: "hello" }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
      h.onOpen();
    };

    ws.onmessage = ev => {
      if (this.cancelled) return;
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      switch (msg.type) {
        case "hello":
          if (typeof msg.id === "string" && Array.isArray(msg.peers)) {
            h.onHello(msg.id, msg.peers as Peer[], Array.isArray(msg.publications) ? (msg.publications as Publication[]) : []);
          }
          return;
        case "peer_join":
          if (msg.peer) h.onPeerJoin(msg.peer as Peer);
          return;
        case "peer_leave":
          if (msg.peer) h.onPeerLeave(msg.peer as Peer);
          return;
        case "signal":
          if (typeof msg.kind === "string" && typeof msg.from === "string") {
            h.onSignal(msg.from, msg.kind, msg.payload);
          }
          return;
        case "published":
          if (msg.publication) h.onPublished(msg.publication as Publication);
          return;
        case "unpublished":
          if (typeof msg.peerId === "string" && typeof msg.streamId === "string") {
            h.onUnpublished(msg.peerId, msg.streamId);
          }
          return;
        case "room_msg":
          if (typeof msg.from === "string" && typeof msg.payload === "string") {
            h.onRoomMsg(msg.from, msg.payload);
          }
          return;
        // pong and unknown types: ignore.
      }
    };

    ws.onclose = ev => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      const reason = GATE_CLOSE_CODES[ev.code] ?? null;
      if (reason) this.cancelled = true;
      h.onClose(reason);
      if (this.cancelled) return;
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }
}
