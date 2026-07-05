import { join } from "node:path";
import type { WebSocket } from "ws";
import { RoomAuth } from "./room-auth.js";
import { send } from "./send.js";

export type StreamKind = "camera" | "screen" | "audio";

export type PeerInfo = {
  id: string; // ephemeral: randomBytes(8).hex per WS connection
  handle: string | null;
  connectedAt: number;
};

export type Peer = PeerInfo & { ws: WebSocket };

export type Publication = {
  streamId: string;
  peerId: string;
  kind: StreamKind;
  label: string;
  cameraOff?: boolean;
};

const SLUG_REGEX = /^[a-z0-9-]{1,64}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

export class Room {
  readonly auth: RoomAuth;
  private peers = new Map<string, Peer>();
  private publicationsByPeer = new Map<string, Publication[]>();

  constructor(
    readonly slug: string,
    readonly dataDir: string,
  ) {
    this.auth = new RoomAuth(join(dataDir, "rooms", slug, "auth.json"));
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  removePeer(id: string): void {
    this.peers.delete(id);
  }

  listPeers(): PeerInfo[] {
    // Strip ws so only public PeerInfo goes over the wire.
    return [...this.peers.values()].map(({ ws: _ws, ...info }) => info);
  }

  broadcast(msg: unknown, exceptId?: string): void {
    for (const [id, peer] of this.peers) {
      if (exceptId && id === exceptId) continue;
      send(peer.ws, msg);
    }
  }

  /** Returns false if the target peer isn't in this room. */
  sendTo(targetId: string, msg: unknown): boolean {
    const peer = this.peers.get(targetId);
    if (!peer) return false;
    send(peer.ws, msg);
    return true;
  }

  listPublications(): Publication[] {
    const out: Publication[] = [];
    for (const list of this.publicationsByPeer.values()) out.push(...list);
    return out;
  }

  publish(p: Publication): void {
    const list = this.publicationsByPeer.get(p.peerId) ?? [];
    const next = list.filter(x => x.streamId !== p.streamId); // de-dupe by streamId
    next.push(p);
    this.publicationsByPeer.set(p.peerId, next);
  }

  unpublish(peerId: string, streamId: string): boolean {
    const list = this.publicationsByPeer.get(peerId);
    if (!list) return false;
    const next = list.filter(x => x.streamId !== streamId);
    if (next.length === list.length) return false;
    if (next.length === 0) this.publicationsByPeer.delete(peerId);
    else this.publicationsByPeer.set(peerId, next);
    return true;
  }

  setCameraOff(peerId: string, streamId: string, off: boolean): Publication | null {
    const list = this.publicationsByPeer.get(peerId);
    if (!list) return null;
    const pub = list.find(p => p.streamId === streamId);
    if (!pub) return null;
    pub.cameraOff = off; // mutated in place so listPublications() carries it
    return pub;
  }

  findPublicationOwner(streamId: string): string | null {
    for (const [peerId, list] of this.publicationsByPeer) {
      if (list.some(p => p.streamId === streamId)) return peerId;
    }
    return null;
  }

  clearPeerPublications(peerId: string): Publication[] {
    const list = this.publicationsByPeer.get(peerId) ?? [];
    this.publicationsByPeer.delete(peerId);
    return list; // caller broadcasts an "unpublished" per entry
  }
}

const rooms = new Map<string, Room>();

export function getOrCreateRoom(slug: string, dataDir: string): Room {
  let room = rooms.get(slug);
  if (!room) {
    room = new Room(slug, dataDir);
    rooms.set(slug, room);
  }
  return room;
}
