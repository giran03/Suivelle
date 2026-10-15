export type OrbitState = "off" | "running" | "paused" | "reduced";
interface Options {
  blocked: () => "off" | "paused" | "reduced" | null;
  tick: (seconds: number) => void;
  stopped: () => void;
  status: (state: OrbitState) => void;
}
/** No animation frames while off or blocked; a single capped loop while orbiting. */
export function createOrbit(options: Options) {
  let timer: ReturnType<typeof setTimeout> | undefined, frame = 0, dead = false;
  let running = false, previous = 0, state: OrbitState | undefined;
  const status = (next: OrbitState) => { if (state !== next) { state = next; options.status(next); } };
  const stop = () => {
    clearTimeout(timer); timer = undefined; cancelAnimationFrame(frame); frame = 0;
    if (running) { running = false; options.stopped(); }
  };
  const next = () => {
    timer = setTimeout(() => {
      timer = undefined;
      frame = requestAnimationFrame(now => {
        frame = 0;
        if (dead) return;
        const blocked = options.blocked();
        if (blocked) { stop(); status(blocked); return; }
        const delta = Math.min(.1, Math.max(0, (now - previous) / 1000)); previous = now;
        options.tick(delta);
        if (!dead && running) next();
      });
    }, 1000 / 30);
  };
  const refresh = () => {
    if (dead) return;
    const blocked = options.blocked();
    if (blocked) { stop(); status(blocked); return; }
    if (running) return;
    running = true; previous = performance.now(); status("running"); next();
  };
  return { refresh, dispose: () => { dead = true; stop(); } };
}
