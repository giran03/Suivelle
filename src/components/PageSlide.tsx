import { useRef } from "react";

/**
 * Content that slides in from the side its page sits on when `page` changes (the transitions.dev page side-by-side):
 * later pages in `order` arrive from the right, earlier ones from the left. Nothing moves on the first render.
 */
export function PageSlide({ page, order, children }: { page: string; order: readonly string[]; children: React.ReactNode }) {
  const shown = useRef(page);
  const dir = useRef<"next" | "prev" | undefined>(undefined);
  if (shown.current !== page) {
    dir.current = order.indexOf(page) >= order.indexOf(shown.current) ? "next" : "prev";
    shown.current = page;
  }
  return (
    <div key={page} className="t-page" data-dir={dir.current}>
      {children}
    </div>
  );
}
