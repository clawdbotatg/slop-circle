import { useMemo, useRef, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { Rnd } from "react-rnd";

// Slop UI kit ported from slop-computer-live's components/ui (Next-isms
// removed, trimmed to what circle needs): beveled Mac-OS-9 windows, buttons,
// fields, the live pulse, and the vaporwave desktop backdrop.

export function Button({
  variant = "default",
  className = "",
  children,
  ...rest
}: { variant?: "default" | "primary"; className?: string } & InputHTMLAttributes<HTMLButtonElement> & {
  onClick?: () => void;
}) {
  const cls = `slop-button${variant === "primary" ? " slop-button--primary" : ""} ${className}`.trim();
  return (
    <button className={cls} type="button" {...(rest as object)}>
      {children}
    </button>
  );
}

export function TextField({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`slop-textfield ${className}`.trim()} {...rest} />;
}

export function LivePulse({ live = true }: { live?: boolean }) {
  return <span className={`slop-pulse${live ? "" : " slop-pulse--off"}`} aria-hidden />;
}

export function DesktopBackground() {
  const stars = useMemo(
    () =>
      Array.from({ length: 100 }).map((_, i) => {
        const seed = (i * 9301 + 49297) % 233280;
        const r = seed / 233280;
        return { l: `${(r * 100).toFixed(2)}%`, t: `${(((seed * 7) % 9000) / 100).toFixed(2)}%`, s: r > 0.92 ? 2 : 1, o: r > 0.92 ? 0.85 : 0.5 };
      }),
    [],
  );
  return (
    <div className="slop-desktop-bg" aria-hidden>
      <div style={{ position: "absolute", inset: 0, background: "var(--commons-base)" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 70% 50% at 50% 30%, rgba(var(--commons-secondary-rgb), 0.12) 0%, transparent 70%)" }} />
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.45 }}>
        <defs>
          <pattern id="slop-dot" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="transparent" />
            <rect x="0" y="0" width="1" height="1" fill="rgb(var(--commons-secondary-rgb))" opacity="0.7" />
            <rect x="3" y="3" width="1" height="1" fill="rgb(var(--commons-accent-rgb))" opacity="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#slop-dot)" />
      </svg>
      <div style={{ position: "absolute", inset: 0 }}>
        {stars.map((s, i) => (
          <span key={i} style={{ position: "absolute", left: s.l, top: s.t, width: s.s, height: s.s, background: "#fff", opacity: s.o }} />
        ))}
      </div>
      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, transparent 0, transparent 2px, rgba(0,0,0,0.18) 2px, rgba(0,0,0,0.18) 3px)", mixBlendMode: "multiply" }} />
    </div>
  );
}

// A draggable desktop icon. Double-click (or double-tap on touch) to open.
// Position is controlled so it syncs across peers, like slop's desktop icons.
// The tap-count in onDragStop mirrors slop: touch devices drop synthetic
// dblclick (react-rnd captures the pointer), so we count releases within 400ms.
export function DesktopIcon({
  icon,
  label,
  x,
  y,
  zIndex = 4,
  onOpen,
  onFocus,
  onMove,
}: {
  icon: ReactNode;
  label: string;
  x: number;
  y: number;
  zIndex?: number;
  onOpen: () => void;
  onFocus?: () => void;
  onMove?: (p: { x: number; y: number }) => void;
}) {
  const dragMovedRef = useRef(false);
  const lastTapRef = useRef(0);
  const registerTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 400) {
      lastTapRef.current = 0;
      onOpen();
    } else {
      lastTapRef.current = now;
    }
  };
  return (
    <Rnd
      position={{ x, y }}
      size={{ width: 78, height: 82 }}
      bounds="parent"
      enableResizing={false}
      className="slop-icon"
      style={{ zIndex }}
      onMouseDown={onFocus}
      onDragStart={() => {
        dragMovedRef.current = false;
      }}
      onDrag={(_e, d) => {
        if (d.x !== x || d.y !== y) dragMovedRef.current = true;
      }}
      onDragStop={(_e, d) => {
        if (dragMovedRef.current) onMove?.({ x: d.x, y: d.y });
        else registerTap();
      }}
    >
      <div className="slop-icon__btn" onDoubleClick={onOpen} title={`Open ${label}`}>
        <span className="slop-icon__glyph" aria-hidden>
          {icon}
        </span>
        <span className="slop-icon__label">{label}</span>
      </div>
    </Rnd>
  );
}

function Dot({ kind, onClick }: { kind: "close" | "minimize" | "zoom"; onClick?: () => void }) {
  const glyph = kind === "close" ? "✕" : kind === "minimize" ? "–" : "+";
  const cls = `slop-titlebar__dot slop-titlebar__dot--${kind}${onClick ? "" : " slop-titlebar__dot--disabled"}`;
  // Fire on mousedown AND click (keyboard/synthetic), deduped — matches slop:
  // the titlebar is react-rnd's drag handle, so acting on mousedown avoids the
  // drag-init race that would otherwise need a second click.
  const firedRef = useRef(false);
  if (!onClick)
    return (
      <span className={cls} aria-hidden data-grab="false">
        {glyph}
      </span>
    );
  const fire = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (firedRef.current) return;
    firedRef.current = true;
    setTimeout(() => (firedRef.current = false), 0);
    onClick();
  };
  return (
    <span className={cls} role="button" data-grab="false" onMouseDown={fire} onClick={fire}>
      {glyph}
    </span>
  );
}

// Matches slop.computer's TITLEBAR_HEIGHT — the shared marker for "minimized":
// a window whose height <= this is rendered as a docked titlebar-only pill.
export const TITLEBAR_HEIGHT = 36;
const PILL_WIDTH = 220;

export type WindowProps = {
  title: ReactNode;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  active?: boolean;
  minWidth?: number;
  minHeight?: number;
  onFocus?: () => void;
  onClose?: () => void;
  /** Collapse to a pill — the parent sets height to TITLEBAR_HEIGHT (shared). */
  onMinimize?: () => void;
  /** Maximize/restore — the parent drives geometry through updateSlot so it
   *  syncs to every peer (slop's model). */
  onZoom?: () => void;
  /** Click the title while docked to restore — the parent restores height. */
  onTitleClick?: () => void;
  onMove?: (p: { x: number; y: number }) => void;
  onResize?: (s: { x: number; y: number; width: number; height: number }) => void;
  bodyStyle?: CSSProperties;
  children?: ReactNode;
};

// Draggable/resizable Mac-OS-9 window: drag by the titlebar, resize from the
// right/bottom/corner, click to focus. Controlled position + size. As in slop,
// "minimized" is derived from height (<= TITLEBAR_HEIGHT → a docked pill, click
// the title to restore) so it syncs through the slot geometry alone. Zoom
// (maximize to fill) is a local view toggle.
export function Window({
  title,
  x,
  y,
  width,
  height,
  zIndex = 1,
  active = true,
  minWidth = 200,
  minHeight = 140,
  onFocus,
  onClose,
  onMinimize,
  onZoom,
  onTitleClick,
  onMove,
  onResize,
  bodyStyle,
  children,
}: WindowProps) {
  const minimized = height <= TITLEBAR_HEIGHT; // slop's isDocked
  const pos = { x, y };
  const size = minimized ? { width: PILL_WIDTH, height: TITLEBAR_HEIGHT } : { width, height };
  return (
    <Rnd
      position={pos}
      size={size}
      minWidth={minimized ? PILL_WIDTH : minWidth}
      minHeight={minimized ? TITLEBAR_HEIGHT : minHeight}
      bounds="parent"
      dragHandleClassName="slop-titlebar"
      cancel=".slop-titlebar__dot"
      enableResizing={
        minimized
          ? false
          : { right: true, bottom: true, bottomRight: true, top: false, left: false, topLeft: false, topRight: false, bottomLeft: false }
      }
      className={`slop-window${minimized ? " slop-window--min" : ""}`}
      style={{ zIndex, display: "flex", flexDirection: "column", overflow: "hidden" }}
      onMouseDown={onFocus}
      onDragStop={(_e, d) => onMove?.({ x: d.x, y: d.y })}
      onResizeStop={(_e, _dir, ref, _delta, p) => onResize?.({ x: p.x, y: p.y, width: ref.offsetWidth, height: ref.offsetHeight })}
      resizeHandleStyles={{
        bottomRight: {
          width: 20,
          height: 20,
          right: 0,
          bottom: 0,
          background: "repeating-linear-gradient(135deg, var(--commons-bevel-light) 0, var(--commons-bevel-light) 1px, transparent 1px, transparent 3px)",
        },
      }}
    >
      <div className={`slop-titlebar ${active ? "slop-titlebar--active" : ""}`} data-grab="true">
        <div className="slop-titlebar__dots" data-grab="false">
          <Dot kind="close" onClick={onClose} />
          <Dot kind="minimize" onClick={onMinimize} />
          <Dot kind="zoom" onClick={onZoom} />
        </div>
        <div
          className="slop-titlebar__title"
          onDoubleClick={onZoom}
          onClick={minimized ? onTitleClick : undefined}
          style={minimized ? { cursor: "pointer" } : undefined}
          title={minimized ? "Click to restore" : undefined}
        >
          {title}
        </div>
      </div>
      {!minimized && (
        <div style={{ flex: 1, minHeight: 0, background: "var(--commons-panel)", color: "var(--commons-text)", overflow: "auto", ...bodyStyle }}>
          {children}
        </div>
      )}
    </Rnd>
  );
}
