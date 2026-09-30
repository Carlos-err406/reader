import type { ReactNode } from "react";
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
