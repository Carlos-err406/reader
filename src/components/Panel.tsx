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
  children: ReactNode;
}

/** A bottom sheet on phones and a side sheet on wide windows. Closes on outside click or Escape. */
export function Panel({ open, onOpenChange, title, description, children }: Props) {
  const wide = useMedia("(min-width: 640px)");
  useBackCloses(open, onOpenChange);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={wide ? "right" : "bottom"}
        className={cn(
          "gap-0 bg-card",
          wide ? "w-[400px] sm:max-w-[400px]" : "max-h-[88dvh] rounded-t-2xl",
        )}
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="font-serif text-xl">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Android's back button walks the history. An open panel is a history entry of its own, so
 * back closes the panel instead of leaving the book or the library underneath it.
 */
function useBackCloses(open: boolean, onOpenChange: (open: boolean) => void) {
  const close = useRef(onOpenChange);
  close.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    const id = Math.random().toString(36).slice(2);
    history.pushState({ ...history.state, panel: id }, "");
    const back = () => close.current(false);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
      // Closed some other way (the X, a tap outside): drop the panel's entry.
      if (history.state?.panel === id) history.back();
    };
  }, [open]);
}
