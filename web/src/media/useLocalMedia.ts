import { useCallback, useRef, useState } from "react";

// Adapted from slop-computer-live useLocalMedia.ts (v0: no RNNoise denoise —
// publish the raw stream; the denoise pipeline is separable and can return
// in a later phase).

export type StreamKind = "camera" | "screen" | "audio";

export type LocalStreamHandle = {
  id: string;
  kind: StreamKind;
  stream: MediaStream;
};

export type CameraResolution = "auto" | "480p" | "720p" | "1080p";

export const MEDIA_PREF_KEYS = {
  micId: "circle-pref-mic-id",
  cameraId: "circle-pref-camera-id",
  cameraRes: "circle-pref-camera-res",
} as const;

const readPref = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const buildAudioConstraints = (micId: string | null): MediaTrackConstraints => ({
  ...(micId ? { deviceId: { exact: micId } } : {}),
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  ...({ voiceIsolation: true } as Record<string, boolean>),
});

export const resolutionConstraints = (res: string | null): MediaTrackConstraints => {
  switch (res) {
    case "1080p":
      return { width: { ideal: 1920 }, height: { ideal: 1080 } };
    case "720p":
      return { width: { ideal: 1280 }, height: { ideal: 720 } };
    case "480p":
      return { width: { ideal: 640 }, height: { ideal: 480 } };
    default:
      // No explicit preference → 480p-ish so first-time users don't burn
      // CPU on 1080p the encoder scales down anyway.
      return { width: { ideal: 854 }, height: { ideal: 480 } };
  }
};

// getUserMedia with device-fallback retry: a remembered deviceId can vanish
// (unplugged webcam); strip it and retry rather than failing the share.
const tryGetUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    const fallback: MediaStreamConstraints = {};
    if (constraints.audio && typeof constraints.audio === "object") {
      const a = { ...(constraints.audio as MediaTrackConstraints) };
      delete (a as Record<string, unknown>).deviceId;
      fallback.audio = Object.keys(a).length ? a : true;
    } else if (constraints.audio) {
      fallback.audio = constraints.audio;
    }
    if (constraints.video && typeof constraints.video === "object") {
      const v = { ...(constraints.video as MediaTrackConstraints) };
      delete (v as Record<string, unknown>).deviceId;
      fallback.video = Object.keys(v).length ? v : true;
    } else if (constraints.video) {
      fallback.video = constraints.video;
    }
    return await navigator.mediaDevices.getUserMedia(fallback);
  }
};

type ActiveIds = { camera: string | null; screen: string[]; audio: string | null };

export function useLocalMedia(
  addStream: (h: LocalStreamHandle) => void,
  stopStream: (id: string) => void,
) {
  const [activeIds, setActiveIds] = useState<ActiveIds>({ camera: null, screen: [], audio: null });
  const [busy, setBusy] = useState<StreamKind | null>(null);
  const [error, setError] = useState("");
  const inFlightRef = useRef<{ camera: boolean; audio: boolean }>({ camera: false, audio: false });

  const acquire = useCallback(
    async (kind: StreamKind, getStream: () => Promise<MediaStream>) => {
      // Camera/audio are single-slot: bail if running or mid-acquisition.
      if (kind !== "screen" && (activeIds[kind] || inFlightRef.current[kind])) return true;
      if (kind !== "screen") inFlightRef.current[kind] = true;
      setError("");
      setBusy(kind);
      try {
        const stream = await getStream();
        const handle: LocalStreamHandle = { id: stream.id, kind, stream };
        setActiveIds(s =>
          kind === "screen" ? { ...s, screen: [...s.screen, handle.id] } : { ...s, [kind]: handle.id },
        );
        addStream(handle);
        // Browser-side stop (picker closed, device revoked) → local cleanup
        // once every track has ended.
        stream.getTracks().forEach(t =>
          t.addEventListener("ended", () => {
            if (stream.getTracks().every(x => x.readyState === "ended")) {
              setActiveIds(s =>
                kind === "screen"
                  ? { ...s, screen: s.screen.filter(x => x !== handle.id) }
                  : { ...s, [kind]: null },
              );
              stopStream(handle.id);
            }
          }),
        );
        return true;
      } catch (e) {
        setError(`${kind}: ${(e as Error).message}`);
        return false;
      } finally {
        setBusy(null);
        if (kind !== "screen") inFlightRef.current[kind] = false;
      }
    },
    [activeIds, addStream, stopStream],
  );

  const startCamera = useCallback(
    () =>
      acquire("camera", () => {
        const cameraId = readPref(MEDIA_PREF_KEYS.cameraId);
        const res = readPref(MEDIA_PREF_KEYS.cameraRes);
        const micId = readPref(MEDIA_PREF_KEYS.micId);
        const video: MediaTrackConstraints = {
          ...resolutionConstraints(res),
          ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
        };
        // Camera bundles the mic so peers hear the speaker through the same
        // tile they see them in.
        return tryGetUserMedia({ video, audio: buildAudioConstraints(micId) });
      }),
    [acquire],
  );

  const startScreen = useCallback(
    () => acquire("screen", () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })),
    [acquire],
  );

  const startAudio = useCallback(
    () =>
      acquire("audio", () => {
        const micId = readPref(MEDIA_PREF_KEYS.micId);
        return tryGetUserMedia({ video: false, audio: buildAudioConstraints(micId) });
      }),
    [acquire],
  );

  const stopKind = useCallback(
    (kind: StreamKind) => {
      setActiveIds(s => {
        const ids = kind === "screen" ? s.screen : s[kind] ? [s[kind]!] : [];
        ids.forEach(id => stopStream(id));
        return kind === "screen" ? { ...s, screen: [] } : { ...s, [kind]: null };
      });
    },
    [stopStream],
  );

  const stopById = useCallback(
    (id: string) => {
      setActiveIds(s => ({
        camera: s.camera === id ? null : s.camera,
        audio: s.audio === id ? null : s.audio,
        screen: s.screen.filter(x => x !== id),
      }));
      stopStream(id);
    },
    [stopStream],
  );

  return {
    startCamera,
    startScreen,
    startAudio,
    stop: stopKind,
    stopById,
    activeCamera: activeIds.camera,
    activeAudio: activeIds.audio,
    activeScreens: activeIds.screen,
    busy,
    error,
  };
}
