import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioSurface, DesktopBackground, DesktopIcon, LivePulse, TITLEBAR_HEIGHT, VideoSurface, Window, composeSkill, deriveRoomKeys, exportRoom, importRoom, useMesh, useSharedDesktop, type SlotPosition } from "@commons/os";
import { useLocalMedia, type LocalStreamHandle } from "./media/useLocalMedia";
import { WINDOW_APPS, type AppServices } from "./os/appkit";

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
  // Services handed to every window-app (fresh each render for live data; the
  // mesh's send/subscribe callbacks are stable so app effects don't churn).
  const services: AppServices = { slug, roomKey: busKey, label, mesh };
  const [muted, setMuted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [skillCopied, setSkillCopied] = useState(false);
  const [vaultMsg, setVaultMsg] = useState("");
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  // The SHARED desktop: window + icon geometry, z-order, which apps are open,
  // and minimize/maximize are room-global — synced over the encrypted bus and
  // persisted to the blob. One computer everyone sees (like slop.computer),
  // but the relay stays blind.
  const desk = useSharedDesktop(slug, busKey, mesh);
  // Remembers each window's pre-minimize height so restoring re-inflates it.
  const savedH = useRef<Record<string, number>>({});
  const copyInvite = useCallback(() => {
    // The full URL (incl. the #slug:secret fragment) IS the invite — the
    // secret rides the fragment, which never touches the server.
    void navigator.clipboard?.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  // Backup: export the whole encrypted room to a portable archive file. The
  // relay only ever held ciphertext, so this bundle can be restored onto ANY
  // Commons relay (or this one after a wipe) — operator-independent durability.
  const doBackup = useCallback(async () => {
    setVaultMsg("backing up…");
    try {
      const arc = await exportRoom(slug);
      const url = URL.createObjectURL(new Blob([JSON.stringify(arc, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `circle-${slug}-${arc.contentHash.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setVaultMsg(`backed up ${Object.keys(arc.blobs).length} items · ${arc.contentHash.slice(0, 8)}`);
      setTimeout(() => setVaultMsg(""), 3000);
    } catch (e) {
      setVaultMsg(`backup failed: ${(e as Error).message}`);
    }
  }, [slug]);

  const onRestoreFile = useCallback(
    async (file: File) => {
      setVaultMsg("restoring…");
      try {
        const arc = JSON.parse(await file.text());
        const { imported, total } = await importRoom(slug, arc);
        setVaultMsg(`restored ${imported}/${total} — reloading…`);
        setTimeout(() => location.reload(), 800);
      } catch (e) {
        setVaultMsg(`restore failed: ${(e as Error).message}`);
      }
    },
    [slug],
  );

  const copySkill = useCallback(() => {
    // The SKILL — a markdown brief that lets an agent operate this circle.
    // Composed client-side (relay stays blind) from the installed apps' own
    // skill sections + the invite link (its fragment carries the secret).
    const doc = composeSkill({ apps: WINDOW_APPS, inviteUrl: location.href });
    void navigator.clipboard?.writeText(doc).then(() => {
      setSkillCopied(true);
      setTimeout(() => setSkillCopied(false), 1500);
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

  // Desktop icons: media captures + app launchers. Double-click to open.
  const desktopIcons = [
    { id: "camera", icon: "📷", label: media.activeCamera ? "Stop Cam" : "Camera", act: () => (media.activeCamera ? media.stop("camera") : void media.startCamera()) },
    { id: "screen", icon: "🖥️", label: "Screen", act: () => void media.startScreen() },
    { id: "mic", icon: "🎙️", label: media.activeAudio ? "Stop Mic" : "Mic", act: () => (media.activeAudio ? media.stop("audio") : void media.startAudio()) },
    ...WINDOW_APPS.map(app => ({ id: app.id, icon: app.icon ?? "▢", label: app.label, act: () => desk.openWindow(app.id) })),
  ];

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
        <button onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</button>
        <button onClick={copyInvite}>{copied ? "Copied ✓" : "Invite"}</button>
        <button onClick={copySkill} title="Copy an agent brief for operating this circle">
          {skillCopied ? "Copied ✓" : "Skill"}
        </button>
        <button onClick={() => void doBackup()} data-testid="backup" title="Export the encrypted room — restore it onto any relay">
          Backup
        </button>
        <button onClick={() => restoreInputRef.current?.click()} title="Restore an exported room archive into this room">
          Restore
        </button>
        <input
          ref={restoreInputRef}
          type="file"
          accept="application/json"
          data-testid="restore-input"
          style={{ display: "none" }}
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) void onRestoreFile(f);
            e.target.value = "";
          }}
        />
        <button onClick={leave}>Leave</button>
        <span className="slop-menubar__status">
          {vaultMsg && <span data-testid="vault-msg">{vaultMsg}</span>}
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

        {/* Desktop icons — double-click / double-tap to open (positions shared). */}
        {desktopIcons.map((ic, i) => {
          const id = `icon-${ic.id}`;
          const def: SlotPosition = { id, x: 20, y: 58 + i * 92, width: 78, height: 82, z: 4 };
          const slot = desk.slots[id] ?? def;
          return (
            <DesktopIcon
              key={id}
              icon={ic.icon}
              label={ic.label}
              x={slot.x}
              y={slot.y}
              zIndex={slot.z}
              onOpen={ic.act}
              onFocus={() => desk.focus(slot)}
              onMove={({ x, y }) => desk.updateSlot({ ...slot, x, y })}
            />
          );
        })}

        {tiles.length === 0 && (
          <p className="desktop-hint">Nobody is sharing yet — double-click the Camera icon to circle up, then hit Invite and send the link to a friend.</p>
        )}

        {/* Shared media windows — geometry synced to everyone. */}
        {tiles.map(({ pub, mine, stream }, i) => {
          const id = pub.streamId;
          const def: SlotPosition = { id, x: 130 + (i % 5) * 42, y: 70 + (i % 5) * 44, width: 360, height: 280, z: 5 };
          const slot = desk.slots[id] ?? def;
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
              width={slot.width}
              height={slot.height}
              zIndex={slot.z}
              onFocus={() => desk.focus(slot)}
              onClose={mine ? () => media.stopById(id) : undefined}
              onMinimize={() => {
                savedH.current[id] = slot.height;
                desk.updateSlot({ ...slot, height: TITLEBAR_HEIGHT });
              }}
              onTitleClick={() => desk.updateSlot({ ...slot, height: savedH.current[id] ?? def.height })}
              onMove={({ x, y }) => desk.updateSlot({ ...slot, x, y })}
              onResize={({ x, y, width, height }) => desk.updateSlot({ ...slot, x, y, width, height })}
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

        {/* Shared app windows — open/close, geometry, minimize all synced. */}
        {WINDOW_APPS.filter(app => desk.openWindowIds.has(app.id)).map((app, i) => {
          const def: SlotPosition = { id: app.id, x: 150 + i * 40, y: 80 + i * 40, width: app.defaultSize.w, height: app.defaultSize.h, z: 6 };
          const slot = desk.slots[app.id] ?? def;
          const Comp = app.Component;
          return (
            <Window
              key={app.id}
              title={app.label.toUpperCase()}
              x={slot.x}
              y={slot.y}
              width={slot.width}
              height={slot.height}
              zIndex={slot.z}
              onFocus={() => desk.focus(slot)}
              onClose={() => desk.closeWindow(app.id)}
              onMinimize={() => {
                savedH.current[app.id] = slot.height;
                desk.updateSlot({ ...slot, height: TITLEBAR_HEIGHT });
              }}
              onTitleClick={() => desk.updateSlot({ ...slot, height: savedH.current[app.id] ?? def.height })}
              onMove={({ x, y }) => desk.updateSlot({ ...slot, x, y })}
              onResize={({ x, y, width, height }) => desk.updateSlot({ ...slot, x, y, width, height })}
              bodyStyle={{ padding: 0 }}
            >
              <Comp {...services} />
            </Window>
          );
        })}
      </div>
    </>
  );
}
