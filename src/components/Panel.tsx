import { useEffect, useRef, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMedia } from "@/hooks/useMedia";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Read by screen readers; not shown. */
  description: string;
  /** Focus the first field on opening, keyboard and all: for sheets that exist to type into. */
  focusField?: boolean;
  children: ReactNode;
}

/** A bottom sheet on phones and a side sheet on wide windows. Closes on outside click or Escape. */
export function Panel({ open, onOpenChange, title, description, focusField = false, children }: Props) {
  const wide = useMedia("(min-width: 640px)");
  useBackCloses(open, onOpenChange);
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useSwipeDown(open && !wide, sheet, body, onOpenChange);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={sheet}
        side={wide ? "right" : "bottom"}
        // On a phone, focusing a text field would raise the keyboard over the sheet just for
        // opening it; focus the sheet itself until a field is tapped.
        onOpenAutoFocus={(e) => {
          if (wide || focusField) return;
          e.preventDefault();
          sheet.current?.focus();
        }}
        className={cn(
          "gap-0 bg-card",
          wide ? "w-[400px] sm:max-w-[400px]" : "max-h-[88dvh] rounded-t-2xl",
        )}
      >
        {!wide && <div className="mx-auto mt-2 -mb-2 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />}
        <SheetHeader className="pb-2">
          <SheetTitle className="font-serif text-xl">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        <div ref={body} className="grid gap-5 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Android's back button walks the history. An open panel (or a mode like selecting books) is a
 * history entry of its own, so back closes it instead of leaving the book or the library.
 */
export function useBackCloses(open: boolean, onOpenChange: (open: boolean) => void) {
  const close = useRef(onOpenChange);
  close.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    const id = Math.random().toString(36).slice(2);
    // One panel replacing another (a menu opening a settings sheet) takes over its entry.
    if (leaving !== null) {
      clearTimeout(leaving);
      leaving = null;
      history.replaceState({ ...history.state, panel: id }, "");
    } else history.pushState({ ...history.state, panel: id }, "");
    // Back closes this only when it leaves this entry: a panel opened on top of this one going
    // back to it is no reason to close.
    const back = () => history.state?.panel !== id && close.current(false);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
      // Closed some other way (the X, a tap outside): drop the panel's entry, unless another
      // panel opens right away and reuses it.
      if (history.state?.panel === id) {
        leaving = setTimeout(() => {
          leaving = null;
          history.back();
        }, 0);
      }
    };
  }, [open]);
}

let leaving: ReturnType<typeof setTimeout> | null = null;

/**
 * A bottom sheet follows a finger dragging it down, and closes when let go far or fast enough.
 * The drag starts from the header, or from the content once it's scrolled to the top, so
 * scrolling the content and moving sliders work as usual.
 */
function useSwipeDown(
  enabled: boolean,
  sheet: React.RefObject<HTMLDivElement | null>,
  body: React.RefObject<HTMLDivElement | null>,
  onOpenChange: (open: boolean) => void,
) {
  const close = useRef(onOpenChange);
  close.current = onOpenChange;
  useEffect(() => {
    // The sheet mounts with the dialog, a frame after it opens.
    let frame = requestAnimationFrame(attach);
    let detach = () => {};
    function attach() {
      const el = sheet.current;
      if (!enabled || !el) {
        if (enabled) frame = requestAnimationFrame(attach);
        return;
      }
      let start: { x: number; y: number; t: number } | null = null;
      let dragging = false;
      let dy = 0;
      // `translate`, not `transform`: the closing slide animates `transform`, so it carries on
      // from where the finger left the sheet.
      const place = (y: number, animate: boolean) => {
        el.style.transition = animate ? "translate 200ms ease-out" : "none";
        el.style.translate = y > 0 ? `0 ${y}px` : "";
      };
      const down = (e: TouchEvent) => {
        const target = e.target as Element;
        const scrolled = body.current?.contains(target) && body.current.scrollTop > 0;
        const control = target.closest('input, textarea, select, [role="slider"]');
        start = e.touches.length === 1 && !scrolled && !control ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, t: Date.now() } : null;
        dragging = false;
        dy = 0;
      };
      const move = (e: TouchEvent) => {
        if (!start) return;
        const x = e.touches[0]!.clientX - start.x;
        const y = e.touches[0]!.clientY - start.y;
        if (!dragging) {
          // Decide once the finger has moved a little: down and mostly vertical is a dismiss.
          if (Math.hypot(x, y) < 8) return;
          if (y <= 0 || Math.abs(x) > Math.abs(y)) {
            start = null;
            return;
          }
          dragging = true;
        }
        e.preventDefault();
        dy = Math.max(0, y);
        place(dy, false);
      };
      const up = () => {
        if (!start || !dragging) return;
        const speed = dy / Math.max(1, Date.now() - start.t);
        start = null;
        dragging = false;
        if (dy > Math.min(140, el.offsetHeight / 3) || speed > 0.6) close.current(false);
        else place(0, true);
      };
      el.addEventListener("touchstart", down, { passive: true });
      el.addEventListener("touchmove", move, { passive: false });
      el.addEventListener("touchend", up);
      el.addEventListener("touchcancel", up);
      detach = () => {
        el.removeEventListener("touchstart", down);
        el.removeEventListener("touchmove", move);
        el.removeEventListener("touchend", up);
        el.removeEventListener("touchcancel", up);
      };
    }
    return () => {
      cancelAnimationFrame(frame);
      detach();
    };
  }, [enabled, sheet, body]);
}
