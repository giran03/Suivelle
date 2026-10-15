declare module "d3-force-3d" {
  interface Node { id: string; x: number; y: number; z: number; fx?: number; fy?: number; fz?: number }
  interface Link { source: string; target: string }
  interface Force { strength(value: number): Force; distanceMax(value: number): Force; theta(value: number): Force }
  interface LinkForce { id(fn: (node: Node) => string): LinkForce; distance(value: number): LinkForce; strength(value: number): LinkForce }
  interface Simulation { stop(): Simulation; force(name: string, value: Force | LinkForce): Simulation; alpha(value: number): Simulation; alphaDecay(value: number): Simulation; tick(iterations: number): Simulation }
  export function forceSimulation(nodes: Node[], dimensions: number): Simulation;
  export function forceManyBody(): Force;
  export function forceLink(links: Link[]): LinkForce;
  export function forceX(fn: (node: Node) => number): Force;
  export function forceY(fn: (node: Node) => number): Force;
  export function forceZ(fn: (node: Node) => number): Force;
}
