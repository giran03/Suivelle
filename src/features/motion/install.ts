import { installSlidingPills } from "./pills";

/** Starts the motion behaviours that watch the page instead of being rendered by a component. Returns a stop function. */
export function installMotion(): () => void {
  const stops = [installSlidingPills()];
  return () => stops.forEach((stop) => stop());
}
