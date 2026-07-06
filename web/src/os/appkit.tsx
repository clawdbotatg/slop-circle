import { Chat } from "../apps/Chat";
import { Notes } from "../apps/Notes";
import { WalletPanel } from "../wallet/WalletPanel";
import type { WindowApp } from "@commons/app-kit";

// The app REGISTRY — circle's selection of apps over the base contract. The
// contract types (AppServices, WindowApp) now live in the @commons/app-kit
// package; re-export them so apps can keep importing from "../os/appkit".
// A product = this registry + a theme + backend wiring. Adding an app is one
// entry here; media capture + mute/invite/leave stay OS-level.
export type { AppServices, WindowApp } from "@commons/app-kit";

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
  {
    id: "wallet",
    label: "Wallet",
    defaultSize: { w: 420, h: 520 },
    Component: WalletPanel,
    skill: "Wallet is a passkey identity + personal wallet + shared multisig: propose a tx, co-sign to threshold, execute.",
  },
];
