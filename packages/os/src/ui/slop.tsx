import { useMemo, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
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

function Dot({ kind, onClick }: { kind: "close" | "minimize" | "zoom"; onClick?: () => void }) {
  const glyph = kind === "close" ? "✕" : kind === "minimize" ? "–" : "+";
  const cls = `slop-titlebar__dot slop-titlebar__dot--${kind}${onClick ? "" : " slop-titlebar__dot--disabled"}`;
  const fire = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onClick?.();
  };
  return (
    <span className={cls} data-grab="false" onMouseDown={onClick ? fire : undefined}>
      {glyph}
    </span>
  );
}

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
  onMove?: (p: { x: number; y: number }) => void;
  onResize?: (s: { x: number; y: number; width: number; height: number }) => void;
  bodyStyle?: CSSProperties;
  children?: ReactNode;
};

// Draggable/resizable Mac-OS-9 window: drag by the titlebar, resize from the
// right/bottom/corner, click to focus. Controlled position + size.
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
  onMove,
  onResize,
  bodyStyle,
  children,
}: WindowProps) {
  return (
    <Rnd
      position={{ x, y }}
      size={{ width, height }}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="parent"
      dragHandleClassName="slop-titlebar"
      cancel=".slop-titlebar__dot"
      enableResizing={{ right: true, bottom: true, bottomRight: true, top: false, left: false, topLeft: false, topRight: false, bottomLeft: false }}
      className="slop-window"
      style={{ zIndex, display: "flex", flexDirection: "column", overflow: "hidden" }}
      onMouseDown={onFocus}
      onDragStop={(_e, d) => onMove?.({ x: d.x, y: d.y })}
      onResizeStop={(_e, _dir, ref, _delta, pos) => onResize?.({ x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight })}
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
          <Dot kind="minimize" />
          <Dot kind="zoom" />
        </div>
        <div className="slop-titlebar__title">{title}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: "var(--commons-panel)", color: "var(--commons-text)", overflow: "auto", ...bodyStyle }}>
        {children}
      </div>
    </Rnd>
  );
}
