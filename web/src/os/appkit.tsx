import type { ComponentType } from "react";
import { Chat } from "../apps/Chat";
import { Notes } from "../apps/Notes";

// The app-kit contract — the seam that turns circle into a base OS. An app is
// a self-contained plugin; the desktop renders launchers + manages windows
// purely from this registry, so *adding an app is one entry here*, no core
// edits. (Media capture — camera/screen/audio — and OS chrome — mute/invite/
// leave — stay OS-level; this registry is for the apps proper.)
//
// This is the extraction point: `appkit` + the registered apps become
// `@slop/app-kit` + `@slop/app-*` packages when the base is split out.

// Services every app receives (interfaces; the product supplies the impl —
// circle wires its E2EE mesh + relay behind these).
export type AppServices = {
  slug: string;
  /** Room key for the encrypted bus + blob store. Never leaves the browser. */
  roomKey: ArrayBuffer;
  /** This member's display name. */
  label: string;
  mesh: {
    sendRoomMessage: (obj: unknown) => void;
    addRoomMessageListener: (fn: (from: string, obj: unknown) => void) => () => void;
    peers: { id: string; handle: string | null }[];
  };
};

/** A window-app renders a component inside an OS-managed draggable Window. */
export type WindowApp = {
  id: string;
  label: string;
  defaultSize: { w: number; h: number };
  Component: ComponentType<AppServices>;
  /** Agent instructions for operating this app — composed into the SKILL. */
  skill?: string;
};

export const WINDOW_APPS: WindowApp[] = [
  {
    id: "notes",
    label: "Notes",
    defaultSize: { w: 380, h: 320 },
    Component: Notes,
    skill: "Notes is a shared room notepad. Read/append text; edits sync to everyone and persist.",
  },
  {
    id: "chat",
    label: "Chat",
    defaultSize: { w: 340, h: 380 },
    Component: Chat,
    skill: "Chat sends a line to everyone in the room over the encrypted bus.",
  },
];
