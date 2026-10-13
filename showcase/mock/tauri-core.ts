import { handle } from "./backend";
export class Channel<T> { onmessage: (message: T) => void = () => undefined; }

/** Stand-in for Tauri's invoke: answers every command from the in-memory showcase workspace. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // A touch of latency so loaders and skeletons are seen, never so much that it drags.
  await new Promise((r) => setTimeout(r, 6 + Math.random() * 14));
  return handle(cmd, args ?? {}) as T;
}

export const convertFileSrc = (path: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/>`)}#${path}`;
