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
