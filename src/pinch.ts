export interface Focal {
  x: number;
  y: number;
}

export interface PinchHandlers {
  /** Live scale relative to the start of the gesture, for a preview. */
  onChange?: (scale: number, focal: Focal) => void;
  /** The gesture finished; commit `scale`. */
  onEnd: (scale: number, focal: Focal) => void;
}

type Target = HTMLElement | Document;

const point = (target: Target, x: number, y: number): Focal => {
  // Chapter documents come from other frames, so `instanceof Document` can't be trusted.
  if (!("getBoundingClientRect" in target)) return { x, y };
  const rect = target.getBoundingClientRect();
  return { x: x - rect.left, y: y - rect.top };
};

/**
 * Pinch zoom from every source a reader might use: two fingers on a touchscreen, a trackpad
 * pinch in Chromium (sent as Ctrl+wheel) and a trackpad pinch in WebKit (gesture events).
 * The focal point is relative to `target`. Returns a cleanup function.
 */
export function attachPinch(target: Target, handlers: PinchHandlers): () => void {
  let start = 0;
  let scale = 1;
  let focal: Focal = { x: 0, y: 0 };
  let active = false;

  const distance = (e: TouchEvent) => {
    const [a, b] = [e.touches[0]!, e.touches[1]!];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  const touchStart = (e: Event) => {
    const t = e as TouchEvent;
    if (t.touches.length !== 2) return;
    start = distance(t);
    scale = 1;
    active = true;
    focal = point(target, (t.touches[0]!.clientX + t.touches[1]!.clientX) / 2, (t.touches[0]!.clientY + t.touches[1]!.clientY) / 2);
  };
  const touchMove = (e: Event) => {
    const t = e as TouchEvent;
    if (!active || t.touches.length !== 2 || !start) return;
    t.preventDefault();
    scale = distance(t) / start;
    handlers.onChange?.(scale, focal);
  };
  const touchEnd = (e: Event) => {
    if (!active || (e as TouchEvent).touches.length >= 2) return;
    active = false;
    handlers.onEnd(scale, focal);
  };

  // WebKit trackpad pinch.
  let gesturing = false;
  const gestureStart = (e: Event) => {
    e.preventDefault();
    gesturing = true;
    const g = e as unknown as { clientX: number; clientY: number };
    focal = point(target, g.clientX, g.clientY);
  };
  const gestureChange = (e: Event) => {
    e.preventDefault();
    scale = (e as unknown as { scale: number }).scale;
    handlers.onChange?.(scale, focal);
  };
  const gestureEnd = (e: Event) => {
    e.preventDefault();
    gesturing = false;
    handlers.onEnd((e as unknown as { scale: number }).scale, focal);
    scale = 1;
  };

  // Chromium trackpad pinch: Ctrl+wheel, finished once the wheel goes quiet.
  let wheelScale = 1;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const wheel = (e: Event) => {
    const w = e as WheelEvent;
    if (!w.ctrlKey || gesturing) return;
    w.preventDefault();
    if (!wheelTimer) {
      wheelScale = 1;
      focal = point(target, w.clientX, w.clientY);
    }
    wheelScale *= Math.exp(-w.deltaY / 100);
    handlers.onChange?.(wheelScale, focal);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = undefined;
      handlers.onEnd(wheelScale, focal);
    }, 220);
  };

  const listeners: [string, EventListener][] = [
    ["touchstart", touchStart],
    ["touchmove", touchMove],
    ["touchend", touchEnd],
    ["touchcancel", touchEnd],
    ["gesturestart", gestureStart],
    ["gesturechange", gestureChange],
    ["gestureend", gestureEnd],
    ["wheel", wheel],
  ];
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { passive: false });
  return () => {
    clearTimeout(wheelTimer);
    for (const [type, listener] of listeners) target.removeEventListener(type, listener);
  };
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));

/** Zoom buttons move in comfortable steps and snap back to 100% on the way through. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const next = direction > 0 ? steps.find((s) => s > zoom + 0.001) : [...steps].reverse().find((s) => s < zoom - 0.001);
  return next ?? zoom;
}
