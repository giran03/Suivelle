import { useEffect, useState } from "react";
import { readProfile } from "./motion";

/**
 * Keeps something on screen long enough to play its exit. `value` is the live thing (or null once it is gone);
 * `item` is what to render, which stays the last value for `baseMs` (scaled by Settings > Motion) after it goes.
 * `leaving` is true during that wait, so the element can take its closing class.
 */
export function usePresence<T>(value: T | null, baseMs: number): { item: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setKept(value);
      return;
    }
    const timer = window.setTimeout(() => setKept(null), Math.round(baseMs * readProfile().time));
    return () => window.clearTimeout(timer);
  }, [value, baseMs]);
  const item = value ?? kept;
  return { item, leaving: value === null && item !== null };
}
