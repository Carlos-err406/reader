import { useEffect, useState } from "react";

/** How far the finger must drag (after damping) before releasing syncs. */
export const PULL_THRESHOLD = 70;
const MAX_PULL = 120;

/** Pull down from the top of the page to run `onSync`. Returns the current (damped) pull distance. */
export function usePullToSync(onSync: () => void, enabled: boolean): number {
  const [pull, setPull] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let startY: number | null = null;
    let distance = 0;
    const start = (e: TouchEvent) => {
      // Only a drag that begins at the very top counts, so normal scrolling is untouched.
      startY = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null;
      distance = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY === null) return;
      distance = Math.min(MAX_PULL, Math.max(0, (e.touches[0]!.clientY - startY) * 0.5));
      setPull(distance);
    };
    const end = () => {
      if (startY !== null && distance >= PULL_THRESHOLD) onSync();
      startY = null;
      distance = 0;
      setPull(0);
    };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  }, [enabled, onSync]);

  return pull;
}
