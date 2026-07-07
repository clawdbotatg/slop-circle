// @commons/os — the base client OS. Framework-agnostic React that a product
// (circle, and later slop.computer) builds its desktop + apps on:
//   • ui/slop     — window manager, beveled Mac-OS-9 chrome, desktop bg
//   • ui/StreamView — media surfaces (camera/screen/audio)
//   • mesh        — full-mesh WebRTC: media + encrypted bus + peer-auth
//   • crypto      — room-key derivation, frame + bus encryption
//   • blob        — the encrypted blob-store client (durable peer state)
// The app contract itself lives in @commons/app-kit; products supply the theme,
// the app registry, and the backend wiring behind these.

export * from "./ui/slop";
export * from "./ui/StreamView";
export * from "./mesh/useMesh";
export * from "./crypto/roomKeys";
export * from "./blob";
export * from "./checkpoint";
export * from "./skill";
