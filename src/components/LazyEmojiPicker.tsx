import { lazy, Suspense } from "react";
import type { EmojiPickerProps } from "./EmojiPicker";

const Picker = lazy(() => import("./EmojiPicker"));
export function EmojiPicker(props: EmojiPickerProps) {
  return <Suspense fallback={<p role="status">Loading emojis…</p>}><Picker {...props} /></Suspense>;
}
