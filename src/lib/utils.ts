import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Drops the click that follows a gesture which already did its job: a tap outside a menu that
 * closed it, or a drag that selected books. Otherwise the click lands on whatever is under the
 * finger and opens it.
 */
export function swallowNextClick(within = 600) {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  const done = () => {
    window.removeEventListener("click", swallow, { capture: true });
    clearTimeout(timer);
  };
  window.addEventListener("click", swallow, { capture: true });
  const timer = setTimeout(done, within);
}
