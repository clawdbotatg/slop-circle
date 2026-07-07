import type { ComponentType } from "react";

// @commons/app-kit — the contract an app is written against. The base OS renders
// launchers + manages windows purely from apps that satisfy this; products
// (circle, and later slop.computer) select which apps to register. This is
// the seam of the base platform (see BASE-PLAN.md); it lives in its own
// package so any product can depend on it without pulling in a specific app
// set or theme.

/** Services every app receives. Interfaces only — the product supplies the
 *  implementation (circle wires its E2EE mesh + relay behind these). */
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
  /** Desktop-icon glyph (emoji; rendered greyscale). */
  icon?: string;
  defaultSize: { w: number; h: number };
  Component: ComponentType<AppServices>;
  /** Agent instructions for operating this app — composed into the SKILL. */
  skill?: string;
};
