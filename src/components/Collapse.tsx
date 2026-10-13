import { useEffect, useState } from "react";
import { usePresence } from "../lib/presence";

/**
 * A region that opens and closes in height (the transitions.dev accordion): a one-row grid goes between 0fr and 1fr,
 * so no height is ever measured. The content stays mounted while it leaves, and is inert while it is not open.
 */
export function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const { item } = usePresence(open ? true : null, 250);
  // Mount closed, then open on the next frame, so a region that appears opened has something to grow from.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!item && !open) return null;
  return (
    <div className="t-acc-panel" data-open={shown}>
      <div className="t-acc-panel-inner" inert={!shown}>
        {children}
      </div>
    </div>
  );
}
